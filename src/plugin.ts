/**
 * OpenCode V1 adapter.
 *
 * Wire the OpenCode V1 hooks (`PluginInput` + returned hooks object) onto the
 * runtime-agnostic core. The interesting behaviour lives in `core.ts`; this file
 * only translates OpenCode's V1 API shapes (client calls, events, the
 * `{info, parts}` message list) into the host contract and core signals.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { AssistantMessage, Event } from "@opencode-ai/sdk"
import { cutMessages, extractText, findSummaryKeys, shrinkToFit, type AnyMessage } from "./cut.ts"
import { ABORT_MATCH_WINDOW_MS, explainHandoffCancellations } from "./subagent.ts"
import {
  createCore,
  DEFAULT_SUMMARY_PROMPT,
  tokenTotal,
  __resetSharedState,
  type CacheCompactOptions,
  type Host,
  type LogLevel,
} from "./core.ts"

export type { CacheCompactOptions } from "./core.ts"
export { __resetSharedState }

export const createServer = (
  input: PluginInput,
  options: CacheCompactOptions = {},
): Awaited<ReturnType<Plugin>> => {
  const { client } = input
  const debug = options.debug ?? false

  const sendText = (sessionID: string, text: string): Promise<any> =>
    Promise.resolve(
      client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      }),
    )

  const host: Host = {
    log(level: LogLevel, message: string, extra: Record<string, unknown> = {}) {
      try {
        // Also to stderr so it shows up in `docker logs paseo` when debugging —
        // but never when stderr is a terminal, or it corrupts the TUI's input.
        if (debug && !process.stderr.isTTY) {
          process.stderr.write(
            `[cache-compact] ${level} ${message} ${JSON.stringify(extra)}\n`,
          )
        }
        client.app
          ?.log?.({ body: { service: "cache-compact", level, message, extra } })
          ?.catch?.(() => {})
      } catch {
        /* never throw from logging */
      }
    },

    async summarize(sessionID, prompt) {
      const res: any = await sendText(sessionID, prompt)
      const payload = res?.data ?? res
      const info = payload?.info as AssistantMessage | undefined
      const text = extractText(payload?.parts ?? [])
      if (info?.role === "assistant" && info.id) {
        return {
          boundaryUserID: info.parentID,
          summaryAssistantID: info.id,
          text,
        }
      }
      return { text }
    },

    async sendText(sessionID, text) {
      await sendText(sessionID, text)
    },

    async abort(sessionID) {
      await client.session.abort({ path: { id: sessionID } })
    },

    async contextLimit(providerID, modelID) {
      // No list cache here: the core caches resolved limits per model, and a
      // cached list could pin a transient miss. A failed lookup returns 0 and
      // is retried on the next trip.
      const res: any = await client.provider.list()
      const all = res?.data?.all ?? []
      const provider = all.find((p: any) => p?.id === providerID)
      const context = provider?.models?.[modelID]?.limit?.context
      return typeof context === "number" && context > 0 ? context : 0
    },
  }

  const core = createCore(host, options)

  const usedTokens = (info: AssistantMessage): number =>
    tokenTotal(info.tokens)

  const onAssistantMessage = (info: AssistantMessage): void => {
    // OpenCode's own compaction summaries and our summary reply both report the
    // pre-cut token count; never let them re-trip.
    if (info.summary || info.error) return
    // `time.completed` is only set when the *whole turn* ends, but a step's
    // usage lands at `step-finish`, which sets `finish`. Requiring `completed`
    // made the trigger wait for the turn to end — too late for a long agentic
    // turn, which can overflow the context before it ever idles.
    if (!info.finish && !info.time?.completed) return
    core.onAssistantMessage({
      sessionID: info.sessionID,
      id: info.id,
      providerID: info.providerID,
      modelID: info.modelID,
      used: usedTokens(info),
    })
  }

  /**
   * The reliable mid-turn signal: every step emits a `step-finish` part carrying
   * the exact usage. `message.updated` at step level does not always reach
   * plugins, but `message.part.updated` does.
   */
  const onStepFinish = (part: any): void => {
    core.onStep({
      sessionID: part?.sessionID,
      messageID: part?.messageID,
      used: tokenTotal(part?.tokens),
    })
  }

  const handoffCommand = options.handoffCommand ?? "handoff"

  const applyCut = (sessionID: string, messages: AnyMessage[]): void => {
    let keys = core.cutKeys(sessionID)
    if (!keys?.boundaryUserID || !keys.summaryAssistantID) {
      // No in-memory cut: either nothing was summarized yet, or OpenCode was
      // restarted since. The summary exchange is still in the session, so look
      // for it and re-adopt it rather than sending the whole uncut history.
      const found = findSummaryKeys(
        messages,
        core.options.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT,
      )
      if (!found) return
      core.restoreCut(sessionID, found)
      keys = core.cutKeys(sessionID)
      if (!keys?.boundaryUserID || !keys.summaryAssistantID) return
    }
    cutMessages(messages, keys.boundaryUserID, keys.summaryAssistantID)
  }

  /** Last resort: shrink the oldest tool outputs when the request still cannot fit. */
  const fitToContext = async (sessionID: string, messages: AnyMessage[]): Promise<void> => {
    const lastUser = [...messages].reverse().find((m) => m?.info?.role === "user")
    const model = lastUser?.info?.model as { providerID?: string; modelID?: string } | undefined
    if (!model?.providerID || !model.modelID) return
    const limit = await core.limitFor(model.providerID, model.modelID)
    const budget = limit - (options.fitReserveTokens ?? 28_000)
    if (budget <= 0) return
    const result = shrinkToFit(messages, budget)
    if (result.trimmed === 0 && result.after <= budget) return
    host.log(result.after > budget ? "warn" : "info", "trimmed tool outputs to fit the context window", {
      sessionID,
      trimmed: result.trimmed,
      estimatedBefore: result.before,
      estimatedAfter: result.after,
      budget,
    })
  }

  const hooks: Awaited<ReturnType<Plugin>> = {
    config: async (config) => {
      const mutable = config as any
      if (options.disablePrune ?? true) {
        const compaction: any = (mutable.compaction ??= {})
        if (compaction.prune === undefined) compaction.prune = false
      }
      if (handoffCommand) {
        // The command's text is the summary instruction itself, so the exchange it
        // creates is exactly what the cut looks for in the session history.
        const commands: any = (mutable.command ??= {})
        commands[handoffCommand] ??= {
          description: "Summarize the session so the next request starts from the summary",
          template: core.options.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT,
        }
      }
    },

    "command.execute.before": async (hookInput) => {
      if (handoffCommand && hookInput.command === handoffCommand) {
        core.beginManual(hookInput.sessionID)
      }
    },

    event: async ({ event }: { event: Event }) => {
      if (event.type === "message.part.updated") {
        const part = (event.properties as any)?.part
        if (part?.type === "step-finish") onStepFinish(part)
        return
      }
      if (event.type === "message.updated") {
        const info = event.properties.info
        if (info.role === "assistant") onAssistantMessage(info)
        return
      }
      if (event.type === "session.idle") {
        // Fallback: message.updated already fires this, but idle catches the
        // case where the last assistant message never completed.
        if (core.endManual(event.properties.sessionID)) return
        core.onIdle(event.properties.sessionID)
        return
      }
      if (event.type === "session.deleted") {
        const id = (event.properties as any)?.info?.id
        if (id) core.onDeleted(id)
      }
    },

    "chat.params": async (hookInput, output) => {
      // The step-finish part carries no provider/model; capture them here, on
      // every request, so the trip can resolve the model's context limit.
      core.captureModel(
        hookInput.sessionID,
        hookInput.model?.providerID,
        hookInput.model?.id,
      )
      if (!core.isPending(hookInput.sessionID)) return
      const max = output.maxOutputTokens
      const cap = core.options.summaryMaxTokens
      if (typeof max !== "number" || max > cap) {
        output.maxOutputTokens = cap
      }
      if (output.options && typeof output.options === "object") {
        output.options = {
          ...output.options,
          reasoningEffort: (output.options as any).reasoningEffort ?? "low",
        }
      }
    },

    "experimental.chat.messages.transform": async (_hookInput, output) => {
      const messages = output.messages as unknown as AnyMessage[]
      if (!Array.isArray(messages) || messages.length === 0) return
      const sessionID = messages[0]?.info?.sessionID
      if (!sessionID) return
      applyCut(sessionID, messages)
      explainHandoffCancellations(messages, (taskID, failedAt) =>
        core.wasAbortedNear(taskID, failedAt, ABORT_MATCH_WINDOW_MS),
      )
      if (options.fitContext) await fitToContext(sessionID, messages)
    },
  }

  return hooks
}

export const CacheCompact: Plugin = async (input, options) =>
  createServer(input, (options ?? {}) as CacheCompactOptions)

export default CacheCompact
