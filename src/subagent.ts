/**
 * What the parent session sees when a subagent is stopped for a handoff.
 *
 * A trip aborts the subagent's running turn so it can write its summary. The
 * parent's `task` tool reports that abort as the error "Task cancelled", which
 * the parent model cannot tell from the user pressing Esc. The subagent is in
 * fact still working (the plugin resumes it), so the error is rewritten in the
 * outgoing messages to say so.
 */

import type { AnyMessage } from "./cut.ts"

const TASK_CANCELLED = "Task cancelled"

/** How far apart the abort and the task's failure may be and still belong together. */
export const ABORT_MATCH_WINDOW_MS = 10_000

const handoffExplanation = (taskID: string): string =>
  "The subagent reached its context limit and is compacting. It was not stopped, " +
  "and the user did not interrupt it: it is already continuing on its own. " +
  `To wait for its result, call task again with task_id=${taskID} and any short prompt, such as "Continue".`

/**
 * Replace "Task cancelled" on `task` calls that failed because a trip aborted
 * their subagent. `wasAbortedNear(taskID, failedAt)` says whether that was the
 * case. Mutates the outgoing copy only.
 */
export function explainHandoffCancellations(
  messages: AnyMessage[],
  wasAbortedNear: (taskID: string, failedAt: number) => boolean,
): void {
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      if (part.type !== "tool" || part.tool !== "task") continue

      const state: any = part.state
      if (state?.status !== "error" || state.error !== TASK_CANCELLED) continue

      const taskID: unknown = state.metadata?.sessionId
      const failedAt: unknown = state.time?.end
      if (typeof taskID !== "string" || typeof failedAt !== "number") continue

      if (wasAbortedNear(taskID, failedAt)) state.error = handoffExplanation(taskID)
    }
  }
}
