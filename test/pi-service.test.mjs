import assert from "node:assert/strict";
import test from "node:test";
import { PiService, jobSnapshot } from "../src/pi-service.mjs";

function settledJob() {
  return {
    id: "run-1",
    status: "settled",
    startedAt: "2026-08-01T00:00:00.000Z",
    settledAt: "2026-08-01T00:01:00.000Z",
    kind: "prompt",
    error: null,
    result: { assistant_text: "Compact answer." },
    uiRequests: new Map(),
    toolCalls: [{ tool_call_id: "tool-1", tool_name: "read" }],
    messageUpdates: 42,
    events: [{ type: "tool_execution_start", tool_call_id: "tool-1", tool_name: "read" }]
  };
}

test("job snapshots are compact by default and detailed only on request", () => {
  const job = settledJob();
  const compact = jobSnapshot(job);
  assert.equal(compact.result, undefined);
  assert.equal(compact.recent_events, undefined);
  assert.equal(compact.tool_calls, undefined);
  assert.equal(compact.run_id, "run-1");
  assert.equal(compact.status, "settled");

  const detailed = jobSnapshot(job, { includeDetails: true });
  assert.equal(detailed.result.assistant_text, "Compact answer.");
  assert.equal(detailed.recent_events.length, 1);
  assert.equal(detailed.streamed_message_updates, 42);
  assert.equal(detailed.tool_calls, undefined);
});

test("wait lifts the answer while keeping its run snapshot compact by default", async () => {
  const job = settledJob();
  const session = { job };
  const service = {
    getSession: () => session,
    liveSummary: () => ({ session_id: "session-1" })
  };

  const compact = await PiService.prototype.wait.call(service, {
    session_id: "session-1",
    run_id: "run-1",
    timeout_seconds: 0
  });
  assert.equal(compact.answer, "Compact answer.");
  assert.equal(compact.run.result, undefined);
  assert.equal(compact.run.recent_events, undefined);

  const detailed = await PiService.prototype.wait.call(service, {
    session_id: "session-1",
    run_id: "run-1",
    timeout_seconds: 0,
    include_details: true
  });
  assert.equal(detailed.answer, "Compact answer.");
  assert.equal(detailed.run.result.assistant_text, "Compact answer.");
  assert.equal(detailed.run.recent_events.length, 1);
});

test("task honors requested details without waiting", async () => {
  const job = settledJob();
  const session = { id: "session-1", job };
  const service = {
    startSession: async () => ({ session_id: "session-1" }),
    send: async () => jobSnapshot(job),
    getSession: () => session,
    liveSummary: () => ({ session_id: "session-1" })
  };

  const compact = await PiService.prototype.task.call(service, {
    message: "Inspect the package.",
    wait_seconds: 0
  });
  assert.equal(compact.run.result, undefined);
  assert.equal(compact.run.recent_events, undefined);

  const detailed = await PiService.prototype.task.call(service, {
    message: "Inspect the package.",
    wait_seconds: 0,
    include_details: true
  });
  assert.equal(detailed.run.result.assistant_text, "Compact answer.");
  assert.equal(detailed.run.recent_events.length, 1);
});

test("session listing omits live jobs unless details are requested", async () => {
  const session = { id: "session-1" };
  const calls = [];
  const service = {
    sessions: new Map([["session-1", session]]),
    config: { maxSavedSessions: 100 },
    scanSavedSessions: async () => [],
    liveSummary: (_session, options) => {
      calls.push(options);
      return options ? { session_id: "session-1", job: { run_id: "run-1" } } : { session_id: "session-1" };
    }
  };

  const compact = await PiService.prototype.listSessions.call(service, {});
  assert.equal(compact.live_sessions[0].job, undefined);
  assert.equal(calls[0], false);

  const detailed = await PiService.prototype.listSessions.call(service, { include_details: true });
  assert.equal(detailed.live_sessions[0].job.run_id, "run-1");
  assert.deepEqual(calls[1], { includeDetails: true });
});
