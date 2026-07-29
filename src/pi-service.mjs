import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import {
  boundedValue,
  canonicalDirectory,
  canonicalFileWithin,
  canonicalRoots,
  createConfig,
  createId,
  normalizeWslPath,
  PiLocalError,
  readFirstLine,
  sleep
} from "./util.mjs";
import { PiRpcProcess } from "./pi-rpc.mjs";

const ACTIVE_JOB_STATES = new Set(["accepted", "running", "collecting", "cancelling"]);
const INTERACTIVE_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

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
    tools: [
      "read", "grep", "find", "ls",
      "web_search", "fetch_content", "get_search_content",
      "knowledge_search", "kb_read",
      "session_search", "session_list", "session_read",
      "map", "search", "outline", "expand", "path"
    ]
  },
  research: {
    id: "research",
    title: "Read-only research",
    description: "Local read/search plus installed web, knowledge, and session search tools; no edit or shell tool.",
    tools: [
      "read", "grep", "find", "ls",
      "web_search", "fetch_content", "get_search_content",
      "knowledge_search", "kb_read",
      "session_search", "session_list", "session_read",
      "map", "search", "outline", "expand", "path"
    ]
  }
};

function now() {
  return new Date().toISOString();
}

function profileFor(profile) {
  const resolved = PROFILES[profile || "workspace"];
  if (!resolved) {
    throw new PiLocalError("invalid_profile", "Unknown Pi profile: " + profile);
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

function jobSnapshot(job, includeEvents = true) {
  if (!job) {
    return null;
  }
  const output = {
    run_id: job.id,
    status: job.status,
    started_at: job.startedAt,
    settled_at: job.settledAt || null,
    prompt_kind: job.kind,
    error: job.error || null,
    result: job.result || null,
    pending_ui_requests: Array.from(job.uiRequests.values()),
    tool_calls: job.toolCalls.slice(-30),
    streamed_message_updates: job.messageUpdates
  };
  if (includeEvents) {
    output.recent_events = job.events.slice(-30);
  }
  return output;
}

function activeProcessCount(sessions) {
  return Array.from(sessions.values()).filter((session) => session.lifecycle === "running").length;
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
      throw new PiLocalError("invalid_configuration", "Pi session root does not exist: " + sessionRootNormalized);
    }
    const sessionRootStat = await fs.stat(this.sessionRoot);
    if (!sessionRootStat.isDirectory()) {
      throw new PiLocalError("invalid_configuration", "Pi session root is not a directory.");
    }
    this.config.piBin = normalizeWslPath(this.config.piBin, "Pi binary");
    try {
      await fs.access(this.config.piBin, fsConstants.X_OK);
    } catch (error) {
      throw new PiLocalError("invalid_configuration", "Pi binary is not executable: " + this.config.piBin);
    }
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
      throw new PiLocalError("unknown_session", "No live Pi session exists with id " + sessionId + ".");
    }
    return session;
  }

  liveSummary(session, includeJob = false) {
    const result = {
      session_id: session.id,
      lifecycle: session.lifecycle,
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
      is_streaming: Boolean(session.state?.isStreaming),
      protocol_warnings: session.rpc.protocolWarnings.slice(-5),
      pending_ui_requests: Array.from(session.uiRequests.values())
    };
    if (includeJob) {
      result.job = jobSnapshot(session.job);
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
        session.job.status = "error";
        session.job.error = error.message;
        session.job.settledAt = now();
      }
    });
    session.rpc.on("exit", () => {
      if (session.lifecycle === "running") {
        session.lifecycle = "closed";
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
        }
      }
      if (job.events.length > 120) {
        job.events.shift();
      }
    }
    if (
      event?.type === "extension_ui_request" &&
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
    }
    if (event?.type === "agent_start" && job && ACTIVE_JOB_STATES.has(job.status)) {
      job.status = "running";
    }
    if (event?.type === "agent_settled" && job && ACTIVE_JOB_STATES.has(job.status)) {
      job.status = "collecting";
      job.settledAt = now();
      void this.collectFinalResult(session, job);
    }
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
      job.status = "settled";
    } catch (error) {
      if (session.job !== job) {
        return;
      }
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
    }
  }

  async startSession(input = {}) {
    if (activeProcessCount(this.sessions) >= this.config.maxSessions) {
      throw new PiLocalError(
        "session_limit_reached",
        "The Pi MCP has reached its " + this.config.maxSessions + " live-session limit. Close a session before starting another."
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
          throw new PiLocalError("invalid_model", "provider and model must be set together.");
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

  async task(input) {
    const session = await this.startSession(input);
    const dispatched = await this.send({
      session_id: session.session_id,
      message: input.message,
      behavior: "prompt"
    });
    if (input.wait_seconds && input.wait_seconds > 0) {
      return this.wait({
        session_id: session.session_id,
        run_id: dispatched.run_id,
        timeout_seconds: input.wait_seconds
      });
    }
    return {
      session: this.liveSummary(this.getSession(session.session_id), false),
      run: dispatched
    };
  }

  async send(input) {
    const session = this.getSession(input.session_id);
    if (session.lifecycle !== "running") {
      throw new PiLocalError("pi_not_running", "This Pi session is " + session.lifecycle + ".");
    }
    const behavior = input.behavior || "prompt";
    const existing = session.job;
    if (behavior === "prompt") {
      if (existing && ACTIVE_JOB_STATES.has(existing.status)) {
        throw new PiLocalError(
          "pi_busy",
          "Pi is still working. Use behavior=steer or behavior=follow_up, or wait for run " + existing.id + "."
        );
      }
      const job = {
        id: createId("run"),
        status: "accepted",
        kind: "prompt",
        startedAt: now(),
        settledAt: null,
        events: [],
        uiRequests: new Map(),
        toolCalls: [],
        messageUpdates: 0,
        result: null,
        error: null
      };
      session.job = job;
      try {
        await session.rpc.command({ type: "prompt", message: input.message });
      } catch (error) {
        if (session.job === job) {
          job.status = "error";
          job.error = error instanceof Error ? error.message : String(error);
          job.settledAt = now();
        }
        throw error;
      }
      return jobSnapshot(job);
    }

    if (!existing || !ACTIVE_JOB_STATES.has(existing.status)) {
      throw new PiLocalError("no_active_run", "No active Pi run is available for " + behavior + ".");
    }
    const command = behavior === "steer" ? "steer" : behavior === "follow_up" ? "follow_up" : null;
    if (!command) {
      throw new PiLocalError("invalid_behavior", "behavior must be prompt, steer, or follow_up.");
    }
    await session.rpc.command({ type: command, message: input.message });
    existing.events.push({ type: command + "_accepted", at: now() });
    return jobSnapshot(existing);
  }

  async wait(input) {
    const session = this.getSession(input.session_id);
    const job = session.job;
    if (!job || (input.run_id && input.run_id !== job.id)) {
      throw new PiLocalError("unknown_run", "No matching current run exists for this Pi session.");
    }
    const timeoutMs = Math.max(0, Math.min((input.timeout_seconds ?? 120) * 1000, 300000));
    const deadline = Date.now() + timeoutMs;
    while (ACTIVE_JOB_STATES.has(job.status) && Date.now() < deadline) {
      await sleep(Math.min(350, Math.max(25, deadline - Date.now())));
    }
    return {
      timed_out: ACTIVE_JOB_STATES.has(job.status),
      session: this.liveSummary(session, false),
      run: jobSnapshot(job)
    };
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
    return this.liveSummary(session, true);
  }

  async cancel(input) {
    const session = this.getSession(input.session_id);
    const job = session.job;
    if (!job || !ACTIVE_JOB_STATES.has(job.status)) {
      throw new PiLocalError("no_active_run", "No active Pi run can be cancelled.");
    }
    await session.rpc.command({ type: "abort" });
    job.status = "cancelling";
    job.events.push({ type: "abort_acknowledged", at: now() });
    return jobSnapshot(job);
  }

  async respondToUi(input) {
    const session = this.getSession(input.session_id);
    if (!session.uiRequests.has(input.request_id)) {
      throw new PiLocalError("unknown_ui_request", "That UI request is not pending for this Pi session.");
    }
    const provided = [input.value !== undefined, input.confirmed !== undefined, input.cancelled === true].filter(Boolean).length;
    if (provided !== 1) {
      throw new PiLocalError("invalid_ui_response", "Provide exactly one of value, confirmed, or cancelled.");
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
      live_sessions: Array.from(this.sessions.values()).map((session) => this.liveSummary(session, true)),
      saved_sessions: saved
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

  async scanSavedSessions(workspace, limit) {
    const fileCandidates = await this.walkSessionFiles(Math.max(limit * 4, 300));
    const inspected = [];
    for (const candidate of fileCandidates) {
      try {
        const headerLine = await readFirstLine(candidate.file);
        const header = JSON.parse(headerLine);
        if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
          continue;
        }
        let sessionWorkspace;
        try {
          sessionWorkspace = await canonicalDirectory(header.cwd, this.allowedRoots, "saved Pi session workspace");
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
          session_file: candidate.file
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
        const workspace = await canonicalDirectory(header.cwd, this.allowedRoots, "saved Pi session workspace");
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
    throw new PiLocalError("saved_session_not_found", "No allowed saved Pi session exists with id " + piSessionId + ".");
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
