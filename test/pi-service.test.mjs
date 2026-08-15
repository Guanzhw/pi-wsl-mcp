import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROFILES, PiService, actionableRunError, jobSnapshot, liveDirectoryEntry, savedDirectoryEntry, runProgress, runStats, usageFromMessage } from "../src/pi-service.mjs";
import { normalizeWslPath } from "../src/util.mjs";

function activeJob(overrides = {}) {
  return {
    id: "run-1",
    status: "running",
    kind: "prompt",
    modelStatus: "idle",
    cleanupStatus: "pending",
    budget: null,
    startedAt: "2026-08-01T00:00:00.000Z",
    settledAt: null,
    events: [],
    uiRequests: new Map(),
    toolCalls: [],
    lastTool: null,
    messageUpdates: 0,
    result: null,
    error: null,
    stats: {
      modelCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
      cost: 0,
      models: new Map()
    },
    ...overrides
  };
}

function usageEvent(message) {
  return { type: "message_end", message };
}

function settledJob() {
  return {
    id: "run-1",
    status: "settled",
    modelStatus: "stopped",
    cleanupStatus: "completed",
    budget: null,
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
  assert.equal(compact.model_status, "stopped");
  assert.equal(compact.cleanup_status, "completed");
  assert.equal(compact.budget, undefined, "runs without budgets carry no budget fields");
  assert.equal(compact.progress.phase, "settled");
  assert.equal(compact.stats.model_calls, 0);

  const detailed = jobSnapshot(job, { includeDetails: true });
  assert.equal(detailed.result.assistant_text, "Compact answer.");
  assert.equal(detailed.recent_events.length, 1);
  assert.equal(detailed.streamed_message_updates, 42);
  assert.equal(detailed.tool_calls, undefined);
});

test("wait lifts the answer while keeping its run snapshot compact by default", async () => {
  const job = settledJob();
  const session = { id: "session-1", job };
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
  assert.equal(compact.session_id, "session-1");
  assert.equal(compact.run_id, "run-1");
  assert.deepEqual(compact.continuation, {
    pi_wait: { session_id: "session-1", run_id: "run-1" },
    pi_status: { session_id: "session-1" }
  });
  assert.equal(compact.wait, undefined, "an unclamped wait carries no wait metadata");

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

test("wait clamps a requested 300s timeout to the configured margin with transparent metadata", async () => {
  const settleSoon = (job, ms = 30) => {
    setTimeout(() => {
      job.status = "settled";
      job.settledAt = new Date().toISOString();
    }, ms);
  };
  const service = {
    config: { maxWaitSeconds: 285 },
    liveSummary: () => ({ session_id: "session-1", process_status: "running" })
  };
  let currentSession = null;
  service.getSession = () => currentSession;

  const job = activeJob();
  settleSoon(job);
  currentSession = { id: "session-1", job };
  const result = await PiService.prototype.wait.call(service, {
    session_id: "session-1",
    run_id: "run-1",
    timeout_seconds: 300
  });
  assert.equal(result.session_id, "session-1");
  assert.equal(result.run_id, "run-1");
  assert.equal(result.run.status, "settled");
  assert.equal(result.session.process_status, "running");
  assert.deepEqual(result.continuation, {
    pi_wait: { session_id: "session-1", run_id: "run-1" },
    pi_status: { session_id: "session-1" }
  });
  assert.deepEqual(result.wait, {
    requested_seconds: 300,
    effective_seconds: 285,
    clamped: true,
    max_seconds: 285
  });

  const customJob = activeJob();
  settleSoon(customJob);
  currentSession = { id: "session-1", job: customJob };
  const custom = await PiService.prototype.wait.call(service, {
    session_id: "session-1",
    run_id: "run-1",
    timeout_seconds: 290
  });
  assert.equal(custom.wait.effective_seconds, 285, "the configured margin is the cap");

  const freeJob = activeJob();
  settleSoon(freeJob);
  currentSession = { id: "session-1", job: freeJob };
  const free = await PiService.prototype.wait.call(service, {
    session_id: "session-1",
    run_id: "run-1",
    timeout_seconds: 100
  });
  assert.equal(free.wait, undefined, "waits under the cap are never flagged as clamped");
});

test("an expiring wait for a still-active run returns a structured timeout, never throws", async () => {
  const job = activeJob();
  const session = { id: "session-1", job };
  const service = {
    config: { maxWaitSeconds: 1 },
    getSession: () => session,
    liveSummary: () => ({ session_id: "session-1", process_status: "running" })
  };
  const started = Date.now();
  const result = await PiService.prototype.wait.call(service, {
    session_id: "session-1",
    run_id: "run-1",
    timeout_seconds: 1
  });
  assert.ok(Date.now() - started < 5000, "the wait must actually expire quickly");
  assert.equal(result.timed_out, true);
  assert.equal(result.answer, null);
  assert.equal(result.session_id, "session-1");
  assert.equal(result.run_id, "run-1");
  assert.equal(result.run.status, "running");
  assert.equal(result.run.model_status, "idle");
  assert.equal(result.session.process_status, "running");
  assert.deepEqual(result.continuation, {
    pi_wait: { session_id: "session-1", run_id: "run-1" },
    pi_status: { session_id: "session-1" }
  });
});

test("agent_end stops the model while cleanup stays pending until agent_settled completes collection", async () => {
  const job = activeJob({ status: "accepted" });
  const session = {
    id: "session-1",
    job,
    uiRequests: new Map(),
    rpc: { command: async () => ({ data: { text: "final answer" } }) }
  };
  const service = Object.create(PiService.prototype);
  service.config = { commandTimeoutMs: 1000 };
  service.autoCloseIfSettled = () => null;

  service.handleEvent(session, { type: "agent_start" });
  assert.equal(job.status, "running");
  assert.equal(job.modelStatus, "running");
  assert.equal(job.cleanupStatus, "pending");
  assert.equal(runProgress(job).phase, "model_working");

  // Model finishes: agent_end stops the model but is NOT settlement.
  service.handleEvent(session, { type: "agent_end" });
  assert.equal(job.modelStatus, "stopped");
  assert.equal(job.status, "running", "agent_end must not settle the run");
  assert.equal(job.cleanupStatus, "pending", "cleanup stays pending after model stop");
  assert.equal(runProgress(job).phase, "cleanup", "model stopped but run active must read as cleanup");

  // Final settlement: agent_settled starts cleanup/final collection.
  service.handleEvent(session, { type: "agent_settled" });
  assert.equal(job.status, "collecting");
  assert.equal(job.cleanupStatus, "running");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.status, "settled");
  assert.equal(job.cleanupStatus, "completed");
  assert.equal(job.modelStatus, "stopped");
  const snapshot = jobSnapshot(job);
  assert.equal(snapshot.model_status, "stopped");
  assert.equal(snapshot.cleanup_status, "completed");
});

test("terminal runs force is_streaming false while the session process may keep running", () => {
  const session = {
    id: "session-1",
    lifecycle: "running",
    workspace: "/home/user/work",
    profile: { id: "workspace" },
    createdAt: "2026-08-01T00:00:00.000Z",
    state: { isStreaming: true },
    job: settledJob(),
    uiRequests: new Map(),
    rpc: { protocolWarnings: [] }
  };
  const summary = PiService.prototype.liveSummary.call({ config: { resultLimit: 24000 } }, session, false);
  assert.equal(summary.is_streaming, false, "stale Pi streaming state must not outlive a terminal run");
  assert.equal(summary.lifecycle, "running", "the session process may remain running after settlement");
  assert.equal(summary.process_status, "running");
  assert.equal(summary.model_status, "stopped");
  assert.equal(summary.cleanup_status, "completed");

  const streaming = PiService.prototype.liveSummary.call({ config: { resultLimit: 24000 } }, {
    ...session,
    job: activeJob({ status: "running", modelStatus: "running" })
  }, false);
  assert.equal(streaming.is_streaming, true, "an active run keeps Pi's streaming state");
});

test("late non-interactive status notifications never reopen or block a run", async () => {
  const job = settledJob();
  const session = {
    id: "session-1",
    job,
    uiRequests: new Map(),
    rpc: { command: async () => { throw new Error("no new run may start"); } }
  };
  const service = Object.create(PiService.prototype);
  service.config = { commandTimeoutMs: 1000 };
  service.autoCloseIfSettled = () => null;

  service.handleEvent(session, {
    type: "extension_ui_request",
    id: "status-1",
    method: "setStatus",
    statusKey: "branch",
    statusText: "main"
  });
  service.handleEvent(session, { type: "extension_ui_request", id: "note-1", method: "notify", message: "done" });
  assert.equal(job.status, "settled", "status notifications must not reset terminal run state");
  assert.equal(job.modelStatus, "stopped", "status notifications must not restart the model");
  assert.equal(job.cleanupStatus, "completed");
  assert.equal(session.uiRequests.size, 0, "notifications must never become pending UI requests");
  assert.equal(job.uiRequests.size, 0);

  // A retried model pass (agent_start) after settlement must also stay inert.
  service.handleEvent(session, { type: "agent_start" });
  assert.equal(job.status, "settled");
  assert.equal(job.modelStatus, "stopped");
});

test("elapsed budget fires once and requests a single cancel", async () => {
  const job = activeJob({
    status: "running",
    modelStatus: "running",
    startedAt: new Date(Date.now() - 60000).toISOString(),
    budget: { maxElapsedSeconds: 30, maxModelCalls: null, maxCost: null, exceeded: null, cancelRequested: false }
  });
  const aborts = [];
  const session = {
    id: "session-1",
    job,
    uiRequests: new Map(),
    rpc: { command: async (command) => { aborts.push(command); return { success: true }; } }
  };
  const service = Object.create(PiService.prototype);
  service.config = { commandTimeoutMs: 1000 };
  service.autoCloseIfSettled = () => null;

  service.handleEvent(session, { type: "tool_execution_start", toolCallId: "t1", toolName: "read" });
  service.handleEvent(session, { type: "tool_execution_start", toolCallId: "t2", toolName: "grep" });
  assert.equal(aborts.length, 1, "the exceeded budget must cancel exactly once");
  assert.equal(job.budget.exceeded, "elapsed");
  assert.equal(job.budget.cancelRequested, true);
  assert.equal(job.status, "cancelling");
  assert.ok(job.events.some((event) => event.type === "budget_exceeded" && event.limit === "elapsed"));
  service.handleEvent(session, { type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } } } });
  assert.equal(aborts.length, 1, "later events must not re-request cancellation");
});

test("elapsed budget fires without an event stream or active waiter", async () => {
  const commands = [];
  const session = {
    id: "session-silent",
    lifecycle: "running",
    job: null,
    autoCloseJobId: null,
    pendingClose: null,
    uiRequests: new Map(),
    rpc: {
      command: async (command) => {
        commands.push(command);
        return { success: true };
      }
    }
  };
  const service = {
    getSession: () => session,
    liveSummary: () => ({ session_id: session.id, process_status: session.lifecycle })
  };

  await PiService.prototype.send.call(service, {
    session_id: session.id,
    message: "work silently",
    behavior: "prompt",
    max_elapsed_seconds: 0.02
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(commands.filter((command) => command.type === "prompt").length, 1);
  assert.equal(commands.filter((command) => command.type === "abort").length, 1);
  assert.equal(session.job.status, "cancelling");
  assert.equal(session.job.budget.exceeded, "elapsed");
});

test("model-call budget fires once and cost budget fires once", async () => {
  const makeService = (job) => {
    const aborts = [];
    const session = {
      id: "session-1",
      job,
      uiRequests: new Map(),
      rpc: { command: async (command) => { aborts.push(command); return { success: true }; } }
    };
    const service = Object.create(PiService.prototype);
    service.config = { commandTimeoutMs: 1000 };
    service.autoCloseIfSettled = () => null;
    return { service, session, aborts };
  };
  const usage = { role: "assistant", provider: "deepseek", model: "m", usage: { input: 2, output: 2, totalTokens: 4, cost: { total: 0.01 } } };

  const calls = makeService(activeJob({
    status: "running",
    modelStatus: "running",
    budget: { maxElapsedSeconds: null, maxModelCalls: 2, maxCost: null, exceeded: null, cancelRequested: false }
  }));
  calls.service.handleEvent(calls.session, { type: "message_end", message: usage });
  calls.service.handleEvent(calls.session, { type: "message_end", message: usage });
  assert.equal(calls.aborts.length, 1);
  assert.equal(calls.session.job.budget.exceeded, "model_calls");
  calls.service.handleEvent(calls.session, { type: "message_end", message: usage });
  assert.equal(calls.aborts.length, 1, "model_calls limit must not re-cancel");

  const cost = makeService(activeJob({
    status: "running",
    modelStatus: "running",
    budget: { maxElapsedSeconds: null, maxModelCalls: null, maxCost: 0.015, exceeded: null, cancelRequested: false }
  }));
  cost.service.handleEvent(cost.session, { type: "message_end", message: usage });
  assert.equal(cost.aborts.length, 0, "cost is below the limit after one message");
  cost.service.handleEvent(cost.session, { type: "message_end", message: usage });
  assert.equal(cost.aborts.length, 1);
  assert.equal(cost.session.job.budget.exceeded, "cost");
  assert.equal(cost.session.job.status, "cancelling");
});

test("budget-less runs are unchanged and never cancel", async () => {
  const job = activeJob({ status: "running", modelStatus: "running" });
  const aborts = [];
  const session = {
    id: "session-1",
    job,
    uiRequests: new Map(),
    rpc: { command: async (command) => { aborts.push(command); return { success: true }; } }
  };
  const service = Object.create(PiService.prototype);
  service.handleEvent(session, { type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } } } });
  assert.equal(aborts.length, 0);
  assert.equal(job.status, "running");
  const snapshot = jobSnapshot(job);
  assert.equal(snapshot.budget, undefined);
  assert.equal(snapshot.budget_exceeded, undefined);
});

test("job snapshots expose optional budgets and the fired limit", async () => {
  const job = activeJob({
    status: "cancelling",
    budget: { maxElapsedSeconds: 60, maxModelCalls: 5, maxCost: null, exceeded: "model_calls", cancelRequested: true }
  });
  const snapshot = jobSnapshot(job);
  assert.deepEqual(snapshot.budget, { max_elapsed_seconds: 60, max_model_calls: 5, max_cost: null });
  assert.equal(snapshot.budget_exceeded, "model_calls");
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

test("live directory entries are minimal and expose active_run only when a job exists", () => {
  const busy = {
    id: "session-1",
    lifecycle: "running",
    workspace: "/home/user/pi-wsl-mcp",
    profile: { id: "review" },
    createdAt: "2026-08-01T00:00:00.000Z",
    state: { sessionId: "pi-1", sessionName: "Review pass" },
    job: { id: "run-1", status: "running" },
    uiRequests: new Map([["confirm-1", {}], ["input-2", {}]])
  };
  const entry = liveDirectoryEntry(busy);
  assert.deepEqual(entry, {
    session_id: "session-1",
    lifecycle: "running",
    process_status: "running",
    workspace: "/home/user/pi-wsl-mcp",
    profile: "review",
    created_at: "2026-08-01T00:00:00.000Z",
    pi_session_id: "pi-1",
    pi_session_name: "Review pass",
    active_run: { run_id: "run-1", status: "running" },
    pending_ui_request_count: 2
  });
  assert.equal(entry.job, undefined);
  assert.equal(entry.pi_session_file, undefined);
  assert.equal(entry.model, undefined);
  assert.equal(entry.thinking_level, undefined);
  assert.equal(entry.is_streaming, undefined);
  assert.equal(entry.protocol_warnings, undefined);
  assert.equal(entry.pending_ui_requests, undefined);

  const idle = liveDirectoryEntry({
    id: "session-2",
    lifecycle: "starting",
    workspace: "/home/user/work",
    profile: { id: "workspace" },
    createdAt: "2026-08-01T00:00:00.000Z",
    state: null,
    job: null,
    uiRequests: new Map()
  });
  assert.equal(idle.active_run, null);
  assert.equal(idle.pending_ui_request_count, 0);
  assert.equal(idle.pi_session_id, null);
  assert.equal(idle.pi_session_name, null);

  const settled = liveDirectoryEntry({ ...busy, job: { id: "run-2", status: "settled" } });
  assert.equal(settled.active_run, null);
});

test("saved directory entries hide the session file, expose identity, and bytes only with details", () => {
  const saved = {
    pi_session_id: "pi-9",
    workspace: "/home/user/work",
    created_at: "2026-07-01T00:00:00.000Z",
    modified_at: "2026-07-02T00:00:00.000Z",
    bytes: 1234,
    session_file: "/home/user/.pi/agent/sessions/pi-9.jsonl",
    name: "Review pass",
    summary: "Check the unstaged diff"
  };
  assert.deepEqual(savedDirectoryEntry(saved), {
    pi_session_id: "pi-9",
    workspace: "/home/user/work",
    created_at: "2026-07-01T00:00:00.000Z",
    modified_at: "2026-07-02T00:00:00.000Z",
    name: "Review pass",
    summary: "Check the unstaged diff"
  });
  assert.deepEqual(savedDirectoryEntry(saved, true), {
    pi_session_id: "pi-9",
    workspace: "/home/user/work",
    created_at: "2026-07-01T00:00:00.000Z",
    modified_at: "2026-07-02T00:00:00.000Z",
    name: "Review pass",
    summary: "Check the unstaged diff",
    bytes: 1234
  });
  assert.equal(savedDirectoryEntry(saved, true).session_file, undefined);
  assert.equal(savedDirectoryEntry({ ...saved, bytes: undefined }, true).bytes, undefined);
  // Sessions without derivable identity surface explicit nulls, never secrets.
  assert.deepEqual(savedDirectoryEntry({ ...saved, name: undefined, summary: undefined }), {
    pi_session_id: "pi-9",
    workspace: "/home/user/work",
    created_at: "2026-07-01T00:00:00.000Z",
    modified_at: "2026-07-02T00:00:00.000Z",
    name: null,
    summary: null
  });
});

test("session listing is a minimal directory unless details are requested", async () => {
  const session = {
    id: "session-1",
    lifecycle: "running",
    workspace: "/home/user/pi-wsl-mcp",
    profile: { id: "review" },
    createdAt: "2026-08-01T00:00:00.000Z",
    state: { sessionId: "pi-1", sessionName: "Review pass" },
    job: { id: "run-1", status: "running" },
    uiRequests: new Map([["confirm-1", {}]])
  };
  const calls = [];
  const service = {
    sessions: new Map([["session-1", session]]),
    config: { maxSavedSessions: 100 },
    scanSavedSessions: async (_workspace, _pageSize, offset) => {
      calls.push({ offset });
      return {
        entries: [{
          pi_session_id: "pi-9",
          workspace: "/home/user/work",
          created_at: "2026-07-01T00:00:00.000Z",
          modified_at: "2026-07-02T00:00:00.000Z",
          bytes: 1234,
          name: "Review pass",
          summary: "Check the unstaged diff"
        }],
        next_offset: null
      };
    },
    liveSummary: (_session, options) => {
      calls.push(options);
      return options ? { session_id: "session-1", job: { run_id: "run-1" } } : { session_id: "session-1" };
    }
  };

  const compact = await PiService.prototype.listSessions.call(service, {});
  assert.deepEqual(compact.live_sessions[0], {
    session_id: "session-1",
    lifecycle: "running",
    process_status: "running",
    workspace: "/home/user/pi-wsl-mcp",
    profile: "review",
    created_at: "2026-08-01T00:00:00.000Z",
    pi_session_id: "pi-1",
    pi_session_name: "Review pass",
    active_run: { run_id: "run-1", status: "running" },
    pending_ui_request_count: 1
  });
  assert.equal(compact.live_sessions[0].job, undefined);
  assert.equal(compact.live_sessions[0].pi_session_file, undefined);
  assert.equal(compact.live_sessions[0].pending_ui_requests, undefined);
  assert.equal(compact.next_saved_cursor, null, "the final page reports no continuation cursor");
  assert.deepEqual(compact.saved_sessions[0], {
    pi_session_id: "pi-9",
    workspace: "/home/user/work",
    created_at: "2026-07-01T00:00:00.000Z",
    modified_at: "2026-07-02T00:00:00.000Z",
    name: "Review pass",
    summary: "Check the unstaged diff"
  });
  assert.equal(compact.saved_sessions[0].bytes, undefined);
  assert.equal(compact.saved_sessions[0].session_file, undefined);
  assert.equal(calls.length, 1, "compact listing must not consult liveSummary");
  assert.equal(calls[0].offset, 0, "a first page starts at cursor position zero");

  const detailed = await PiService.prototype.listSessions.call(service, { include_details: true });
  assert.equal(detailed.live_sessions[0].job.run_id, "run-1");
  assert.deepEqual(calls[1], { offset: 0 }, "the detailed listing still starts at the first page");
  assert.deepEqual(calls[2], { includeDetails: true });
  assert.equal(detailed.saved_sessions[0].bytes, 1234);
  assert.equal(detailed.saved_sessions[0].session_file, undefined);
  assert.equal(detailed.next_saved_cursor, null);

  // A returned cursor is passed through as the scan offset; the mock records
  // only the offset, so the cursor's encoded scope fields are validated by
  // decodeSavedCursor before the scan runs.
  const continued = await PiService.prototype.listSessions.call(service, {
    saved_cursor: Buffer.from(JSON.stringify({ v: 2, o: 7, w: null, p: 100 })).toString("base64url")
  });
  assert.deepEqual(calls[3], { offset: 7 }, "saved_cursor must advance the saved-session scan");
  assert.equal(continued.next_saved_cursor, null);
});

function sessionJsonl(lines) {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function userMessage(text) {
  return {
    type: "message",
    id: "entry-user",
    parentId: "parent",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }], timestamp: "2026-07-01T00:00:01.000Z" }
  };
}

function sessionHeader(id, cwd, extra = {}) {
  return { type: "session", id, cwd, timestamp: "2026-07-01T00:00:00.000Z", version: 1, ...extra };
}

test("scanSavedSessions derives bounded redacted identity from real session files", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-scan-ident-"));
  try {
    // Defensive future shape: a name on the session header wins, preview follows.
    await fs.writeFile(path.join(tmp, "a.jsonl"), sessionJsonl([
      sessionHeader("pi-a", tmp, { name: "Fix auth bug" }),
      userMessage("Review the diff of the auth module")
    ]));
    // Unnamed session: preview comes from the first user message, whitespace
    // is collapsed, and later assistant output never leaks into it.
    await fs.writeFile(path.join(tmp, "b.jsonl"), sessionJsonl([
      sessionHeader("pi-b", tmp),
      userMessage("  Implement   the focused   improvements.\n\nSecond line"),
      { type: "message", id: "e2", parentId: "p", timestamp: "2026-07-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "CONFIDENTIAL assistant output" }], timestamp: "2026-07-01T00:00:02.000Z" } }
    ]));
    // Secrets inside the user message are redacted before surfacing.
    await fs.writeFile(path.join(tmp, "c.jsonl"), sessionJsonl([
      sessionHeader("pi-c", tmp),
      userMessage("Use api_key=abc123secret to call the API and tell me everything")
    ]));
    // Corrupt file: skipped entirely.
    await fs.writeFile(path.join(tmp, "d.jsonl"), "this is not a session jsonl\n");
    // Concurrently-written/truncated trailing line: tolerated, identity kept.
    await fs.writeFile(path.join(tmp, "e.jsonl"), sessionJsonl([
      sessionHeader("pi-e", tmp),
      userMessage("First real task")
    ]) + "{\"type\":\"message\",\"id\":\"e2\",\"pa");
    // Preview is capped at 160 chars plus an ellipsis.
    await fs.writeFile(path.join(tmp, "g.jsonl"), sessionJsonl([
      sessionHeader("pi-g", tmp),
      userMessage("word ".repeat(100))
    ]));
    // User message beyond the bounded prefix: name kept, summary null.
    await fs.writeFile(path.join(tmp, "f.jsonl"), sessionJsonl([
      sessionHeader("pi-f", tmp, { name: "Big session" }),
      { type: "message", id: "e1", parentId: "p", timestamp: "2026-07-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(400000) }], timestamp: "2026-07-01T00:00:01.000Z" } },
      userMessage("way beyond the bounded prefix")
    ]));
    // Real Pi shape: the name lives in a session_info entry before the first
    // user message; multiline names collapse to one line.
    await fs.writeFile(path.join(tmp, "h.jsonl"), sessionJsonl([
      sessionHeader("pi-h", tmp),
      { type: "custom_message", id: "primer-h", customType: "primer", content: "ignored setup", display: false },
      { type: "session_info", id: "info-h", name: "Auth\nrefactor  plan" },
      userMessage("Review the auth changes")
    ]));
    // Real Pi shape: session_info AFTER the first user message still yields
    // the name — the scan must not stop at the first user message.
    await fs.writeFile(path.join(tmp, "i.jsonl"), sessionJsonl([
      sessionHeader("pi-i", tmp),
      userMessage("First task here"),
      { type: "session_info", id: "info-i", name: "Late named task" }
    ]));
    // Multiple names within the prefix: the latest valid one wins.
    await fs.writeFile(path.join(tmp, "j.jsonl"), sessionJsonl([
      sessionHeader("pi-j", tmp),
      { type: "session_info", id: "info-j1", name: "Early name" },
      userMessage("Second task"),
      { type: "session_info", id: "info-j2", name: "Late name" }
    ]));
    // Defensive shape: name nested under data.
    await fs.writeFile(path.join(tmp, "k.jsonl"), sessionJsonl([
      sessionHeader("pi-k", tmp),
      { type: "session_info", id: "info-k", data: { name: "Nested name" } },
      userMessage("Task k")
    ]));
    // Names are redacted and capped exactly like summaries.
    await fs.writeFile(path.join(tmp, "l.jsonl"), sessionJsonl([
      sessionHeader("pi-l", tmp),
      { type: "session_info", id: "info-l", name: "Deploy with token=abc123secret " + "x".repeat(200) },
      userMessage("Task l")
    ]));
    // Emoji exactly at the 160-code-point boundary: kept whole, no ellipsis.
    await fs.writeFile(path.join(tmp, "m.jsonl"), sessionJsonl([
      sessionHeader("pi-m", tmp),
      userMessage("x".repeat(159) + "😀")
    ]));
    // Emoji straddling the truncation boundary: the pair is never split.
    await fs.writeFile(path.join(tmp, "n.jsonl"), sessionJsonl([
      sessionHeader("pi-n", tmp),
      userMessage("x".repeat(160) + "😀")
    ]));
    // A valid-looking header after a corrupt first line must not be listed,
    // because pi_resume_session also requires the real header on line one.
    await fs.writeFile(path.join(tmp, "o.jsonl"), "corrupt prefix\n" + sessionJsonl([
      sessionHeader("pi-o", tmp),
      userMessage("must not be listed")
    ]));

    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 }
    });
    const { entries: result, next_offset } = await service.scanSavedSessions(null, 100);
    const byId = Object.fromEntries(result.map((entry) => [entry.pi_session_id, entry]));
    assert.equal(result.length, 13, "only the corrupt file must be skipped");
    assert.equal(byId["pi-a"].name, "Fix auth bug");
    assert.equal(byId["pi-a"].summary, "Review the diff of the auth module");
    assert.equal(byId["pi-b"].name, null);
    assert.equal(byId["pi-b"].summary, "Implement the focused improvements. Second line");
    assert.ok(!byId["pi-b"].summary.includes("CONFIDENTIAL"), "assistant output must never leak into the preview");
    assert.equal(byId["pi-c"].summary, "Use api_key=[redacted] to call the API and tell me everything");
    assert.ok(!byId["pi-c"].summary.includes("abc123secret"), "secrets must be redacted from the preview");
    assert.equal(byId["pi-e"].summary, "First real task", "a truncated trailing line must not hide earlier identity");
    assert.equal(byId["pi-g"].summary.length, 161, "the preview must be capped at 160 chars plus ellipsis");
    assert.ok(byId["pi-g"].summary.endsWith("…"));
    assert.equal(byId["pi-f"].name, "Big session");
    assert.equal(byId["pi-f"].summary, null, "no user message within the bounded prefix means no summary");
    assert.equal(byId["pi-h"].name, "Auth refactor plan", "real session_info names are read and collapsed to one line");
    assert.equal(byId["pi-h"].summary, "Review the auth changes");
    assert.equal(byId["pi-i"].name, "Late named task", "a session_info after the first user message must still be found");
    assert.equal(byId["pi-i"].summary, "First task here");
    assert.equal(byId["pi-j"].name, "Late name", "the latest valid name within the prefix wins");
    assert.equal(byId["pi-k"].name, "Nested name", "defensive data.name shapes are honored");
    assert.ok(byId["pi-l"].name.startsWith("Deploy with token=[redacted] "), "name secrets must be redacted");
    assert.ok(!byId["pi-l"].name.includes("abc123secret"), "name secrets must never surface");
    assert.equal(Array.from(byId["pi-l"].name).length, 161, "names are capped at 160 code points plus ellipsis");
    assert.ok(byId["pi-l"].name.endsWith("…"));
    assert.equal(byId["pi-m"].summary, "x".repeat(159) + "😀", "an emoji at exactly 160 code points stays whole");
    assert.equal(Array.from(byId["pi-m"].summary).length, 160);
    assert.equal(byId["pi-n"].summary, "x".repeat(160) + "…", "truncation never splits a surrogate pair");
    assert.ok(!/[\uD800-\uDFFF]/.test(byId["pi-n"].summary), "no lone surrogate halves may remain after truncation");
    assert.equal(byId["pi-o"], undefined, "a later header must not make a corrupt file listable but unresumable");
    assert.equal(next_offset, null, "all matching sessions fit on one page");
    for (const entry of result) {
      assert.equal(entry.session_file, undefined, "the scanner must not expose file paths");
      assert.ok(entry.bytes > 0);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("scanSavedSessions filters by recorded workspace and pages through the rest", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-scan-limit-"));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-scan-other-"));
  try {
    await fs.writeFile(path.join(tmp, "in.jsonl"), sessionJsonl([sessionHeader("pi-in", tmp), userMessage("task in workspace")]));
    await fs.mkdir(path.join(tmp, "sub"));
    // The second session lives under the session root too, recorded in a
    // different (outside-root) workspace.
    await fs.writeFile(path.join(tmp, "sub", "out.jsonl"), sessionJsonl([sessionHeader("pi-out", other), userMessage("task outside")]));
    // Deterministic newest-first order: pi-out is newer than pi-in.
    const now = Date.now() / 1000;
    await fs.utimes(path.join(tmp, "in.jsonl"), now - 20, now - 20);
    await fs.utimes(path.join(tmp, "sub", "out.jsonl"), now - 10, now - 10);
    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 }
    });

    const filtered = await service.scanSavedSessions(normalizeWslPath(tmp), 100);
    assert.deepEqual(filtered.entries.map((entry) => entry.pi_session_id), ["pi-in"]);
    assert.equal(filtered.next_offset, null);

    const page1 = await service.scanSavedSessions(null, 1);
    assert.deepEqual(page1.entries.map((entry) => entry.pi_session_id), ["pi-out"], "saved sessions are newest first");
    assert.equal(page1.next_offset, 1, "more valid sessions remain after the first page");

    const page2 = await service.scanSavedSessions(null, 1, page1.next_offset);
    assert.deepEqual(page2.entries.map((entry) => entry.pi_session_id), ["pi-in"]);
    assert.equal(page2.next_offset, null, "the final page reports no continuation");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
});

test("scanSavedSessions lists sessions recorded outside allowed roots or in missing workspaces", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-scan-outside-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-scan-outside-ws-"));
  const missing = path.join(tmp, "does-not-exist");
  try {
    await fs.writeFile(path.join(tmp, "out.jsonl"), sessionJsonl([sessionHeader("pi-outside", outside), userMessage("task outside roots")]));
    await fs.writeFile(path.join(tmp, "mis.jsonl"), sessionJsonl([sessionHeader("pi-missing", missing), userMessage("task in a vanished workspace")]));
    await fs.writeFile(path.join(tmp, "in.jsonl"), sessionJsonl([sessionHeader("pi-inside", tmp), userMessage("task inside")]));
    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 }
    });

    const { entries, next_offset } = await service.scanSavedSessions(null, 100);
    const byId = Object.fromEntries(entries.map((entry) => [entry.pi_session_id, entry]));
    assert.equal(entries.length, 3, "outside-root and missing-workspace sessions must still be listed");
    assert.equal(byId["pi-outside"].workspace, normalizeWslPath(outside), "the recorded workspace is normalized and returned even outside allowed roots");
    assert.equal(byId["pi-missing"].workspace, normalizeWslPath(missing), "a vanished workspace is still reported from the header");
    assert.equal(byId["pi-inside"].workspace, normalizeWslPath(tmp));
    assert.equal(next_offset, null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("listSessions applies the workspace filter as pure metadata without allowed-root resolution", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-filter-meta-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-filter-out-"));
  const missing = path.join(tmp, "does-not-exist");
  try {
    await fs.writeFile(path.join(tmp, "out.jsonl"), sessionJsonl([sessionHeader("pi-out", outside), userMessage("task outside")]));
    await fs.writeFile(path.join(tmp, "mis.jsonl"), sessionJsonl([sessionHeader("pi-missing", missing), userMessage("task in a vanished workspace")]));
    await fs.writeFile(path.join(tmp, "win.jsonl"), sessionJsonl([sessionHeader("pi-win", "/mnt/d/WorkSpace/pi-local-mcp"), userMessage("task in a windows drive workspace")]));
    const liveOut = {
      id: "session-live-out", lifecycle: "running", workspace: outside,
      profile: { id: "workspace" }, createdAt: "2026-08-01T00:00:00.000Z",
      state: {}, job: null, uiRequests: new Map()
    };
    const liveIn = {
      id: "session-live-in", lifecycle: "running", workspace: tmp,
      profile: { id: "workspace" }, createdAt: "2026-08-01T00:00:00.000Z",
      state: {}, job: null, uiRequests: new Map()
    };
    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 },
      sessions: new Map([["session-live-out", liveOut], ["session-live-in", liveIn]]),
      // Any allowed-root resolution would throw: the metadata workspace filter
      // must never consult configured roots or check that the path exists.
      resolveWorkspace: async () => { throw new Error("allowed-root resolution must not run for a metadata workspace filter"); }
    });

    const outsideResult = await service.listSessions({ workspace: outside });
    assert.deepEqual(outsideResult.saved_sessions.map((entry) => entry.pi_session_id), ["pi-out"]);
    assert.deepEqual(outsideResult.live_sessions.map((entry) => entry.session_id), ["session-live-out"], "live sessions are filtered by the same metadata workspace");

    const missingResult = await service.listSessions({ workspace: missing });
    assert.deepEqual(missingResult.saved_sessions.map((entry) => entry.pi_session_id), ["pi-missing"], "a nonexistent workspace still filters by recorded metadata");
    assert.deepEqual(missingResult.live_sessions, []);

    const windowsResult = await service.listSessions({ workspace: "D:\\WorkSpace\\pi-local-mcp" });
    assert.deepEqual(windowsResult.saved_sessions.map((entry) => entry.pi_session_id), ["pi-win"], "Windows drive paths match the recorded WSL form");

    const noneResult = await service.listSessions({ workspace: "/mnt/z/nowhere/project" });
    assert.deepEqual(noneResult.saved_sessions, []);
    assert.deepEqual(noneResult.live_sessions, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("saved-session pagination reaches every valid session in stable newest-first order", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-paginate-"));
  const base = Date.now() / 1000;
  try {
    for (let index = 0; index < 25; index += 1) {
      const name = String(index).padStart(2, "0");
      await fs.writeFile(path.join(tmp, "s" + name + ".jsonl"), sessionJsonl([sessionHeader("pi-" + name, tmp), userMessage("task " + index)]));
      await fs.utimes(path.join(tmp, "s" + name + ".jsonl"), base - index * 10, base - index * 10);
    }
    // Corrupt files and a valid-looking header on line two: never listed and
    // never consuming page slots or cursor positions.
    await fs.writeFile(path.join(tmp, "corrupt-a.jsonl"), "garbage\n");
    await fs.writeFile(path.join(tmp, "corrupt-b.jsonl"), "not json at all\n");
    await fs.writeFile(path.join(tmp, "corrupt-c.jsonl"), "corrupt prefix\n" + sessionJsonl([sessionHeader("pi-hidden", tmp), userMessage("must not be listed")]));

    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 },
      sessions: new Map()
    });

    const collect = async () => {
      const ids = [];
      let cursor = null;
      let pages = 0;
      do {
        const result = await service.listSessions({ limit: 10, saved_cursor: cursor ?? undefined });
        assert.ok(result.saved_sessions.length <= 10, "pages must stay below the bounded array limit");
        ids.push(...result.saved_sessions.map((entry) => entry.pi_session_id));
        cursor = result.next_saved_cursor;
        pages += 1;
        assert.ok(pages <= 10, "pagination must terminate");
      } while (cursor !== null);
      return { ids, pages };
    };

    const expected = Array.from({ length: 25 }, (_, index) => "pi-" + String(index).padStart(2, "0"));
    const first = await collect();
    assert.equal(first.pages, 3, "25 sessions page as 10/10/5");
    assert.deepEqual(first.ids, expected, "every valid session is reached exactly once, newest first");
    assert.ok(!first.ids.includes("pi-hidden"), "corrupt files are never listed");
    const second = await collect();
    assert.deepEqual(second.ids, expected, "repeated pagination is stable");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("an invalid saved_cursor is rejected with an actionable error", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-cursor-"));
  try {
    await fs.writeFile(path.join(tmp, "a.jsonl"), sessionJsonl([sessionHeader("pi-a", tmp), userMessage("task")]));
    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 },
      sessions: new Map()
    });
    const cursorOf = (payload) => Buffer.from(JSON.stringify(payload)).toString("base64url");
    // Not a cursor at all, a wrong version, a negative or non-integer offset,
    // a missing/invalid workspace field, and a page size outside the valid
    // range are all rejected: validation checks accepted shape/scope, not
    // authenticity (base64url is only a transport encoding).
    await assert.rejects(
      service.listSessions({ saved_cursor: "not-a-cursor" }),
      (error) => error.code === "invalid_saved_cursor" && /returned by pi_sessions/.test(error.message)
    );
    for (const payload of [
      { v: 99, o: 0, w: null, p: 100 },
      { v: 2, o: -1, w: null, p: 100 },
      { v: 2, o: 1.5, w: null, p: 100 },
      { v: 2, o: Number.MAX_SAFE_INTEGER + 1, w: null, p: 100 },
      { v: 2, o: 0, w: 42, p: 100 },
      { v: 2, o: 0, w: "relative/project", p: 100 },
      { v: 2, o: 0, w: "/" + "x".repeat(4001), p: 100 },
      { v: 2, o: 0, p: 100 },
      { v: 2, o: 0, w: null },
      { v: 2, o: 0, w: null, p: 0 },
      { v: 2, o: 0, w: null, p: 500 }
    ]) {
      await assert.rejects(
        service.listSessions({ saved_cursor: cursorOf(payload) }),
        (error) => error.code === "invalid_saved_cursor",
        "payload must be rejected: " + JSON.stringify(payload)
      );
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("cursor-only continuation preserves the workspace filter and page size; conflicting arguments are rejected", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-cursor-scope-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-cursor-scope-out-"));
  const base = Date.now() / 1000;
  try {
    // Three sessions recorded in the outside-root workspace (newest first:
    // out-00, out-01, out-02) and one session in the allowed workspace.
    for (let index = 0; index < 3; index += 1) {
      const name = String(index).padStart(2, "0");
      const file = path.join(tmp, "out-" + name + ".jsonl");
      await fs.writeFile(file, sessionJsonl([sessionHeader("pi-out-" + name, outside), userMessage("outside task " + index)]));
      await fs.utimes(file, base - index * 10, base - index * 10);
    }
    const insideFile = path.join(tmp, "in.jsonl");
    await fs.writeFile(insideFile, sessionJsonl([sessionHeader("pi-in", tmp), userMessage("inside task")]));
    await fs.utimes(insideFile, base - 5, base - 5);
    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 },
      sessions: new Map()
    });

    const page1 = await service.listSessions({ workspace: outside, limit: 2 });
    assert.deepEqual(page1.saved_sessions.map((entry) => entry.pi_session_id), ["pi-out-00", "pi-out-01"]);
    assert.ok(page1.next_saved_cursor, "a page with more sessions carries a continuation cursor");

    // Cursor-only continuation: no workspace and no limit are repeated, yet
    // the outside-root filter and the original page size are preserved.
    const page2 = await service.listSessions({ saved_cursor: page1.next_saved_cursor });
    assert.deepEqual(
      page2.saved_sessions.map((entry) => entry.pi_session_id),
      ["pi-out-02"],
      "cursor-only continuation must keep the workspace-outside-roots filter"
    );
    assert.equal(page2.next_saved_cursor, null, "the final page reports no continuation");
    assert.ok(!page2.saved_sessions.some((entry) => entry.pi_session_id === "pi-in"), "no inside-workspace session may leak in");

    // Supplying workspace/limit that normalize to the cursor's own scope is
    // allowed and reproduces the same page.
    const sameScope = await service.listSessions({ saved_cursor: page1.next_saved_cursor, workspace: outside, limit: 2 });
    assert.deepEqual(sameScope.saved_sessions.map((entry) => entry.pi_session_id), ["pi-out-02"]);

    // Conflicting workspace or limit is rejected with an actionable message.
    await assert.rejects(
      service.listSessions({ saved_cursor: page1.next_saved_cursor, workspace: tmp }),
      (error) => error.code === "invalid_saved_cursor" && /start a new listing/i.test(error.message)
    );
    await assert.rejects(
      service.listSessions({ saved_cursor: page1.next_saved_cursor, limit: 5 }),
      (error) => error.code === "invalid_saved_cursor" && /start a new listing/i.test(error.message)
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("a maximum-length workspace filter produces a cursor that can round-trip", async () => {
  const longWorkspace = "/" + "路".repeat(3999);
  const calls = [];
  const service = Object.assign(Object.create(PiService.prototype), {
    config: { maxSavedSessions: 100 },
    sessions: new Map(),
    scanSavedSessions: async (workspace, pageSize, offset) => {
      calls.push({ workspace, pageSize, offset });
      return { entries: [], next_offset: offset === 0 ? pageSize : null };
    }
  });

  const first = await service.listSessions({ workspace: longWorkspace, limit: 2 });
  assert.ok(first.next_saved_cursor.length > 400, "the regression cursor must exceed the old schema bound");
  assert.ok(first.next_saved_cursor.length < 24000, "the cursor fits the MCP schema bound");
  const second = await service.listSessions({ saved_cursor: first.next_saved_cursor });
  assert.equal(second.next_saved_cursor, null);
  assert.deepEqual(calls, [
    { workspace: longWorkspace, pageSize: 2, offset: 0 },
    { workspace: longWorkspace, pageSize: 2, offset: 2 }
  ]);
});

test("saved-session scan reads only first-line headers for off-page candidates and the next-page probe", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-scan-phases-"));
  const base = Date.now() / 1000;
  try {
    // 30 valid sessions, newest first by construction (position k is s{k}).
    for (let index = 0; index < 30; index += 1) {
      const name = String(index).padStart(2, "0");
      const file = path.join(tmp, "s" + name + ".jsonl");
      await fs.writeFile(file, sessionJsonl([sessionHeader("pi-" + name, tmp), userMessage("task " + index)]));
      await fs.utimes(file, base - index * 10, base - index * 10);
    }
    // Corrupt files sort last (oldest mtimes): they never reach the early
    // exit, so the read counts below stay deterministic.
    await fs.writeFile(path.join(tmp, "corrupt-a.jsonl"), "garbage\n");
    await fs.writeFile(path.join(tmp, "corrupt-b.jsonl"), "not json\n");
    await fs.utimes(path.join(tmp, "corrupt-a.jsonl"), base - 1000, base - 1000);
    await fs.utimes(path.join(tmp, "corrupt-b.jsonl"), base - 1000, base - 1000);

    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 },
      sessions: new Map()
    });
    const headerReads = [];
    const identityReads = [];
    service.readSavedHeader = async (file) => {
      headerReads.push(file);
      return PiService.prototype.readSavedHeader.call(service, file);
    };
    service.readSavedIdentity = async (file) => {
      identityReads.push(file);
      return PiService.prototype.readSavedIdentity.call(service, file);
    };

    const { entries, next_offset } = await service.scanSavedSessions(null, 10, 10);
    assert.deepEqual(entries.map((entry) => entry.pi_session_id), Array.from({ length: 10 }, (_, i) => "pi-" + String(i + 10).padStart(2, "0")));
    assert.equal(next_offset, 20, "the next-page probe proves more valid headers remain");

    // Positions 0-9 (before the offset) and position 20 (the extra probe)
    // get first-line reads only; positions 10-19 (the page) get the 256KiB
    // identity prefix read. Corrupt files never consume a position or a read.
    const s = (index) => path.join(tmp, "s" + String(index).padStart(2, "0") + ".jsonl");
    assert.deepEqual(
      headerReads,
      Array.from({ length: 21 }, (_, index) => s(index)),
      "every candidate through the extra probe is read once, first line only"
    );
    assert.deepEqual(
      identityReads,
      Array.from({ length: 10 }, (_, index) => s(index + 10)),
      "the 256KiB identity prefix is read only for entries returned on the page"
    );
    assert.ok(!identityReads.some((file) => file.includes("corrupt")), "corrupt files never receive an identity read");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("a file rewritten between the header and identity reads is skipped without shifting page positions", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-scan-rewrite-"));
  const base = Date.now() / 1000;
  try {
    for (let index = 0; index < 25; index += 1) {
      const name = String(index).padStart(2, "0");
      const file = path.join(tmp, "s" + name + ".jsonl");
      await fs.writeFile(file, sessionJsonl([sessionHeader("pi-" + name, tmp), userMessage("task " + index)]));
      await fs.utimes(file, base - index * 10, base - index * 10);
    }
    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 },
      sessions: new Map()
    });

    // Static case: every page entry matches its first-line header, so none
    // is dropped or duplicated.
    const staticResult = await service.scanSavedSessions(null, 10, 10);
    assert.equal(staticResult.entries.length, 10);
    assert.equal(staticResult.next_offset, 20);

    // Dynamic case: s12.jsonl is rewritten between the two reads (its
    // identity prefix now carries a different header). It is skipped
    // conservatively; positions still count valid first-line headers.
    service.readSavedIdentity = async (file) => {
      if (path.basename(file) === "s12.jsonl") {
        return { header: { type: "session", id: "pi-other", cwd: tmp }, identity: { name: "replaced", summary: "rewritten" } };
      }
      return PiService.prototype.readSavedIdentity.call(service, file);
    };
    const { entries, next_offset } = await service.scanSavedSessions(null, 10, 10);
    assert.equal(entries.length, 9, "the rewritten file is skipped, never emitted with a mismatched header");
    assert.ok(!entries.some((entry) => entry.pi_session_id === "pi-12"));
    assert.equal(next_offset, 20, "page positions are unchanged: they count first-line headers");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("an unreadable session root is an error, never an empty session directory", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-missing-store-"));
  await fs.rm(tmp, { recursive: true, force: true });
  const service = Object.assign(Object.create(PiService.prototype), {
    sessionRoot: tmp,
    config: { maxSavedSessions: 100 },
    sessions: new Map()
  });
  await assert.rejects(
    service.listSessions(),
    (error) => error.code === "session_store_unavailable" && error.message.includes(tmp)
  );
});

test("a saved header with a non-absolute cwd is neither listed nor resumable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-invalid-cwd-"));
  try {
    await fs.writeFile(path.join(tmp, "bad.jsonl"), sessionJsonl([
      sessionHeader("pi-invalid-cwd", "relative/project"),
      userMessage("task")
    ]));
    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 },
      sessions: new Map()
    });
    const listed = await service.listSessions();
    assert.deepEqual(listed.saved_sessions, []);
    await assert.rejects(
      service.findSavedSession("pi-invalid-cwd"),
      (error) => error.code === "saved_session_not_found"
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resume outside allowed roots launches in the recorded existing workspace without allowed-root resolution", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-resume-out-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-resume-ws-"));
  try {
    await fs.writeFile(path.join(tmp, "s.jsonl"), sessionJsonl([sessionHeader("pi-out", outside), userMessage("task")]));
    let captured = null;
    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      allowedRoots: [tmp],
      config: { maxSavedSessions: 100 },
      resolveRecordedWorkspace: async () => outside,
      resolveSavedSessionFile: async (file) => file,
      startSession: async (input, internal) => {
        captured = { input, internal };
        return { session_id: "live-1", lifecycle: "running", workspace: internal.workspace, profile: { id: input.profile } };
      }
    });
    const result = await service.resume({ saved_session_id: "pi-out", profile: "research" });
    assert.equal(captured.internal.workspace, outside, "resume must launch in the recorded workspace even outside allowed roots");
    assert.ok(captured.input.sessionPath.endsWith("s.jsonl"), "the canonicalized session file is passed to the launcher");
    assert.equal(captured.input.profile, "research");
    assert.equal(captured.input.workspace, undefined, "resume must not pass a caller-controlled workspace");
    assert.equal(result.resumed_from.saved_session_id, "pi-out");
    assert.equal(result.resumed_from.workspace, outside);
    assert.equal(result.session.session_id, "live-1");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("a session recorded in a missing workspace stays listed but resume fails with an actionable workspace error", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-resume-missing-"));
  const missing = path.join(tmp, "gone");
  try {
    await fs.writeFile(path.join(tmp, "m.jsonl"), sessionJsonl([sessionHeader("pi-missing", missing), userMessage("task")]));
    let started = false;
    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      config: { maxSavedSessions: 100 },
      startSession: async () => {
        started = true;
        throw new Error("resume must not launch without an existing workspace");
      }
    });

    const { entries } = await service.scanSavedSessions(null, 100);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].pi_session_id, "pi-missing");
    const normalizedMissing = normalizeWslPath(missing);
    assert.equal(entries[0].workspace, normalizedMissing, "discovery still lists the normalized recorded workspace");

    await assert.rejects(
      service.resume({ saved_session_id: "pi-missing" }),
      (error) => error.code === "workspace_not_found" &&
        error.message.includes("pi-missing") &&
        error.message.includes(normalizedMissing) &&
        /still listed by pi_sessions/.test(error.message)
    );
    assert.equal(started, false, "resume must fail before launching Pi");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("new workspace selection remains constrained by allowed roots", {
  skip: process.platform !== "linux" && "Workspace filesystem resolution runs inside the WSL/Linux bridge runtime."
}, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-roots-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-roots-out-"));
  try {
    const service = Object.create(PiService.prototype);
    service.allowedRoots = [tmp];
    await assert.rejects(
      service.resolveWorkspace(outside),
      (error) => error.code === "workspace_not_allowed"
    );
    await assert.rejects(
      service.resolveWorkspace(path.join(tmp, "does-not-exist")),
      (error) => error.code === "workspace_not_found"
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("usageFromMessage extracts billed assistant usage and rejects synthetic empty usage", () => {
  assert.deepEqual(usageFromMessage({
    role: "assistant",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 18, cost: { total: 0.01 } }
  }), { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, total: 18, cost: 0.01 });
  // totalTokens missing -> computed from the parts.
  assert.deepEqual(usageFromMessage({
    role: "assistant",
    usage: { input: 3, output: 4, cost: { total: 0 } }
  }), { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 7, cost: 0 });
  // Synthetic failure/abort messages carry all-zero usage and are not model calls.
  assert.equal(usageFromMessage({ role: "assistant", usage: { input: 0, output: 0, cost: { total: 0 } } }), null);
  assert.equal(usageFromMessage({ role: "user", usage: { input: 1 } }), null);
  assert.equal(usageFromMessage({ role: "assistant" }), null);
});

test("assistant message_end usage is aggregated exactly once; turn_end never double counts", () => {
  const job = activeJob();
  const service = Object.create(PiService.prototype);
  const first = {
    role: "assistant",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 18, cost: { total: 0.01 } }
  };
  service.handleEvent({ job }, usageEvent(first));
  service.handleEvent({ job }, { type: "turn_end", turnIndex: 0, message: first, toolResults: [] });
  service.handleEvent({ job }, usageEvent({ role: "user", content: "input" }));
  service.handleEvent({ job }, usageEvent({ role: "assistant", provider: "deepseek", model: "deepseek-v4-pro", usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0.02 } } }));
  const stats = runStats(job);
  assert.equal(stats.model_calls, 2);
  assert.deepEqual(stats.usage, { input: 12, output: 8, cache_read: 2, cache_write: 1, reasoning: 3, total: 23 });
  assert.equal(stats.cost, 0.03);
  assert.equal(stats.models.length, 2);
  assert.deepEqual(stats.models[0], { provider: "deepseek", model: "deepseek-v4-pro", model_calls: 1, usage_total: 5, cost: 0.02 });
  assert.deepEqual(stats.models[1], { provider: "deepseek", model: "deepseek-v4-flash", model_calls: 1, usage_total: 18, cost: 0.01 });
  assert.ok(stats.elapsed_ms > 0, "an active run reports elapsed time so timeout snapshots remain useful");
});

test("model breakdown is bounded and overflow folds into an other bucket", () => {
  const job = activeJob();
  const service = Object.create(PiService.prototype);
  for (let index = 0; index < 14; index += 1) {
    service.handleEvent({ job }, usageEvent({
      role: "assistant",
      provider: "deepseek",
      model: "model-" + index,
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } }
    }));
  }
  const stats = runStats(job);
  assert.equal(stats.model_calls, 14);
  assert.ok(stats.models.length <= 8, "breakdown must stay bounded");
  assert.ok(stats.models.some((bucket) => bucket.provider === "other" && bucket.model === null));
});

test("compact run snapshots carry bounded progress without an ETA", () => {
  const job = activeJob({
    status: "running",
    modelStatus: "running",
    events: [
      { type: "agent_start", at: "2026-08-01T00:00:10.000Z" },
      { type: "tool_execution_start", tool_call_id: "t1", tool_name: "read", at: "2026-08-01T00:00:20.000Z" }
    ],
    lastTool: { name: "read", status: "running", at: "2026-08-01T00:00:20.000Z", target: "/home/user/work/package.json" }
  });
  const snapshot = jobSnapshot(job);
  assert.deepEqual(snapshot.progress, {
    phase: "model_working",
    last_activity_at: "2026-08-01T00:00:20.000Z",
    latest_tool: { name: "read", status: "running", target: "/home/user/work/package.json" }
  });
  assert.equal(snapshot.progress.eta, undefined, "progress must never invent an ETA");
  assert.equal(snapshot.progress.latest_tool.result, undefined, "progress must not carry tool result payloads");
  assert.equal(snapshot.stats.model_calls, 0);
  assert.equal(snapshot.stats.usage.total, 0);
});

test("progress phases distinguish model work, cleanup, and settlement", () => {
  let job = activeJob({ status: "running", modelStatus: "running", uiRequests: new Map([["confirm-1", {}]]) });
  assert.equal(runProgress(job).phase, "model_awaiting_input");
  job = activeJob({ status: "running", modelStatus: "running" });
  assert.equal(runProgress(job).phase, "model_working");
  job = activeJob({ status: "running", modelStatus: "stopped" });
  assert.equal(runProgress(job).phase, "cleanup", "model stopped but run not settled must read as cleanup");
  job = activeJob({ status: "collecting" });
  assert.equal(runProgress(job).phase, "cleanup");
  job = activeJob({ status: "settled", settledAt: "2026-08-01T00:01:00.000Z" });
  assert.equal(runProgress(job).phase, "settled");
  assert.equal(runProgress(job).last_activity_at, "2026-08-01T00:01:00.000Z");
  job = activeJob({ status: "error" });
  assert.equal(runProgress(job).phase, "error");
  job = activeJob({ status: "cancelling" });
  assert.equal(runProgress(job).phase, "cancelling");
  job = activeJob({ status: "accepted" });
  assert.equal(runProgress(job).phase, "starting");
});

test("tool completion updates latest tool status and target stays bounded", () => {
  const job = activeJob();
  const service = Object.create(PiService.prototype);
  service.handleEvent({ job }, {
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "read",
    args: { path: "/home/user/work/package.json" }
  });
  assert.equal(job.lastTool.status, "running");
  assert.equal(job.lastTool.target, "/home/user/work/package.json");
  service.handleEvent({ job }, {
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "read",
    isError: false,
    result: "huge payload"
  });
  assert.equal(job.lastTool.status, "completed");
  assert.equal(job.lastTool.target, "/home/user/work/package.json");
  assert.equal(jobSnapshot(job).progress.latest_tool.result, undefined);
  service.handleEvent({ job }, {
    type: "tool_execution_start",
    toolCallId: "t2",
    toolName: "grep",
    args: { pattern: "TODO" }
  });
  const progress = runProgress(job);
  assert.equal(progress.latest_tool.name, "grep");
  assert.equal(progress.latest_tool.target, undefined);
});

test("live directory entries expose an explicit process_status alongside lifecycle", () => {
  const busy = {
    id: "session-1",
    lifecycle: "running",
    workspace: "/home/user/pi-wsl-mcp",
    profile: { id: "review" },
    createdAt: "2026-08-01T00:00:00.000Z",
    state: { sessionId: "pi-1", sessionName: "Review pass" },
    job: { id: "run-1", status: "running" },
    uiRequests: new Map()
  };
  assert.equal(liveDirectoryEntry(busy).process_status, "running");
  assert.equal(liveDirectoryEntry(busy).lifecycle, "running");
  assert.equal(liveDirectoryEntry({ ...busy, lifecycle: "closed" }).process_status, "closed");
  assert.equal(liveDirectoryEntry({ ...busy, lifecycle: "faulted" }).process_status, "faulted");
});

test("auto_close closes the process once the run settles, exactly once", async () => {
  const job = activeJob({ status: "collecting" });
  const session = { id: "session-1", lifecycle: "running", job, autoCloseJobId: "run-1", uiRequests: new Map() };
  let closed = 0;
  const service = {
    close: async () => {
      closed += 1;
      session.lifecycle = "closed";
      return { session_id: session.id, closed: true };
    }
  };
  assert.equal(await PiService.prototype.autoCloseIfSettled.call(service, session), null, "still collecting -> no close");
  job.status = "settled";
  await PiService.prototype.autoCloseIfSettled.call(service, session);
  assert.equal(closed, 1);
  assert.equal(session.autoCloseJobId, null);
  assert.equal(session.lifecycle, "closed");
  await PiService.prototype.autoCloseIfSettled.call(service, session);
  assert.equal(closed, 1, "auto-close must fire exactly once");
});

test("unexpected process exit settles the run and clears deferred auto_close state", async () => {
  const handlers = new Map();
  const job = activeJob();
  const session = {
    id: "session-1",
    lifecycle: "running",
    profile: { id: "workspace" },
    job,
    autoCloseJobId: job.id,
    pendingClose: null,
    uiRequests: new Map(),
    rpc: { on: (name, handler) => handlers.set(name, handler) }
  };
  let closed = 0;
  const service = Object.create(PiService.prototype);
  service.close = async () => {
    closed += 1;
    session.lifecycle = "closed";
    return { closed: true };
  };
  service.attach(session);
  handlers.get("exit")();
  await session.pendingClose;
  assert.equal(job.status, "error");
  assert.match(job.error, /exited before the run settled/);
  assert.equal(session.autoCloseJobId, null);
  assert.equal(closed, 1);
});

test("read-only profiles exclude the search function tool and keep the navigation tools", () => {
  for (const profile of [PROFILES.review, PROFILES.research]) {
    assert.ok(profile.tools.includes("read"), profile.id + " keeps read");
    assert.ok(profile.tools.includes("web_search"), profile.id + " keeps web_search");
    assert.ok(profile.tools.includes("map"), profile.id + " keeps CodeMapper navigation");
    assert.ok(profile.tools.includes("path"), profile.id + " keeps CodeMapper navigation");
    assert.ok(!profile.tools.includes("search"), profile.id + " must not expose a function tool named search");
    assert.deepEqual(profile.excludeTools, ["search"], profile.id + " must exclude the search tool explicitly");
  }
  assert.equal(PROFILES.workspace.tools, null, "workspace keeps the normal toolset");
  assert.equal(PROFILES.workspace.excludeTools, undefined, "workspace never gains an exclusion");
});

test("assistant message events record stop reason and raw error text", () => {
  const service = Object.create(PiService.prototype);
  service.config = { commandTimeoutMs: 1000 };
  const job = activeJob({ status: "accepted" });
  const session = { id: "session-1", job, uiRequests: new Map(), rpc: {} };

  service.handleEvent(session, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "OpenAI API error (400): the search tool conflicts with web_search",
      usage: { input: 0, output: 0, totalTokens: 0 }
    }
  });
  assert.equal(job.stopReason, "error");
  assert.match(job.stopErrorMessage, /conflicts with web_search/);

  // Non-assistant messages never touch the stop state.
  service.handleEvent(session, { type: "message_end", message: { role: "user" } });
  assert.equal(job.stopReason, "error");
});

test("agent_end message lists also record the stop reason when message events are missed", () => {
  const service = Object.create(PiService.prototype);
  service.config = { commandTimeoutMs: 1000 };
  const job = activeJob({ status: "running" });
  const session = { id: "session-1", job, uiRequests: new Map(), rpc: {} };
  service.handleEvent(session, {
    type: "agent_end",
    messages: [
      { role: "user" },
      { role: "assistant", stopReason: "error", errorMessage: "boom" }
    ]
  });
  assert.equal(job.stopReason, "error");
  assert.equal(job.stopErrorMessage, "boom");
});

test("actionableRunError maps the DeepSeek web_search conflict to remediation", () => {
  const mapped = actionableRunError({
    stopErrorMessage: "OpenAI API error (400): {\"message\":\"The tool search in your request conflicts with server side web_search calls. Please modify your tool name or disable web_search call\"}"
  });
  assert.match(mapped, /function tool named "search"/);
  assert.match(mapped, /research or review profile/);
  assert.match(mapped, /--exclude-tools search/);
  assert.match(mapped, /disable the provider's server-side web_search/);
  assert.equal(actionableRunError({ stopErrorMessage: "rate limited" }), "rate limited");
  assert.equal(actionableRunError({}), "Pi ended the run with stop_reason=error.");
  assert.equal(actionableRunError(null), "Pi ended the run with stop_reason=error.");
  assert.equal(
    actionableRunError({ stopErrorMessage: "secret api_key=abc123 failed" }),
    "secret api_key=[redacted] failed"
  );
});

test("agent_settled with stop_reason=error ends the run as an actionable error", async () => {
  const job = activeJob({ status: "running" });
  const session = {
    id: "session-1",
    job,
    uiRequests: new Map(),
    rpc: { command: async () => ({ data: {} }) }
  };
  const service = Object.create(PiService.prototype);
  service.config = { commandTimeoutMs: 1000 };
  service.autoCloseIfSettled = () => null;

  service.handleEvent(session, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "OpenAI API error (400): The tool search in your request conflicts with server side web_search calls"
    }
  });
  service.handleEvent(session, { type: "agent_end" });
  service.handleEvent(session, { type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(job.status, "error", "stop_reason=error must never settle as success");
  assert.equal(job.cleanupStatus, "completed", "collection itself completed; the run verdict is error");
  assert.match(job.error, /function tool named "search" conflicts/);
  assert.equal(job.result.assistant_text, null);
  assert.equal(jobSnapshot(job).stop_reason, "error");
  assert.equal(jobSnapshot(job).status, "error");
});

test("agent_settled without a collectable answer is an error, never an empty settled", async () => {
  const job = activeJob({ status: "running" });
  const session = {
    id: "session-1",
    job,
    uiRequests: new Map(),
    rpc: { command: async () => ({ data: {} }) }
  };
  const service = Object.create(PiService.prototype);
  service.config = { commandTimeoutMs: 1000 };
  service.autoCloseIfSettled = () => null;

  service.handleEvent(session, { type: "agent_start" });
  service.handleEvent(session, { type: "agent_end" });
  service.handleEvent(session, { type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(job.status, "error");
  assert.match(job.error, /without producing an answer text/);
  assert.equal(jobSnapshot(job).stop_reason, null);
});

test("a budget-exhausted run without a final answer gets an explicit budget error", async () => {
  const job = activeJob({
    status: "running",
    modelStatus: "running",
    budget: { maxElapsedSeconds: null, maxModelCalls: 5, maxCost: null, exceeded: "model_calls", cancelRequested: true }
  });
  const session = {
    id: "session-1",
    job,
    uiRequests: new Map(),
    rpc: { command: async () => ({ data: {} }) }
  };
  const service = Object.create(PiService.prototype);
  service.config = { commandTimeoutMs: 1000 };
  service.autoCloseIfSettled = () => null;

  service.handleEvent(session, { type: "agent_start" });
  service.handleEvent(session, { type: "agent_end" });
  service.handleEvent(session, { type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(job.status, "error", "a cancelled run without an answer must never settle as success");
  assert.match(job.error, /max_model_calls budget was exhausted before a final answer was collected/);
  assert.match(job.error, /Retry without that budget limit, or with a higher max_model_calls\./);
  assert.ok(!job.error.includes("api_key") && !job.error.includes("boom"), "no raw provider text may leak");
  // The structured snapshot still exposes the effective budget fields.
  const snapshot = jobSnapshot(job);
  assert.equal(snapshot.budget_exceeded, "model_calls");
  assert.deepEqual(snapshot.budget, { max_elapsed_seconds: null, max_model_calls: 5, max_cost: null });
  assert.equal(snapshot.status, "error");
});

test("a settled run with a real answer and no error stop reason stays settled", async () => {
  const job = activeJob({ status: "running" });
  const session = {
    id: "session-1",
    job,
    uiRequests: new Map(),
    rpc: { command: async () => ({ data: { text: "the official site is https://modelcontextprotocol.io" } }) }
  };
  const service = Object.create(PiService.prototype);
  service.config = { commandTimeoutMs: 1000 };
  service.autoCloseIfSettled = () => null;

  service.handleEvent(session, {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop" }
  });
  service.handleEvent(session, { type: "agent_end" });
  service.handleEvent(session, { type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(job.status, "settled");
  assert.equal(job.error, null);
  assert.equal(job.result.assistant_text, "the official site is https://modelcontextprotocol.io");
});

test("collectFinalResult closes an auto-close session on settlement and on collection errors", async () => {
  const job = activeJob({ status: "collecting" });
  const session = { id: "session-1", lifecycle: "running", job, autoCloseJobId: "run-1", uiRequests: new Map() };
  let closed = 0;
  const service = {
    config: { commandTimeoutMs: 1000 },
    autoCloseIfSettled: PiService.prototype.autoCloseIfSettled,
    close: async () => {
      closed += 1;
      session.lifecycle = "closed";
    }
  };
  session.rpc = { command: async () => ({ data: { text: "done" } }) };
  await PiService.prototype.collectFinalResult.call(service, session, job);
  assert.equal(job.status, "settled");
  assert.equal(closed, 1);
  assert.equal(session.lifecycle, "closed");

  const failing = activeJob({ status: "collecting" });
  const failingSession = { id: "session-2", lifecycle: "running", job: failing, autoCloseJobId: failing.id, uiRequests: new Map() };
  failingSession.rpc = { command: async () => { throw new Error("collection exploded"); } };
  let closedFailing = 0;
  const failingService = {
    config: { commandTimeoutMs: 1000 },
    autoCloseIfSettled: PiService.prototype.autoCloseIfSettled,
    close: async () => {
      closedFailing += 1;
      failingSession.lifecycle = "closed";
    }
  };
  await PiService.prototype.collectFinalResult.call(failingService, failingSession, failing);
  assert.equal(failing.status, "error");
  assert.equal(closedFailing, 1, "a collection error with auto_close must still close the process");
  assert.equal(failingSession.lifecycle, "closed");
  assert.equal(failingSession.autoCloseJobId, null);
});

test("task with auto_close closes the process when the prompt fails", async () => {
  const job = activeJob({ status: "accepted" });
  const session = { id: "session-1", lifecycle: "running", profile: { id: "workspace" }, job, autoCloseJobId: null, uiRequests: new Map() };
  let closed = 0;
  const service = {
    startSession: async () => ({ session_id: session.id }),
    getSession: () => session,
    liveSummary: () => ({ session_id: session.id, lifecycle: session.lifecycle }),
    autoCloseIfSettled: PiService.prototype.autoCloseIfSettled,
    close: async () => {
      closed += 1;
      session.lifecycle = "closed";
      return { closed: true };
    },
    send: async () => {
      job.status = "error";
      job.error = "prompt rejected";
      job.settledAt = "2026-08-01T00:00:01.000Z";
      throw new Error("prompt rejected");
    }
  };
  await assert.rejects(
    PiService.prototype.task.call(service, { message: "go", auto_close: true }),
    /prompt rejected/
  );
  assert.equal(closed, 1, "a failed prompt with auto_close must not leak the process");
  assert.equal(session.lifecycle, "closed");
});

test("a rejected prompt preserves accepted session and run ids on the error", async () => {
  const session = {
    id: "session-accepted",
    lifecycle: "running",
    job: null,
    autoCloseJobId: null,
    pendingClose: null,
    uiRequests: new Map(),
    rpc: {
      command: async () => {
        throw new Error("prompt rejected");
      }
    }
  };
  const service = {
    getSession: () => session,
    liveSummary: () => ({
      session_id: session.id,
      process_status: session.lifecycle
    })
  };

  await assert.rejects(
    PiService.prototype.send.call(service, {
      session_id: session.id,
      message: "go",
      behavior: "prompt"
    }),
    (error) => {
      assert.equal(error.code, "prompt_failed");
      assert.equal(error.details?.accepted_result?.session_id, session.id);
      assert.equal(error.details?.accepted_result?.run_id, session.job.id);
      assert.deepEqual(error.details?.accepted_result?.continuation, {
        pi_wait: { session_id: session.id, run_id: session.job.id },
        pi_status: { session_id: session.id }
      });
      assert.equal(error.details?.accepted_result?.run?.status, "error");
      return true;
    }
  );
});

test("task with auto_close defers closing until a run settles after a timeout", async () => {
  const job = activeJob({ status: "collecting" });
  const session = { id: "session-1", lifecycle: "running", profile: { id: "workspace" }, job, autoCloseJobId: null, uiRequests: new Map() };
  let closed = 0;
  const service = {
    startSession: async () => ({ session_id: session.id }),
    getSession: () => session,
    liveSummary: () => ({ session_id: session.id, lifecycle: session.lifecycle }),
    autoCloseIfSettled: PiService.prototype.autoCloseIfSettled,
    close: async () => {
      closed += 1;
      session.lifecycle = "closed";
    },
    send: async () => {
      job.status = "accepted";
      return jobSnapshot(job);
    }
  };
  const dispatched = await PiService.prototype.task.call(service, { message: "go", auto_close: true, wait_seconds: 0 });
  assert.equal(dispatched.run.status, "accepted");
  assert.equal(closed, 0, "a still-running run must not be closed early");
  assert.equal(session.autoCloseJobId, "run-1", "the deferred close must be registered");
  job.status = "settled";
  await PiService.prototype.autoCloseIfSettled.call(service, session);
  assert.equal(closed, 1, "the deferred close must fire once the run settles");
  assert.equal(session.lifecycle, "closed");
});

test("task with auto_close and a requested wait closes before returning", async () => {
  const job = activeJob({ status: "settled", settledAt: "2026-08-01T00:01:00.000Z" });
  const session = { id: "session-1", lifecycle: "running", profile: { id: "workspace" }, job, autoCloseJobId: null, uiRequests: new Map() };
  let closed = 0;
  const service = {
    startSession: async () => ({ session_id: session.id }),
    getSession: () => session,
    liveSummary: () => ({ session_id: session.id, lifecycle: session.lifecycle }),
    autoCloseIfSettled: PiService.prototype.autoCloseIfSettled,
    close: async () => {
      closed += 1;
      session.lifecycle = "closed";
      return { closed: true };
    },
    send: async () => jobSnapshot(job),
    wait: PiService.prototype.wait
  };
  const result = await PiService.prototype.task.call(service, { message: "go", auto_close: true, wait_seconds: 30 });
  assert.equal(result.run.status, "settled");
  assert.equal(closed, 1, "task and wait must close the process exactly once between them");
  assert.equal(session.lifecycle, "closed", "the wait result must already reflect the closed process");
});

test("task reuse requires the expected profile and rejects start-only options", async () => {
  const session = { id: "session-1", lifecycle: "running", profile: { id: "review" }, job: null, uiRequests: new Map() };
  const service = {
    getSession: () => session,
    startSession: async () => { throw new Error("reuse must never start a session"); },
    send: async () => jobSnapshot(activeJob({ status: "accepted" })),
    liveSummary: () => ({ session_id: session.id })
  };
  await assert.rejects(
    PiService.prototype.task.call(service, { session_id: "session-1", message: "go", provider: "deepseek" }),
    /cannot be combined with provider/
  );
  await assert.rejects(
    PiService.prototype.task.call(service, { session_id: "session-1", message: "go", model: "deepseek-v4-pro" }),
    /cannot be combined with model/
  );
  await assert.rejects(
    PiService.prototype.task.call(service, { session_id: "session-1", message: "go", workspace: "/home/user/work" }),
    /cannot be combined with workspace/
  );
  await assert.rejects(
    PiService.prototype.task.call(service, { session_id: "session-1", message: "go", thinking: "high" }),
    /cannot be combined with thinking/
  );
  await assert.rejects(
    PiService.prototype.task.call(service, { session_id: "session-1", message: "go", name: "named" }),
    /cannot be combined with name/
  );
  await assert.rejects(
    PiService.prototype.task.call(service, { session_id: "session-1", message: "go", profile: "workspace" }),
    /requires the workspace profile/
  );
  session.job = activeJob();
  await assert.rejects(
    PiService.prototype.task.call(service, { session_id: "session-1", message: "go", profile: "review" }),
    /wait for it to settle/
  );
  session.job = null;
  const accepted = await PiService.prototype.task.call(service, {
    session_id: "session-1",
    message: "go",
    profile: "review",
    wait_seconds: 0
  });
  assert.equal(accepted.run.run_id, "run-1");
});

test("task reuse rejects non-running sessions and accepts auto_close", async () => {
  const closedSession = { id: "session-2", lifecycle: "closed", profile: { id: "research" }, job: null, uiRequests: new Map() };
  let sent = 0;
  let liveSession;
  const service = {
    getSession: (id) => (id === "session-2" ? closedSession : liveSession),
    startSession: async () => { throw new Error("reuse must never start a session"); },
    send: async () => {
      sent += 1;
      liveSession.job = activeJob({ status: "accepted" });
      return jobSnapshot(liveSession.job);
    },
    liveSummary: () => ({ session_id: liveSession.id })
  };
  await assert.rejects(
    PiService.prototype.task.call(service, { session_id: "session-2", message: "go", profile: "research" }),
    /cannot be reused/
  );
  liveSession = { id: "session-3", lifecycle: "running", profile: { id: "research" }, job: null, uiRequests: new Map() };
  const result = await PiService.prototype.task.call(service, {
    session_id: "session-3",
    message: "go",
    profile: "research",
    wait_seconds: 0
  });
  assert.equal(sent, 1);
  assert.equal(result.run.status, "accepted");
});
