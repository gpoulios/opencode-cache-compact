import assert from "node:assert/strict"
import { test } from "node:test"
import type { AnyMessage } from "../src/cut.ts"
import { explainHandoffCancellations } from "../src/subagent.ts"

const taskCall = (state: Record<string, unknown>, tool = "task"): AnyMessage => ({
  info: { id: "m1", role: "assistant", sessionID: "parent" },
  parts: [{ type: "tool", tool, state }],
})

const cancelled = {
  status: "error",
  error: "Task cancelled",
  metadata: { sessionId: "child" },
  time: { start: 1_000, end: 5_000 },
}

const errorOf = (message: AnyMessage) => (message.parts[0]!.state as { error: string }).error

test("explains a cancellation that a handoff abort caused", () => {
  const messages = [taskCall({ ...cancelled })]

  explainHandoffCancellations(messages, (taskID, failedAt) => taskID === "child" && failedAt === 5_000)

  assert.match(errorOf(messages[0]!), /is compacting\. It was not stopped, and the user did not interrupt it/)
  assert.match(errorOf(messages[0]!), /task_id=child/)
})

test("keeps a cancellation that no handoff caused", () => {
  const messages = [taskCall({ ...cancelled })]

  explainHandoffCancellations(messages, () => false)

  assert.equal(errorOf(messages[0]!), "Task cancelled")
})

test("ignores other tools, other errors and parts without a task id or end time", () => {
  const messages = [
    taskCall({ ...cancelled }, "bash"),
    taskCall({ ...cancelled, error: "Subagent failed" }),
    taskCall({ ...cancelled, metadata: {} }),
    taskCall({ ...cancelled, time: { start: 1_000 } }),
    taskCall({ status: "completed", output: "done" }),
  ]

  explainHandoffCancellations(messages, () => true)

  assert.equal(errorOf(messages[0]!), "Task cancelled")
  assert.equal(errorOf(messages[1]!), "Subagent failed")
  assert.equal(errorOf(messages[2]!), "Task cancelled")
  assert.equal(errorOf(messages[3]!), "Task cancelled")
})
