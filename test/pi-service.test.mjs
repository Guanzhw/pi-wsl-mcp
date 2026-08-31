import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SYNC_WINDOW_MS, PROFILES, PiService, actionableRunError, jobSnapshot, liveDirectoryEntry, savedDirectoryEntry, runProgress, runStats, usageFromMessage } from "../src/pi-service.mjs";

function activeJob(overrides = {}) {
  return {
    id: "run-1",
    status: "running",
    kind: "prompt",
    modelStatus: "idle",
    cleanupStatus: "pending",
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
  assert.equal(compact.progress.phase, "settled");
  assert.equal(compact.stats.model_calls, 0);

  const detailed = jobSnapshot(job, { includeDetails: true });
  assert.equal(detailed.result, null, "the final answer stays out of structured run diagnostics");
  assert.equal(detailed.result?.assistant_text, undefined);
  assert.equal(detailed.recent_events.length, 1);
  assert.equal(detailed.streamed_message_updates, 42);
  assert.equal(detailed.tool_calls, undefined);
});

test("diagnostics report the fixed ten-minute synchronous window", () => {
  const result = PiService.prototype.diagnostics.call({
    config: { piBin: "/home/user/.npm-global/bin/pi", maxSessions: 3 },
    allowedRoots: ["/home/user/work"],
    defaultWorkspace: "/home/user/work",
    sessionRoot: "/home/user/.pi/agent/sessions"
  });
  assert.equal(result.sync_window_seconds, 600);
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
    run_id: "run-1"
  });
  assert.equal(compact.answer, "Compact answer.");
  assert.equal(compact.run.result, undefined);
  assert.equal(compact.run.recent_events, undefined);
  assert.equal(compact.session_id, "session-1");
  assert.equal(compact.run_id, "run-1");
  assert.deepEqual(compact.continuation, {
    pi_wait: { session_id: "session-1", run_id: "run-1" },
    pi_status: { session_id: "session-1" },
    pi_kill_session: { session_id: "session-1" }
  });

  const detailed = await PiService.prototype.wait.call(service, {
    session_id: "session-1",
    run_id: "run-1",
    include_details: true
  });
  assert.equal(detailed.answer, "Compact answer.");
  assert.equal(detailed.run.result, null, "the final answer stays in the answer carrier only");
  assert.equal(detailed.run.result?.assistant_text, undefined);
  assert.equal(detailed.run.recent_events.length, 1);
});

test("wait uses the fixed bridge window without a caller timeout", async () => {
  const settleSoon = (job, ms = 30) => {
    setTimeout(() => {
      job.status = "settled";
      job.settledAt = new Date().toISOString();
      job.completion.resolve(job);
    }, ms);
  };
  const service = {
    config: { waitWindowMs: 100 },
    liveSummary: () => ({ session_id: "session-1", process_status: "running" })
  };
  let currentSession = null;
  service.getSession = () => currentSession;

  const job = activeJob();
  job.completion = {};
  job.completion.promise = new Promise((resolve) => { job.completion.resolve = resolve; });
  settleSoon(job);
  currentSession = { id: "session-1", job };
  const result = await PiService.prototype.wait.call(service, {
    session_id: "session-1",
    run_id: "run-1",
  });
  assert.equal(result.session_id, "session-1");
  assert.equal(result.run_id, "run-1");
  assert.equal(result.run.status, "settled");
  assert.equal(result.session.process_status, "running");
  assert.deepEqual(result.continuation, {
    pi_wait: { session_id: "session-1", run_id: "run-1" },
    pi_status: { session_id: "session-1" },
    pi_kill_session: { session_id: "session-1" }
  });
});
test("status defaults to a compact live/job snapshot and opts into bounded diagnostics", async () => {
  const session = {
    id: "session-1",
    lifecycle: "running",
    workspace: "/home/user/work",
    profile: { id: "review" },
    createdAt: "2026-08-01T00:00:00.000Z",
    state: null,
    uiRequests: new Map(),
    job: settledJob(),
    rpc: {
      protocolWarnings: [],
      command: async () => ({ data: { model: { provider: "deepseek", id: "deepseek-v4-flash" }, thinkingLevel: "low" } })
    }
  };
  const service = {
    config: { resultLimit: 1000 },
    getSession: () => session,
    liveSummary: PiService.prototype.liveSummary,
    syncState: PiService.prototype.syncState
  };

  const compact = await PiService.prototype.status.call(service, { session_id: "session-1" });
  assert.equal(compact.job.run_id, "run-1");
  assert.equal(compact.job.result, undefined);
  assert.equal(compact.job.recent_events, undefined);
  assert.equal(compact.job.tool_calls, undefined);
  assert.deepEqual(compact.continuation, {
    pi_wait: { session_id: "session-1", run_id: "run-1" },
    pi_status: { session_id: "session-1" },
    pi_kill_session: { session_id: "session-1" }
  });

  const detailed = await PiService.prototype.status.call(service, {
    session_id: "session-1",
    include_details: true
  });
  assert.equal(detailed.job.result, null);
  assert.equal(detailed.job.result?.assistant_text, undefined);
  assert.equal(detailed.job.recent_events.length, 1);
  assert.deepEqual(detailed.continuation, compact.continuation);
});

test("an expiring wait for a still-active run returns a structured timeout, never throws", async () => {
  const job = activeJob();
  const session = { id: "session-1", job };
  const service = {
    config: { waitWindowMs: 5 },
    getSession: () => session,
    liveSummary: () => ({ session_id: "session-1", process_status: "running" })
  };
  const started = Date.now();
  const result = await PiService.prototype.wait.call(service, {
    session_id: "session-1",
    run_id: "run-1"
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
    pi_status: { session_id: "session-1" },
    pi_kill_session: { session_id: "session-1" }
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

test("runs never carry caller budgets and remain active until Pi settles", async () => {
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
    scanSavedSessions: async () => [{
      pi_session_id: "pi-9",
      workspace: "/home/user/work",
      created_at: "2026-07-01T00:00:00.000Z",
      modified_at: "2026-07-02T00:00:00.000Z",
      bytes: 1234,
      name: "Review pass",
      summary: "Check the unstaged diff"
    }],
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
  assert.equal(calls.length, 0, "compact listing must not consult liveSummary");

  const detailed = await PiService.prototype.listSessions.call(service, { include_details: true });
  assert.equal(detailed.live_sessions[0].job.run_id, "run-1");
  assert.deepEqual(calls, [{ includeDetails: true }]);
  assert.equal(detailed.saved_sessions[0].bytes, 1234);
  assert.equal(detailed.saved_sessions[0].session_file, undefined);
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
      allowedRoots: [tmp],
      config: { maxSavedSessions: 100 },
      resolveSavedSessionWorkspace: async (cwd) => cwd
    });
    const result = await service.scanSavedSessions(tmp, 100);
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
    for (const entry of result) {
      assert.equal(entry.session_file, undefined, "the scanner must not expose file paths");
      assert.ok(entry.bytes > 0);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("scanSavedSessions filters by workspace and honors the limit", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-scan-limit-"));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "piwsl-scan-other-"));
  try {
    await fs.writeFile(path.join(tmp, "in.jsonl"), sessionJsonl([sessionHeader("pi-in", tmp), userMessage("task in workspace")]));
    await fs.writeFile(path.join(other, "out.jsonl"), sessionJsonl([sessionHeader("pi-out", other), userMessage("task outside")]));
    const service = Object.assign(Object.create(PiService.prototype), {
      sessionRoot: tmp,
      allowedRoots: [tmp, other],
      config: { maxSavedSessions: 100 },
      resolveSavedSessionWorkspace: async (cwd) => cwd
    });

    const filtered = await service.scanSavedSessions(tmp, 100);
    assert.deepEqual(filtered.map((entry) => entry.pi_session_id), ["pi-in"]);

    const all = await service.scanSavedSessions(null, 1);
    assert.equal(all.length, 1, "the limit must bound the directory listing");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
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

test("unexpected process exit settles and releases an event-driven waiter", async () => {
  const handlers = new Map();
  const job = activeJob();
  let resolveCompletion;
  job.completion = {
    settled: false,
    promise: new Promise((resolve) => { resolveCompletion = resolve; }),
    resolve: (value) => resolveCompletion(value)
  };
  const session = {
    id: "session-1",
    lifecycle: "running",
    profile: { id: "workspace" },
    job,
    uiRequests: new Map(),
    rpc: { on: (name, handler) => handlers.set(name, handler) }
  };
  const service = Object.create(PiService.prototype);
  service.attach(session);
  handlers.get("exit")();
  await job.completion.promise;
  assert.equal(job.status, "error");
  assert.match(job.error, /exited before the run settled/);
  assert.equal(job.completion.settled, true);
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

  service.handleEvent(session, { type: "agent_start" });
  service.handleEvent(session, { type: "agent_end" });
  service.handleEvent(session, { type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(job.status, "error");
  assert.match(job.error, /without producing an answer text/);
  assert.equal(jobSnapshot(job).stop_reason, null);
});

test("a run without a final answer gets the generic observed error", async () => {
  const job = activeJob({ status: "running", modelStatus: "running" });
  const session = {
    id: "session-1",
    job,
    uiRequests: new Map(),
    rpc: { command: async () => ({ data: {} }) }
  };
  const service = Object.create(PiService.prototype);
  service.config = { commandTimeoutMs: 1000 };

  service.handleEvent(session, { type: "agent_start" });
  service.handleEvent(session, { type: "agent_end" });
  service.handleEvent(session, { type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(job.status, "error", "a cancelled run without an answer must never settle as success");
  assert.match(job.error, /without producing an answer text/);
  assert.ok(!job.error.includes("api_key") && !job.error.includes("boom"), "no raw provider text may leak");
  const snapshot = jobSnapshot(job);
  assert.equal(snapshot.budget, undefined);
  assert.equal(snapshot.budget_exceeded, undefined);
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

test("a rejected prompt preserves accepted session and run ids on the error", async () => {
  const session = {
    id: "session-accepted",
    lifecycle: "running",
    job: null,
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
        pi_status: { session_id: session.id },
        pi_kill_session: { session_id: session.id }
      });
      assert.equal(error.details?.accepted_result?.run?.status, "error");
      return true;
    }
  );
});

test("runOnce waits for settlement without polling and closes the ephemeral session", async () => {
  assert.equal(DEFAULT_SYNC_WINDOW_MS, 10 * 60 * 1000);
  let resolveCompletion;
  const job = activeJob();
  job.completion = {
    promise: new Promise((resolve) => { resolveCompletion = resolve; })
  };
  const session = { id: "session-sync", job };
  const calls = [];
  const service = {
    startSession: async () => ({ session_id: session.id }),
    getSession: () => session,
    send: async () => {
      calls.push("send");
      queueMicrotask(() => {
        job.status = "settled";
        job.result = { assistant_text: "Final synchronous answer." };
        resolveCompletion(job);
      });
      return { run_id: job.id };
    },
    close: async () => { calls.push("close"); }
  };

  const result = await PiService.prototype.runOnce.call(service, { message: "review" });
  assert.deepEqual(result, {
    status: "completed",
    answer: "Final synchronous answer.",
    error: null
  });
  assert.deepEqual(calls, ["send", "close"]);
});

test("runOnce hands an active job to the background after the fixed window", async () => {
  let resolveCompletion;
  const job = activeJob();
  job.completion = {
    promise: new Promise((resolve) => { resolveCompletion = resolve; })
  };
  const session = { id: "session-background", lifecycle: "running", job };
  const calls = [];
  const service = {
    config: { syncWindowMs: 5 },
    startSession: async () => ({ session_id: session.id }),
    getSession: () => session,
    send: async () => { calls.push("send"); return { run_id: job.id }; },
    close: async () => { calls.push("close"); }
  };

  const result = await PiService.prototype.runOnce.call(service, { message: "long review" });
  assert.equal(result.status, "background");
  assert.equal(result.answer, null);
  assert.equal(result.session_id, session.id);
  assert.equal(result.run_id, job.id);
  assert.equal(result.run.status, "running");
  assert.deepEqual(result.continuation, {
    pi_wait: { session_id: session.id, run_id: job.id },
    pi_status: { session_id: session.id },
    pi_kill_session: { session_id: session.id }
  });
  assert.deepEqual(calls, ["send"], "a background handoff must keep the Pi process alive");

  // Finish the mock run so its completion promise does not remain pending in
  // the test process; the real session remains available to pi_wait.
  job.status = "settled";
  resolveCompletion(job);
});

test("killSession force-exits the process and settles an active run as failed", async () => {
  let resolveCompletion;
  const job = activeJob({ status: "running", modelStatus: "running" });
  job.completion = {
    settled: false,
    promise: new Promise((resolve) => { resolveCompletion = resolve; }),
    resolve: (value) => resolveCompletion(value)
  };
  const session = {
    id: "session-kill",
    lifecycle: "running",
    state: { sessionId: "pi-kill", sessionFile: "/home/user/.pi/agent/sessions/pi-kill.jsonl" },
    job,
    rpc: { kill: async () => { session.killed = true; } }
  };
  const service = { getSession: () => session };

  const result = await PiService.prototype.killSession.call(service, { session_id: session.id });
  assert.equal(session.killed, true);
  assert.equal(session.lifecycle, "killed");
  assert.equal(job.status, "error");
  assert.equal(job.modelStatus, "failed");
  assert.equal(job.error, "Pi session was force-killed.");
  assert.deepEqual(result, {
    session_id: session.id,
    killed: true,
    run_id: job.id,
    pi_session_id: "pi-kill",
    pi_session_file: "/home/user/.pi/agent/sessions/pi-kill.jsonl"
  });
  assert.equal(job.completion.settled, true);
  resolveCompletion?.(job);
});
