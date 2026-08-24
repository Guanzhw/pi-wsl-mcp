import { promises as fs } from "node:fs";
import path from "node:path";
import {
  boundedValue,
  canonicalDirectory,
  canonicalFileWithin,
  canonicalRoots,
  createConfig,
  createId,
  normalizeWslPath,
  PiWslError,
  readFirstLine,
  redactText,
  resolveExecutable
} from "./util.mjs";
import { PiRpcProcess } from "./pi-rpc.mjs";

const ACTIVE_JOB_STATES = new Set(["accepted", "running", "collecting", "cancelling"]);
const TERMINAL_JOB_STATES = new Set(["settled", "error"]);
const INTERACTIVE_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
// Pi RPC mode emits fire-and-forget extension notifications (setStatus, notify,
// setWidget) as extension_ui_request events with these non-interactive methods.
// They are summarized into the bounded event stream but never stored as pending
// requests and must never mutate run/model/cleanup state: a late status
// notification cannot reopen or block a completed run.
const NOTIFICATION_UI_METHODS = new Set(["setStatus", "notify", "setWidget"]);
// Small, monotonic lifecycle enums (idle -> running -> stopped -> failed and
// pending -> running -> completed/failed). Model stop (agent_end) is NOT run
// settlement; only agent_settled plus final collection settles the run.
const MODEL_STATUS = new Set(["idle", "running", "stopped", "failed"]);
const CLEANUP_STATUS = new Set(["pending", "running", "completed", "failed"]);
const MAX_MODEL_BUCKETS = 8;
const OTHER_MODEL_BUCKET = "__other__";
// Saved-session identification stays bounded: a directory listing scans only
// this prefix of each session file and never loads a whole transcript.
const SESSION_PREVIEW_BYTES = 262144;
const SESSION_PREVIEW_CHARS = 160;

export const PROFILES = {
  workspace: {
    id: "workspace",
    title: "Full Pi workspace",
    description: "Normal Pi tools and installed extensions. It may read, write, edit, or run commands when prompted.",
    tools: null
  },
  review: {
    id: "review",
    title: "Read-only review",
    description: "Pi is started with an explicit read/search-only tool allowlist.",
    // The named `search` function tool is excluded from read-only profiles:
    // it collides with DeepSeek Responses' server-side web_search, which
    // rejects requests that carry both (400 invalid_request_error). The
    // remaining CodeMapper navigation tools keep working.
    excludeTools: ["search"],
    tools: [
      "read", "grep", "find", "ls",
      "web_search", "fetch_content", "get_search_content",
      "knowledge_search", "kb_read",
      "session_search", "session_list", "session_read",
      "map", "outline", "expand", "path"
    ]
  },
  research: {
    id: "research",
    title: "Read-only research",
    description: "Local read/search plus installed web, knowledge, and session search tools; no edit or shell tool.",
    excludeTools: ["search"],
    tools: [
      "read", "grep", "find", "ls",
      "web_search", "fetch_content", "get_search_content",
      "knowledge_search", "kb_read",
      "session_search", "session_list", "session_read",
      "map", "outline", "expand", "path"
    ]
  }
};

function now() {
  return new Date().toISOString();
}

function profileFor(profile) {
  const resolved = PROFILES[profile || "workspace"];
  if (!resolved) {
    throw new PiWslError("invalid_profile", "Unknown Pi profile: " + profile);
  }
  return resolved;
}

function briefMessage(message) {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const result = {
    role: typeof message.role === "string" ? message.role : undefined
  };
  if (typeof message.stopReason === "string") {
    result.stop_reason = message.stopReason;
  }
  if (typeof message.model === "string") {
    result.model = message.model;
  }
  return result;
}

function summarizeEvent(event) {
  const summary = { type: typeof event?.type === "string" ? event.type : "unknown", at: now() };
  if (!event || typeof event !== "object") {
    return summary;
  }
  switch (event.type) {
    case "agent_end":
      summary.will_retry = Boolean(event.willRetry);
      summary.message_count = Array.isArray(event.messages) ? event.messages.length : 0;
      return summary;
    case "turn_start":
    case "turn_end":
      summary.turn_index = event.turnIndex;
      if (event.message) {
        summary.message = briefMessage(event.message);
      }
      if (Array.isArray(event.toolResults)) {
        summary.tool_result_count = event.toolResults.length;
      }
      return summary;
    case "message_start":
    case "message_end":
      summary.message = briefMessage(event.message);
      return summary;
    case "tool_execution_start":
      summary.tool_call_id = event.toolCallId;
      summary.tool_name = event.toolName;
      summary.arguments = boundedValue(event.args, { maxDepth: 4, maxItems: 30, maxString: 2000 });
      return summary;
    case "tool_execution_end":
      summary.tool_call_id = event.toolCallId;
      summary.tool_name = event.toolName;
      summary.is_error = Boolean(event.isError);
      summary.result = boundedValue(event.result, { maxDepth: 4, maxItems: 30, maxString: 3000 });
      return summary;
    case "extension_ui_request":
      summary.request_id = event.id;
      summary.method = event.method;
      summary.title = event.title;
      summary.message = event.message;
      summary.options = Array.isArray(event.options) ? event.options.slice(0, 30) : undefined;
      return boundedValue(summary, { maxString: 3000 });
    case "extension_error":
      summary.error = event.error || event.message;
      return boundedValue(summary, { maxString: 3000 });
    case "queue_update":
      summary.steering_count = Array.isArray(event.steering) ? event.steering.length : 0;
      summary.follow_up_count = Array.isArray(event.followUp) ? event.followUp.length : 0;
      return summary;
    default:
      return boundedValue(summary, { maxString: 2000 });
  }
}

function summarizeEntry(entry, includeContent) {
  if (includeContent) {
    return boundedValue(entry, { maxDepth: 10, maxItems: 80, maxString: 8000 });
  }
  const summary = {
    id: entry?.id,
    type: entry?.type,
    parent_id: entry?.parentId,
    timestamp: entry?.timestamp
  };
  if (entry?.message) {
    summary.message = briefMessage(entry.message);
  }
  if (entry?.customType) {
    summary.custom_type = entry.customType;
  }
  return boundedValue(summary, { maxString: 1000 });
}

// Bounded, safe target for the latest tool execution: a path/file argument when
// the tool call carried one. Never the tool result payload.
function toolTarget(args) {
  if (!args || typeof args !== "object") {
    return null;
  }
  const candidate = typeof args.path === "string"
    ? args.path
    : typeof args.file === "string"
      ? args.file
      : null;
  if (!candidate) {
    return null;
  }
  const bounded = boundedValue(candidate, { maxString: 300 });
  return typeof bounded === "string" && bounded.trim() ? bounded : null;
}

// Compact run progress: a coarse phase derived from the run state machine,
// the timestamp of the latest observed activity, and the latest tool's
// name/status plus a safe target (path/file) when known. No ETA is invented.
export function runProgress(job) {
  if (!job) {
    return null;
  }
  const lastEvent = job.events?.length ? job.events[job.events.length - 1] : null;
  let lastActivityAt = null;
  for (const candidate of [lastEvent?.at, job.lastTool?.at, job.settledAt, job.startedAt]) {
    if (!candidate) {
      continue;
    }
    if (lastActivityAt === null || Date.parse(candidate) > Date.parse(lastActivityAt)) {
      lastActivityAt = candidate;
    }
  }
  const progress = {
    phase: phaseFor(job),
    last_activity_at: lastActivityAt
  };
  const tool = job.lastTool;
  if (tool && typeof tool.name === "string") {
    const latest = { name: tool.name, status: tool.status };
    if (tool.target) {
      latest.target = tool.target;
    }
    progress.latest_tool = latest;
  }
  return progress;
}

// Compact progress phase derived from the run state machine. Phases explicitly
// distinguish model work (model_working/model_awaiting_input), extension cleanup
// and final collection (cleanup, reached while collecting or once the model
// stopped), and settlement. latest_tool information is preserved separately.
function phaseFor(job) {
  switch (job.status) {
    case "accepted":
      return "starting";
    case "running":
      return job.modelStatus === "stopped"
        ? "cleanup"
        : job.uiRequests && job.uiRequests.size > 0
          ? "model_awaiting_input"
          : "model_working";
    case "collecting":
      return "cleanup";
    case "cancelling":
      return "cancelling";
    case "settled":
      return "settled";
    case "error":
      return "error";
    default:
      return String(job.status);
  }
}

function usageNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// Extract real, billed assistant usage from a Pi message_end message. Synthetic
// failure/abort messages carry an all-zero usage object and are not model
// calls, so they are filtered out here.
export function usageFromMessage(message) {
  if (!message || message.role !== "assistant" || !message.usage || typeof message.usage !== "object") {
    return null;
  }
  const usage = message.usage;
  const input = usageNumber(usage.input);
  const output = usageNumber(usage.output);
  const cacheRead = usageNumber(usage.cacheRead);
  const cacheWrite = usageNumber(usage.cacheWrite);
  const reasoning = usageNumber(usage.reasoning);
  // Pi reports reasoning as a subset of output, so do not add it again when
  // reconstructing a missing provider total.
  const total = usageNumber(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  const cost = usageNumber(usage.cost?.total);
  if (total <= 0 && cost <= 0) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite, reasoning, total, cost };
}

// Compact run statistics aggregated from assistant message_end events exactly
// once per completed assistant message. turn_end and other events never
// contribute. The provider/model breakdown is bounded.
export function runStats(job) {
  if (!job) {
    return null;
  }
  const tokens = job.stats?.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  let elapsedMs = 0;
  if (typeof job.startedAt === "string") {
    const endedAt = typeof job.settledAt === "string" ? Date.parse(job.settledAt) : Date.now();
    const diff = endedAt - Date.parse(job.startedAt);
    if (Number.isFinite(diff) && diff >= 0) {
      elapsedMs = diff;
    }
  }
  const models = Array.from(job.stats?.models?.values() || [])
    .map(({ key, provider, model, model_calls, tokens: bucketTokens, cost }) => ({
      provider: key === OTHER_MODEL_BUCKET ? "other" : provider,
      model: key === OTHER_MODEL_BUCKET ? null : model,
      model_calls,
      usage_total: bucketTokens,
      cost
    }))
    .sort((left, right) => right.cost - left.cost || right.usage_total - left.usage_total)
    .slice(0, MAX_MODEL_BUCKETS);
  return {
    elapsed_ms: elapsedMs,
    model_calls: job.stats?.modelCalls || 0,
    usage: {
      input: tokens.input,
      output: tokens.output,
      cache_read: tokens.cacheRead,
      cache_write: tokens.cacheWrite,
      reasoning: tokens.reasoning,
      total: tokens.total
    },
    cost: job.stats?.cost || 0,
    models
  };
}

// Compact-by-default run snapshot. The compact form keeps everything needed to
// continue (ids, status, timing, errors, bounded progress, compact usage
// statistics, pending UI requests) without the diagnostic payload;
// includeDetails restores bounded diagnostics. tool_calls is intentionally
// omitted because it is fully redundant with the bounded recent_events stream
// (tool_execution_start/end summaries). The final assistant text is an answer
// channel owned by the MCP server, never a structured run diagnostic.
function diagnosticRunResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const { assistant_text: _assistantText, ...diagnostics } = result;
  return Object.keys(diagnostics).length > 0 ? diagnostics : null;
}

export function jobSnapshot(job, options = {}) {
  if (!job) {
    return null;
  }
  const includeDetails = Boolean(options.includeDetails);
  const output = {
    run_id: job.id,
    // run status is kept explicit next to the session-level process_status,
    // and model/cleanup lifecycle are tracked separately from run settlement.
    status: job.status,
    model_status: job.modelStatus && MODEL_STATUS.has(job.modelStatus) ? job.modelStatus : "idle",
    cleanup_status: job.cleanupStatus && CLEANUP_STATUS.has(job.cleanupStatus) ? job.cleanupStatus : "pending",
    started_at: job.startedAt,
    settled_at: job.settledAt || null,
    prompt_kind: job.kind,
    error: job.error || null,
    // Bridge-observed model stop reason (stop/toolUse/error/aborted) from the
    // latest assistant message; never a substitute for run settlement.
    stop_reason: job.stopReason || null,
    pending_ui_requests: Array.from(job.uiRequests.values()),
    progress: runProgress(job),
    stats: runStats(job)
  };
  if (job.budget) {
    output.budget = {
      max_elapsed_seconds: job.budget.maxElapsedSeconds,
      max_model_calls: job.budget.maxModelCalls,
      max_cost: job.budget.maxCost
    };
    output.budget_exceeded = job.budget.exceeded || null;
  }
  if (includeDetails) {
    output.result = diagnosticRunResult(job.result);
    output.streamed_message_updates = job.messageUpdates;
    output.recent_events = job.events.slice(-30);
  }
  return output;
}

// Minimal pi_sessions directory entry for a live session. The directory form
// carries only what is needed to pick a session or a run: identity, explicit
// process_status plus the legacy lifecycle alias, workspace, profile,
// timestamps, the active run id/status, and the count of pending extension UI
// requests. Diagnostics (model, thinking level, streaming state, protocol
// warnings, full pending UI requests, session file, job snapshot) stay in
// liveSummary for include_details=true and pi_status.
export function liveDirectoryEntry(session) {
  const activeJob = session.job && ACTIVE_JOB_STATES.has(session.job.status)
    ? session.job
    : null;
  return {
    session_id: session.id,
    lifecycle: session.lifecycle,
    process_status: session.lifecycle,
    workspace: session.workspace,
    profile: session.profile.id,
    created_at: session.createdAt,
    pi_session_id: session.state?.sessionId || null,
    pi_session_name: session.state?.sessionName || null,
    active_run: activeJob ? { run_id: activeJob.id, status: activeJob.status } : null,
    pending_ui_request_count: session.uiRequests.size
  };
}

// Minimal pi_sessions directory entry for a saved Pi session. Small
// identification fields derived from a bounded prefix of the session file (a
// redacted session name from a real session_info entry when one exists, plus
// a redacted one-line first-task preview from the first user message) are
// always visible so several sessions from one workspace stay distinguishable.
// The session file path is never exposed; byte size is diagnostic and
// returned only when includeDetails is set.
export function savedDirectoryEntry(saved, includeDetails = false) {
  const entry = {
    pi_session_id: saved.pi_session_id,
    workspace: saved.workspace,
    created_at: saved.created_at,
    modified_at: saved.modified_at,
    name: saved.name || null,
    summary: saved.summary || null
  };
  if (includeDetails && typeof saved.bytes === "number") {
    entry.bytes = saved.bytes;
  }
  return entry;
}

// Shared saved-session identity sanitizer: secrets are redacted, whitespace is
// collapsed to a single line, the result is trimmed, and the length is capped
// at SESSION_PREVIEW_CHARS Unicode code points (surrogate pairs are never
// split) with an explicit ellipsis. Applied to both the session name and the
// first-task preview so every surfaced identity field stays compact and one
// line.
function identityText(text) {
  const collapsed = redactText(text).replace(/\s+/g, " ").trim();
  const points = Array.from(collapsed);
  return points.length > SESSION_PREVIEW_CHARS
    ? points.slice(0, SESSION_PREVIEW_CHARS).join("") + "…"
    : collapsed;
}

// Bounded, redacted first-task preview from a user message: the first text
// block, run through identityText. Returns null when the message carries no
// usable text. Only user text is ever surfaced — never assistant or tool
// output.
function previewText(message) {
  const content = message?.content;
  let text = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && typeof block.text === "string" && block.text.trim()) {
        text = block.text;
        break;
      }
    }
  }
  if (!text) {
    return null;
  }
  return identityText(text) || null;
}

// A session name from any accepted entry shape: the real Pi session_info entry
// ({type:"session_info", name}), a defensive nested data.name, and a future
// name on the session header itself ({type:"session", name}). Sanitized with
// identityText; null when absent or empty after sanitizing.
function sessionName(entry) {
  if (!entry || typeof entry !== "object" || (entry.type !== "session" && entry.type !== "session_info")) {
    return null;
  }
  let raw = typeof entry.name === "string" ? entry.name : null;
  if (raw === null && entry.data && typeof entry.data === "object" && typeof entry.data.name === "string") {
    raw = entry.data.name;
  }
  if (raw === null) {
    return null;
  }
  return identityText(raw) || null;
}

// Small saved-session header plus identity from ONE bounded prefix read
// of the JSONL file: the required first-line session header, an explicit Pi session
// name when any session_info/header entry carries one (the latest within the
// prefix wins, whether it occurs before or after the first user message), and
// a short first-task preview from the first user message. Only
// SESSION_PREVIEW_BYTES are read, so listings stay fast; malformed, truncated,
// or concurrently written lines are skipped. File paths, tool output,
// assistant output, and unbounded transcript text never enter the identity.
async function readSessionPrefix(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(SESSION_PREVIEW_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SESSION_PREVIEW_BYTES, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    const identity = { name: null, summary: null };
    let header;
    try {
      header = JSON.parse((lines[0] || "").replace(/\r$/, ""));
    } catch (error) {
      return { header: null, identity };
    }
    if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
      return { header: null, identity };
    }
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        // A truncated or corrupt line must not hide the rest of the prefix.
        continue;
      }
      const name = sessionName(entry);
      if (name !== null) {
        identity.name = name;
      }
      if (identity.summary === null && entry?.type === "message" && entry.message?.role === "user") {
        identity.summary = previewText(entry.message);
      }
    }
    return { header, identity };
  } finally {
    await handle.close();
  }
}

// Directly reusable pi_wait/pi_status arguments for continuation after any
// accepted operation or timeout. Always carries session_id; run_id is included
// when a run exists. Both referenced tools are registered in every toolset
// (core and full), so returned continuations are always usable by the client.
function continuationFor(sessionId, runId) {
  return {
    pi_wait: runId ? { session_id: sessionId, run_id: runId } : { session_id: sessionId },
    pi_status: { session_id: sessionId }
  };
}

function jobAnswer(job) {
  const answer = job?.result?.assistant_text;
  return typeof answer === "string" && answer.trim() ? answer : null;
}

function createCompletion() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve, settled: false };
}

function resolveCompletion(job) {
  if (!job?.completion || job.completion.settled || !TERMINAL_JOB_STATES.has(job.status)) {
    return;
  }
  job.completion.settled = true;
  job.completion.resolve(job);
}

// Backward-compatible optional run budgets on high-level tools. Each limit is
// validated positive and bounded; budgets are never defaulted on. A nested
// budget object with the same meanings is also accepted.
function parseBudget(input) {
  const source = input?.budget && typeof input.budget === "object" && !Array.isArray(input.budget)
    ? {
      max_elapsed_seconds: input.max_elapsed_seconds ?? input.budget.max_elapsed_seconds,
      max_model_calls: input.max_model_calls ?? input.budget.max_model_calls,
      max_cost: input.max_cost ?? input.budget.max_cost
    }
    : input || {};
  const limits = [
    ["max_elapsed_seconds", "maxElapsedSeconds", 86400, false],
    ["max_model_calls", "maxModelCalls", 1000000, true],
    ["max_cost", "maxCost", 10000, false]
  ];
  const budget = { maxElapsedSeconds: null, maxModelCalls: null, maxCost: null };
  let present = false;
  for (const [key, field, maximum, integerOnly] of limits) {
    const value = source[key];
    if (value === undefined || value === null) {
      continue;
    }
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > maximum || (integerOnly && !Number.isInteger(number))) {
      throw new PiWslError(
        "invalid_budget",
        key + " must be a positive " + (integerOnly ? "integer" : "number") + " bounded by " + maximum + "."
      );
    }
    budget[field] = number;
    present = true;
  }
  return present ? budget : null;
}

// Which budget limit has fired for this run, if any. Fires at most once per
// run: cancelRequested latches after the first exceeded limit.
function budgetLimitFired(job) {
  if (!job?.budget || job.budget.cancelRequested) {
    return null;
  }
  if (job.budget.maxElapsedSeconds !== null && typeof job.startedAt === "string") {
    const elapsedSeconds = (Date.now() - Date.parse(job.startedAt)) / 1000;
    if (Number.isFinite(elapsedSeconds) && elapsedSeconds >= job.budget.maxElapsedSeconds) {
      return "elapsed";
    }
  }
  if (job.budget.maxModelCalls !== null && (job.stats?.modelCalls || 0) >= job.budget.maxModelCalls) {
    return "model_calls";
  }
  if (job.budget.maxCost !== null && (job.stats?.cost || 0) >= job.budget.maxCost) {
    return "cost";
  }
  return null;
}

function clearBudgetTimer(job) {
  if (job?.budgetTimer) {
    clearTimeout(job.budgetTimer);
    job.budgetTimer = null;
  }
}

function scheduleElapsedBudget(session, job) {
  if (job?.budget?.maxElapsedSeconds === null || job?.budget?.maxElapsedSeconds === undefined) {
    return;
  }
  const delayMs = Math.max(1, Math.ceil(job.budget.maxElapsedSeconds * 1000));
  job.budgetTimer = setTimeout(() => {
    job.budgetTimer = null;
    if (session.job === job) {
      checkRunBudget(session);
    }
  }, delayMs);
  job.budgetTimer.unref?.();
}

// Convergence guard for optional run budgets. When a limit is exceeded while
// the run is still active, request cancellation exactly once, report which
// limit fired, and move the run to cancelling. Pi then settles it through the
// normal agent_settled -> collection path; no further cancels are issued even
// if the run keeps producing events before it settles.
function checkRunBudget(session) {
  const job = session?.job;
  if (!job || !ACTIVE_JOB_STATES.has(job.status)) {
    return;
  }
  const limit = budgetLimitFired(job);
  if (!limit) {
    return;
  }
  job.budget.exceeded = limit;
  job.budget.cancelRequested = true;
  job.status = "cancelling";
  clearBudgetTimer(job);
  job.events.push({ type: "budget_exceeded", limit, at: now() });
  void (session.rpc?.command?.({ type: "abort" }) || Promise.resolve()).catch(() => {});
}

function activeProcessCount(sessions) {
  return Array.from(sessions.values()).filter((session) => session.lifecycle === "running").length;
}

// Translate a raw provider/model failure into an actionable, redacted error
// message. The known DeepSeek Responses conflict (a function tool named
// `search` next to the server-side web_search injection) gets explicit
// remediation guidance instead of a raw 400 echo; everything else is redacted
// and reported as observed.
export function actionableRunError(job) {
  const raw = typeof job?.stopErrorMessage === "string" ? job.stopErrorMessage : "";
  if (/conflicts with server side web_search/i.test(raw)) {
    return "Pi's model provider rejected the run: the function tool named \"search\" conflicts with the provider's server-side web_search. Use the research or review profile (they exclude that tool automatically), or exclude/rename the conflicting \"search\" tool for this session (for example pi --exclude-tools search), or disable the provider's server-side web_search.";
  }
  if (raw) {
    return redactText(raw);
  }
  return "Pi ended the run with stop_reason=error.";
}

// User-facing error for a run that ended because an optional budget limit
// fired before a final answer was collected. The message names the limit and
// how to retry; raw provider text is never included. The effective budget
// fields stay in the structured snapshot (budget/budget_exceeded).
export function budgetExhaustedError(job) {
  const field = job?.budget?.exceeded === "model_calls"
    ? "max_model_calls"
    : job?.budget?.exceeded === "elapsed"
      ? "max_elapsed_seconds"
      : job?.budget?.exceeded === "cost"
        ? "max_cost"
        : null;
  return field
    ? "Pi's " + field + " budget was exhausted before a final answer was collected, so the run was cancelled without an answer. Retry without that budget limit, or with a higher " + field + "."
    : "Pi's budget was exhausted before a final answer was collected, so the run was cancelled without an answer. Retry without the budget limit, or with a higher limit.";
}

// After agent_settled, a run is only a real success when the model did not
// stop with an error AND a final assistant answer text was actually
// collected. An empty answer, a stop_reason=error, or a failed collection all
// make the run an error: agent_settled alone is never treated as success.
// A run cancelled by an exhausted optional budget is reported with a
// budget-specific error instead of the generic no-answer text.
function settleRun(job) {
  if (job.stopReason === "error") {
    job.status = "error";
    job.error = actionableRunError(job);
    return;
  }
  const answer = typeof job.result?.assistant_text === "string" && job.result.assistant_text.trim()
    ? job.result.assistant_text
    : null;
  if (!answer) {
    job.status = "error";
    if (job.budget?.exceeded) {
      job.error = budgetExhaustedError(job);
      return;
    }
    job.error = "Pi settled the run without producing an answer text." + (job.stopReason ? " (stop_reason=" + job.stopReason + ")" : "");
    return;
  }
  job.status = "settled";
}

// Record the model's stop reason and raw error text from the latest assistant
// message. agent_settled alone never decides success: a stop_reason=error (for
// example a provider 400) is a bridge-observed model failure, and the raw
// error message feeds the actionable run error.
function trackStopState(job, message) {
  if (!job || !message || message.role !== "assistant") {
    return;
  }
  if (typeof message.stopReason === "string" && message.stopReason) {
    job.stopReason = message.stopReason;
  }
  if (typeof message.errorMessage === "string" && message.errorMessage) {
    job.stopErrorMessage = message.errorMessage;
  }
}

export class PiService {
  constructor(config = createConfig()) {
    this.config = config;
    this.allowedRoots = [];
    this.defaultWorkspace = "";
    this.sessionRoot = "";
    this.sessions = new Map();
  }

  async initialize() {
    this.allowedRoots = await canonicalRoots(this.config.allowedRootInputs);
    this.defaultWorkspace = await canonicalDirectory(this.config.defaultWorkspace, this.allowedRoots, "default workspace");
    const sessionRootNormalized = normalizeWslPath(this.config.sessionRootInput, "Pi session root");
    try {
      this.sessionRoot = await fs.realpath(sessionRootNormalized);
    } catch (error) {
      throw new PiWslError("invalid_configuration", "Pi session root does not exist: " + sessionRootNormalized);
    }
    const sessionRootStat = await fs.stat(this.sessionRoot);
    if (!sessionRootStat.isDirectory()) {
      throw new PiWslError("invalid_configuration", "Pi session root is not a directory.");
    }
    // Bare command names resolve through the inherited interactive zsh PATH;
    // absolute paths (WSL or Windows drive paths) are normalized and checked.
    this.config.piBin = await resolveExecutable(this.config.piBin, "Pi binary");
    return this.diagnostics();
  }

  diagnostics() {
    return {
      pi_bin: this.config.piBin,
      default_workspace: this.defaultWorkspace,
      allowed_roots: this.allowedRoots,
      session_root: this.sessionRoot,
      max_live_sessions: this.config.maxSessions,
      profiles: Object.values(PROFILES).map((profile) => ({
        id: profile.id,
        title: profile.title,
        description: profile.description,
        tool_count: profile.tools?.length || null
      }))
    };
  }

  async resolveWorkspace(input) {
    return canonicalDirectory(input || this.defaultWorkspace, this.allowedRoots);
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new PiWslError("unknown_session", "No live Pi session exists with id " + sessionId + ".");
    }
    return session;
  }

  liveSummary(session, jobOptions = null) {
    const runTerminal = Boolean(session.job && TERMINAL_JOB_STATES.has(session.job.status));
    const result = {
      session_id: session.id,
      lifecycle: session.lifecycle,
      process_status: session.lifecycle,
      workspace: session.workspace,
      profile: session.profile.id,
      created_at: session.createdAt,
      pi_session_id: session.state?.sessionId || null,
      pi_session_name: session.state?.sessionName || null,
      pi_session_file: session.state?.sessionFile || null,
      model: session.state?.model
        ? { provider: session.state.model.provider, id: session.state.model.id }
        : null,
      thinking_level: session.state?.thinkingLevel || null,
      // Once the active run is terminal, is_streaming is false even if Pi's
      // own state is stale. The session process may keep running; that is a
      // separate axis (process_status/lifecycle).
      is_streaming: runTerminal ? false : Boolean(session.state?.isStreaming),
      model_status: session.job && MODEL_STATUS.has(session.job.modelStatus) ? session.job.modelStatus : null,
      cleanup_status: session.job && CLEANUP_STATUS.has(session.job.cleanupStatus) ? session.job.cleanupStatus : null,
      protocol_warnings: session.rpc.protocolWarnings.slice(-5),
      pending_ui_requests: Array.from(session.uiRequests.values())
    };
    if (jobOptions) {
      const options = jobOptions === true ? { includeDetails: true } : jobOptions;
      result.job = jobSnapshot(session.job, options);
    }
    return boundedValue(result, { maxDepth: 8, maxItems: 80, maxString: this.config.resultLimit });
  }

  syncState(session, response) {
    if (response?.data && typeof response.data === "object") {
      session.state = response.data;
    }
    return session.state;
  }

  attach(session) {
    session.rpc.on("event", (event) => this.handleEvent(session, event));
    session.rpc.on("failure", (error) => {
      session.lifecycle = "faulted";
      if (session.job && ACTIVE_JOB_STATES.has(session.job.status)) {
        clearBudgetTimer(session.job);
        session.job.status = "error";
        if (session.job.modelStatus === "running") {
          session.job.modelStatus = "failed";
        }
        if (session.job.cleanupStatus !== "completed") {
          session.job.cleanupStatus = "failed";
        }
        session.job.error = error.message;
        session.job.settledAt = now();
        resolveCompletion(session.job);
      }
    });
    session.rpc.on("exit", () => {
      if (session.lifecycle === "running") {
        session.lifecycle = "closed";
      }
      if (session.job && ACTIVE_JOB_STATES.has(session.job.status)) {
        clearBudgetTimer(session.job);
        session.job.status = "error";
        if (session.job.modelStatus === "running") {
          session.job.modelStatus = "failed";
        }
        if (session.job.cleanupStatus !== "completed") {
          session.job.cleanupStatus = "failed";
        }
        session.job.error ||= "Pi process exited before the run settled.";
        session.job.settledAt = now();
        resolveCompletion(session.job);
      }
    });
  }

  handleEvent(session, event) {
    const job = session.job;
    const summary = summarizeEvent(event);
    if (job) {
      if (event?.type === "message_update") {
        job.messageUpdates += 1;
        const previous = job.events[job.events.length - 1];
        if (previous?.type === "message_streaming") {
          previous.update_count += 1;
          previous.at = summary.at;
        } else {
          job.events.push({ type: "message_streaming", at: summary.at, update_count: 1 });
        }
      } else {
        job.events.push(summary);
        if (event?.type === "tool_execution_start") {
          job.toolCalls.push({
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            at: summary.at,
            arguments: summary.arguments
          });
          if (job.toolCalls.length > 60) {
            job.toolCalls.shift();
          }
          job.lastTool = {
            name: event.toolName,
            status: "running",
            at: summary.at,
            target: toolTarget(event.args)
          };
        } else if (event?.type === "tool_execution_end") {
          const status = event.isError ? "failed" : "completed";
          if (job.lastTool && job.lastTool.name === event.toolName) {
            job.lastTool.status = status;
            job.lastTool.at = summary.at;
          } else {
            job.lastTool = { name: event.toolName, status, at: summary.at, target: null };
          }
        } else if (event?.type === "message_end") {
          this.aggregateMessageUsage(job, event.message);
        }
        if (event?.type === "message_start" || event?.type === "message_end" || event?.type === "turn_end") {
          trackStopState(job, event.message);
        } else if (event?.type === "agent_end" && Array.isArray(event.messages)) {
          for (const message of event.messages) {
            trackStopState(job, message);
          }
        }
      }
      if (job.events.length > 120) {
        job.events.shift();
      }
    }
    if (event?.type === "extension_ui_request" &&
      typeof event.id === "string" &&
      INTERACTIVE_UI_METHODS.has(event.method)
    ) {
      const request = {
        id: event.id,
        method: event.method,
        title: event.title,
        message: event.message,
        placeholder: event.placeholder,
        options: Array.isArray(event.options) ? event.options.slice(0, 30) : undefined,
        timeout: event.timeout,
        at: now()
      };
      session.uiRequests.set(event.id, boundedValue(request, { maxString: 3000 }));
      if (job) {
        job.uiRequests.set(event.id, session.uiRequests.get(event.id));
      }
    } else if (event?.type === "extension_ui_request" && NOTIFICATION_UI_METHODS.has(event.method)) {
      // Non-interactive status notifications (setStatus/notify/setWidget):
      // fire-and-forget. They never become pending requests and never mutate
      // run/model/cleanup state, so a late notification cannot keep a
      // completed model or run active or reset terminal state.
    }
    if (event?.type === "agent_start" && job && ACTIVE_JOB_STATES.has(job.status)) {
      job.status = "running";
      job.modelStatus = "running";
    }
    if (event?.type === "agent_end" && job && ACTIVE_JOB_STATES.has(job.status)) {
      // The model stopped (agent_end may carry willRetry, so a later
      // agent_start legitimately resumes it). This is NOT settlement: the run
      // stays active until agent_settled and final collection complete.
      job.modelStatus = "stopped";
    }
    if (event?.type === "agent_settled" && job && ACTIVE_JOB_STATES.has(job.status)) {
      clearBudgetTimer(job);
      job.status = "collecting";
      job.cleanupStatus = "running";
      job.settledAt = now();
      void this.collectFinalResult(session, job);
    }
    checkRunBudget(session);
  }

  async collectFinalResult(session, job) {
    try {
      const response = await session.rpc.command({ type: "get_last_assistant_text" }, this.config.commandTimeoutMs);
      if (session.job !== job) {
        return;
      }
      job.result = {
        assistant_text: response?.data?.text ?? null
      };
      job.cleanupStatus = "completed";
      settleRun(job);
    } catch (error) {
      if (session.job !== job) {
        return;
      }
      job.status = "error";
      job.cleanupStatus = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
    resolveCompletion(job);
  }

  async startSession(input = {}) {
    if (activeProcessCount(this.sessions) >= this.config.maxSessions) {
      throw new PiWslError(
        "session_limit_reached",
        "The Pi WSL MCP has reached its " + this.config.maxSessions + " live-session limit. Close a session before starting another."
      );
    }
    const workspace = await this.resolveWorkspace(input.workspace);
    const profile = profileFor(input.profile);
    const rpc = new PiRpcProcess({
      piBin: this.config.piBin,
      cwd: workspace,
      profile,
      sessionPath: input.sessionPath,
      startupTimeoutMs: this.config.startupTimeoutMs,
      commandTimeoutMs: this.config.commandTimeoutMs
    });
    const session = {
      id: createId("pi"),
      workspace,
      profile,
      rpc,
      lifecycle: "starting",
      createdAt: now(),
      state: null,
      job: null,
      uiRequests: new Map()
    };
    this.sessions.set(session.id, session);
    this.attach(session);
    try {
      const stateResponse = await rpc.start();
      this.syncState(session, stateResponse);
      session.lifecycle = "running";
      if (input.provider || input.model) {
        if (!input.provider || !input.model) {
          throw new PiWslError("invalid_model", "provider and model must be set together.");
        }
        const modelResponse = await rpc.command({
          type: "set_model",
          provider: input.provider,
          modelId: input.model
        });
        session.state = { ...session.state, model: modelResponse.data };
      }
      if (input.thinking) {
        await rpc.command({ type: "set_thinking_level", level: input.thinking });
        session.state = { ...session.state, thinkingLevel: input.thinking };
      }
      if (input.name) {
        await rpc.command({ type: "set_session_name", name: input.name });
        session.state = { ...session.state, sessionName: input.name };
      }
      return this.liveSummary(session, true);
    } catch (error) {
      this.sessions.delete(session.id);
      await rpc.close();
      throw error;
    }
  }

  // Aggregate real assistant message_end usage into the job's compact stats
  // exactly once per completed, billed assistant message. turn_end and every
  // other event type never contribute, so there is no double counting.
  aggregateMessageUsage(job, message) {
    const usage = usageFromMessage(message);
    if (!usage) {
      return;
    }
    job.stats.modelCalls += 1;
    job.stats.tokens.input += usage.input;
    job.stats.tokens.output += usage.output;
    job.stats.tokens.cacheRead += usage.cacheRead;
    job.stats.tokens.cacheWrite += usage.cacheWrite;
    job.stats.tokens.reasoning += usage.reasoning;
    job.stats.tokens.total += usage.total;
    job.stats.cost += usage.cost;
    const provider = typeof message.provider === "string" && message.provider
      ? message.provider
      : "unknown";
    const model = typeof message.responseModel === "string" && message.responseModel
      ? message.responseModel
      : typeof message.model === "string" && message.model
        ? message.model
        : "unknown";
    let key = provider + "/" + model;
    let bucket = job.stats.models.get(key);
    if (!bucket) {
      const namedBucketLimit = MAX_MODEL_BUCKETS - 1;
      if (job.stats.models.size >= namedBucketLimit) {
        key = OTHER_MODEL_BUCKET;
        bucket = job.stats.models.get(key);
      }
      if (!bucket) {
        bucket = {
          key,
          provider: key === OTHER_MODEL_BUCKET ? "other" : provider,
          model: key === OTHER_MODEL_BUCKET ? null : model,
          model_calls: 0,
          tokens: 0,
          cost: 0
        };
        job.stats.models.set(key, bucket);
      }
    }
    bucket.model_calls += 1;
    bucket.tokens += usage.total;
    bucket.cost += usage.cost;
  }

  // Default high-level workflows are synchronous one-shot calls. They own an
  // ephemeral Pi process, await the run's settlement event, return only the
  // final answer/error contract, and release the process before returning.
  async runOnce(input) {
    const started = await this.startSession(input);
    const session = this.getSession(started.session_id);
    try {
      await this.send({
        session_id: session.id,
        message: input.message,
        behavior: "prompt",
        max_elapsed_seconds: input.max_elapsed_seconds,
        max_model_calls: input.max_model_calls,
        max_cost: input.max_cost,
        budget: input.budget
      });
      const job = session.job;
      if (job && ACTIVE_JOB_STATES.has(job.status)) {
        await job.completion.promise;
      }
      return {
        status: job?.status === "settled" ? "completed" : "failed",
        answer: jobAnswer(job),
        error: job?.status === "error" ? job.error || "Pi run failed." : null
      };
    } finally {
      try {
        await this.close({ session_id: session.id });
      } catch {
        // A process that failed or exited while producing the terminal result
        // may already be closed.
      }
    }
  }

  async send(input) {
    const session = this.getSession(input.session_id);
    if (session.lifecycle !== "running") {
      throw new PiWslError("pi_not_running", "This Pi session is " + session.lifecycle + ".");
    }
    const behavior = input.behavior || "prompt";
    const existing = session.job;
    if (behavior === "prompt") {
      if (existing && ACTIVE_JOB_STATES.has(existing.status)) {
        throw new PiWslError(
          "pi_busy",
          "Pi is still working. Use behavior=steer or behavior=follow_up, or wait for run " + existing.id + "."
        );
      }
      const job = {
        id: createId("run"),
        status: "accepted",
        kind: "prompt",
        modelStatus: "idle",
        cleanupStatus: "pending",
        budget: parseBudget(input),
        startedAt: now(),
        settledAt: null,
        events: [],
        uiRequests: new Map(),
        toolCalls: [],
        lastTool: null,
        messageUpdates: 0,
        result: null,
        error: null,
        completion: createCompletion(),
        stats: {
          modelCalls: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
          cost: 0,
          models: new Map()
        }
      };
      session.job = job;
      scheduleElapsedBudget(session, job);
      try {
        await session.rpc.command({ type: "prompt", message: input.message });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (session.job === job) {
          clearBudgetTimer(job);
          job.status = "error";
          job.cleanupStatus = "failed";
          job.error = message;
          job.settledAt = now();
          resolveCompletion(job);
        }
        const code = error instanceof PiWslError ? error.code : "prompt_failed";
        const priorDetails = error instanceof PiWslError &&
          error.details &&
          typeof error.details === "object" &&
          !Array.isArray(error.details)
          ? error.details
          : {};
        throw new PiWslError(code, message, {
          ...priorDetails,
          accepted_result: {
            answer: null,
            session_id: session.id,
            run_id: job.id,
            session: this.liveSummary(session, false),
            run: jobSnapshot(job),
            continuation: continuationFor(session.id, job.id)
          }
        });
      }
      return {
        session_id: session.id,
        ...jobSnapshot(job),
        continuation: continuationFor(session.id, job.id)
      };
    }

    if (!existing || !ACTIVE_JOB_STATES.has(existing.status)) {
      throw new PiWslError("no_active_run", "No active Pi run is available for " + behavior + ".");
    }
    const command = behavior === "steer" ? "steer" : behavior === "follow_up" ? "follow_up" : null;
    if (!command) {
      throw new PiWslError("invalid_behavior", "behavior must be prompt, steer, or follow_up.");
    }
    await session.rpc.command({ type: command, message: input.message });
    existing.events.push({ type: command + "_accepted", at: now() });
    return {
      session_id: session.id,
      ...jobSnapshot(existing),
      continuation: continuationFor(session.id, existing.id)
    };
  }

  async wait(input) {
    const session = this.getSession(input.session_id);
    const job = session.job;
    if (!job || (input.run_id && input.run_id !== job.id)) {
      throw new PiWslError("unknown_run", "No matching current run exists for this Pi session.");
    }
    const maxWaitSeconds = this.config?.maxWaitSeconds ?? 285;
    const requestedSeconds = input.timeout_seconds ?? 120;
    const effectiveSeconds = Math.max(0, Math.min(requestedSeconds, maxWaitSeconds));
    const clamped = requestedSeconds > effectiveSeconds;
    if (ACTIVE_JOB_STATES.has(job.status) && effectiveSeconds > 0) {
      let timeout;
      try {
        await Promise.race([
          job.completion?.promise || Promise.resolve(),
          new Promise((resolve) => {
            timeout = setTimeout(resolve, effectiveSeconds * 1000);
          })
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    }
    const result = {
      timed_out: ACTIVE_JOB_STATES.has(job.status),
      session_id: session.id,
      run_id: job.id,
      answer: jobAnswer(job),
      session: this.liveSummary(session, false),
      run: jobSnapshot(job, { includeDetails: input.include_details }),
      continuation: continuationFor(session.id, job.id)
    };
    if (clamped) {
      result.wait = {
        requested_seconds: requestedSeconds,
        effective_seconds: effectiveSeconds,
        clamped: true,
        max_seconds: maxWaitSeconds
      };
    }
    return result;
  }

  async status(input) {
    const session = this.getSession(input.session_id);
    if (session.lifecycle === "running") {
      try {
        const response = await session.rpc.command({ type: "get_state" });
        this.syncState(session, response);
      } catch (error) {
        session.lifecycle = "faulted";
      }
    }
    const result = this.liveSummary(session, { includeDetails: Boolean(input.include_details) });
    // Keep status directly useful as a continuation point even when the
    // compact default omits diagnostic event/result payloads.
    result.continuation = continuationFor(session.id, session.job?.id);
    return result;
  }

  async cancel(input) {
    const session = this.getSession(input.session_id);
    const job = session.job;
    if (!job || !ACTIVE_JOB_STATES.has(job.status)) {
      throw new PiWslError("no_active_run", "No active Pi run can be cancelled.");
    }
    await session.rpc.command({ type: "abort" });
    clearBudgetTimer(job);
    job.status = "cancelling";
    job.events.push({ type: "abort_acknowledged", at: now() });
    return {
      session_id: session.id,
      ...jobSnapshot(job),
      continuation: continuationFor(session.id, job.id)
    };
  }

  async respondToUi(input) {
    const session = this.getSession(input.session_id);
    if (!session.uiRequests.has(input.request_id)) {
      throw new PiWslError("unknown_ui_request", "That UI request is not pending for this Pi session.");
    }
    const provided = [input.value !== undefined, input.confirmed !== undefined, input.cancelled === true].filter(Boolean).length;
    if (provided !== 1) {
      throw new PiWslError("invalid_ui_response", "Provide exactly one of value, confirmed, or cancelled.");
    }
    await session.rpc.respondToUi({
      id: input.request_id,
      value: input.value,
      confirmed: input.confirmed,
      cancelled: input.cancelled
    });
    session.uiRequests.delete(input.request_id);
    if (session.job) {
      session.job.uiRequests.delete(input.request_id);
    }
    return { session_id: session.id, request_id: input.request_id, delivered: true };
  }

  async history(input) {
    const session = this.getSession(input.session_id);
    const response = await session.rpc.command({ type: "get_entries", since: input.since_entry_id });
    const entries = Array.isArray(response?.data?.entries) ? response.data.entries : [];
    const limit = input.limit || this.config.historyLimit;
    const sliced = entries.slice(Math.max(0, entries.length - limit));
    return {
      session_id: session.id,
      leaf_id: response?.data?.leafId || null,
      total_entries: entries.length,
      entries: sliced.map((entry) => summarizeEntry(entry, Boolean(input.include_content)))
    };
  }

  async models(input) {
    const session = this.getSession(input.session_id);
    const response = await session.rpc.command({ type: "get_available_models" });
    const models = Array.isArray(response?.data?.models) ? response.data.models : [];
    return {
      session_id: session.id,
      models: boundedValue(models, { maxDepth: 5, maxItems: 300, maxString: 4000 })
    };
  }

  async setModel(input) {
    const session = this.getSession(input.session_id);
    const response = await session.rpc.command({
      type: "set_model",
      provider: input.provider,
      modelId: input.model
    });
    session.state = { ...session.state, model: response.data };
    return this.liveSummary(session, false);
  }

  async setThinking(input) {
    const session = this.getSession(input.session_id);
    await session.rpc.command({ type: "set_thinking_level", level: input.level });
    session.state = { ...session.state, thinkingLevel: input.level };
    return this.liveSummary(session, false);
  }

  async compact(input) {
    const session = this.getSession(input.session_id);
    const response = await session.rpc.command({
      type: "compact",
      customInstructions: input.instructions
    }, Math.max(this.config.commandTimeoutMs, 120000));
    return {
      session_id: session.id,
      compacted: true,
      result: boundedValue(response.data, { maxDepth: 8, maxItems: 80, maxString: this.config.resultLimit })
    };
  }

  async fork(input) {
    const session = this.getSession(input.session_id);
    const response = await session.rpc.command({ type: "fork", entryId: input.entry_id });
    const state = await session.rpc.command({ type: "get_state" });
    this.syncState(session, state);
    return {
      session: this.liveSummary(session, false),
      fork: boundedValue(response.data, { maxString: 6000 })
    };
  }

  async commands(input) {
    const session = this.getSession(input.session_id);
    const response = await session.rpc.command({ type: "get_commands" });
    return {
      session_id: session.id,
      commands: boundedValue(response?.data?.commands || [], { maxDepth: 6, maxItems: 200, maxString: 5000 })
    };
  }

  async close(input) {
    const session = this.getSession(input.session_id);
    await session.rpc.close();
    session.lifecycle = "closed";
    return {
      session_id: session.id,
      closed: true,
      pi_session_id: session.state?.sessionId || null,
      pi_session_file: session.state?.sessionFile || null
    };
  }

  async listSessions(input = {}) {
    const workspace = input.workspace ? await this.resolveWorkspace(input.workspace) : null;
    const limit = input.limit || this.config.maxSavedSessions;
    const saved = await this.scanSavedSessions(workspace, limit);
    return {
      live_sessions: Array.from(this.sessions.values()).map((session) =>
        input.include_details
          ? this.liveSummary(session, { includeDetails: true })
          : liveDirectoryEntry(session)
      ),
      saved_sessions: saved.map((entry) => savedDirectoryEntry(entry, input.include_details))
    };
  }

  async resume(input) {
    const saved = await this.findSavedSession(input.saved_session_id);
    const started = await this.startSession({
      workspace: saved.workspace,
      profile: input.profile || "workspace",
      sessionPath: saved.session_file,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
      name: input.name
    });
    return {
      resumed_from: {
        saved_session_id: saved.pi_session_id,
        workspace: saved.workspace,
        created_at: saved.created_at
      },
      session: started
    };
  }

  async resolveSavedSessionWorkspace(cwd) {
    return canonicalDirectory(cwd, this.allowedRoots, "saved Pi session workspace");
  }

  async scanSavedSessions(workspace, limit) {
    const fileCandidates = await this.walkSessionFiles(Math.max(limit * 4, 300));
    const inspected = [];
    for (const candidate of fileCandidates) {
      try {
        // One bounded prefix read per candidate yields both the validated
        // header and the small identity (name/summary) fields.
        const { header, identity } = await readSessionPrefix(candidate.file);
        if (!header) {
          continue;
        }
        let sessionWorkspace;
        try {
          sessionWorkspace = await this.resolveSavedSessionWorkspace(header.cwd);
        } catch (error) {
          continue;
        }
        if (workspace && sessionWorkspace !== workspace) {
          continue;
        }
        inspected.push({
          pi_session_id: header.id,
          workspace: sessionWorkspace,
          created_at: typeof header.timestamp === "string" ? header.timestamp : candidate.modified_at,
          modified_at: candidate.modified_at,
          bytes: candidate.bytes,
          session_file: candidate.file,
          name: identity.name,
          summary: identity.summary
        });
      } catch (error) {
        // A corrupt or concurrently-written session must not prevent listing the rest.
      }
      if (inspected.length >= limit) {
        break;
      }
    }
    return inspected.map(({ session_file, ...safe }) => safe);
  }

  async findSavedSession(piSessionId) {
    const fileCandidates = await this.walkSessionFiles(5000);
    for (const candidate of fileCandidates) {
      try {
        const headerLine = await readFirstLine(candidate.file);
        const header = JSON.parse(headerLine);
        if (header?.type !== "session" || header.id !== piSessionId || typeof header.cwd !== "string") {
          continue;
        }
        const workspace = await this.resolveSavedSessionWorkspace(header.cwd);
        const sessionFile = await canonicalFileWithin(candidate.file, this.sessionRoot, "saved Pi session");
        return {
          pi_session_id: header.id,
          workspace,
          created_at: typeof header.timestamp === "string" ? header.timestamp : candidate.modified_at,
          session_file: sessionFile
        };
      } catch (error) {
        // Continue searching when a single historical file is unusable.
      }
    }
    throw new PiWslError("saved_session_not_found", "No allowed saved Pi session exists with id " + piSessionId + ".");
  }

  async walkSessionFiles(maximum) {
    const candidates = [];
    const pending = [this.sessionRoot];
    while (pending.length > 0 && candidates.length < maximum) {
      const directory = pending.pop();
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        continue;
      }
      for (const entry of entries) {
        if (candidates.length >= maximum) {
          break;
        }
        const target = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          pending.push(target);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            const stat = await fs.stat(target);
            candidates.push({
              file: target,
              modified_at: stat.mtime.toISOString(),
              modified_ms: stat.mtimeMs,
              bytes: stat.size
            });
          } catch (error) {
            // Session file disappeared while listing.
          }
        }
      }
    }
    candidates.sort((left, right) => right.modified_ms - left.modified_ms);
    return candidates;
  }

  async shutdown() {
    await Promise.allSettled(Array.from(this.sessions.values()).map((session) => session.rpc.close()));
  }
}
