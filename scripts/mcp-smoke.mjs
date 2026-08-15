#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const useWindowsLauncher = process.argv.includes("--windows-launcher") || process.platform === "win32";
const useLifecycle = process.argv.includes("--lifecycle");
const useLegacyProtocol = process.argv.includes("--legacy");
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const launcherPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "run-pi-wsl-mcp.cmd");

// The Windows launcher runs on the Windows side, so the smoke client must hand
// cmd.exe a real Windows path. Inside WSL that is a wslpath -w conversion; on
// Windows the checkout path is already native. The path is passed as a single
// unquoted argv entry so Node applies proper MSVCRT quoting instead of the
// backslash-escaped quotes the WSL interop layer would mangle.
async function windowsPath(input) {
  if (process.platform !== "win32") {
    const { execFile } = await import("node:child_process");
    const { stdout } = await new Promise((resolve, reject) => {
      execFile("wslpath", ["-w", input], (error, stdout, stderr) => {
        if (error) {
          reject(new Error("wslpath -w failed: " + stderr));
        } else {
          resolve({ stdout });
        }
      });
    });
    return stdout.trim();
  }
  return input;
}

const bridge = useWindowsLauncher
  ? spawn("cmd.exe", ["/d", "/s", "/c", await windowsPath(launcherPath)], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    // The smoke asserts the complete 20-tool protocol surface (it also calls
    // full-only tools like pi_history/pi_start_session), so the bridge is
    // pinned to the full toolset. The launcher forwards this into WSL via
    // WSLENV.
    env: { ...process.env, PI_WSL_MCP_TOOLSET: "full" }
  })
  : spawn(process.execPath, ["src/cli.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
  env: { ...process.env, PI_WSL_MCP_TOOLSET: "full" }
  });

let nextId = 1;
let stdoutBuffer = "";
let stderr = "";
const pending = new Map();

function failAll(error) {
  for (const [id, pendingRequest] of pending) {
    pending.delete(id);
    clearTimeout(pendingRequest.timer);
    pendingRequest.reject(error);
  }
}

bridge.stdout.setEncoding("utf8");
bridge.stderr.setEncoding("utf8");
bridge.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline === -1) {
      return;
    }
    const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      failAll(new Error("Non-JSON MCP stdout: " + line));
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      request.resolve(message);
    }
  }
});
bridge.stderr.on("data", (chunk) => {
  stderr += chunk;
});
bridge.on("error", (error) => failAll(error));
bridge.on("exit", (code, signal) => {
  if (pending.size > 0) {
    failAll(new Error("MCP bridge exited early (" + code + ", " + signal + "): " + stderr));
  }
});

// The default wire result carries the final Pi text exactly once, in
// content[0].text, followed by the tool's deterministic summary line. This
// extracts the answer between the untrusted marker and the summary.
function answerFromContent(text, summary) {
  const prefix = "Pi answer (untrusted):\n";
  if (typeof text !== "string" || !text.startsWith(prefix)) {
    return null;
  }
  const marker = "\n\n" + summary;
  const end = text.indexOf(marker, prefix.length);
  return end === -1 ? null : text.slice(prefix.length, end);
}

function answerMeta(result) {
  return result?.structuredContent?.answer_meta;
}

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  const requestParams = useLegacyProtocol
    ? params
    : {
      ...(params || {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "pi-wsl-mcp-smoke", version: "0.1.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for " + method + ": " + stderr));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    bridge.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: requestParams
    }) + "\n");
  });
}

try {
  if (useLegacyProtocol) {
    const initialized = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "pi-wsl-mcp-smoke", version: "0.1.0" }
    });
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.result?.serverInfo?.name, "Pi WSL MCP");
    bridge.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }) + "\n");
  } else {
    const discovered = await request("server/discover", {});
    assert.equal(discovered.error, undefined);
    assert.equal(discovered.result?.resultType, "complete");
    assert.ok(discovered.result?.supportedVersions?.includes(MODERN_PROTOCOL_VERSION));
    assert.equal(discovered.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "Pi WSL MCP");
  }

  const listed = await request("tools/list", {});
  assert.equal(listed.error, undefined);
  if (!useLegacyProtocol) {
    assert.equal(listed.result?.resultType, "complete");
    assert.equal(listed.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "Pi WSL MCP");
  }
  const names = listed.result?.tools?.map((tool) => tool.name) || [];
  assert.equal(names.length, 20, "Pi WSL MCP should keep its 20-tool surface.");
  for (const name of ["pi_info", "pi_task", "pi_research", "pi_review", "pi_resume_session"]) {
    assert.ok(names.includes(name), "Missing MCP tool " + name);
  }
  const taskTool = listed.result?.tools?.find((tool) => tool.name === "pi_task");
  const taskSchema = JSON.stringify(taskTool?.inputSchema || {});
  assert.ok(taskSchema.includes('"session_id"'), "pi_task must accept a reusable live session_id.");
  assert.ok(taskSchema.includes('"auto_close"'), "pi_task must accept auto_close.");
  assert.ok(taskSchema.includes('"max_elapsed_seconds"'), "pi_task must accept optional max_elapsed_seconds.");
  assert.ok(taskSchema.includes('"max_model_calls"'), "pi_task must accept optional max_model_calls.");
  assert.ok(taskSchema.includes('"max_cost"'), "pi_task must accept optional max_cost.");
  const waitTool = listed.result?.tools?.find((tool) => tool.name === "pi_wait");
  const waitSchema = JSON.stringify(waitTool?.inputSchema || {});
  assert.ok(waitSchema.includes('"timeout_seconds"'), "pi_wait must accept timeout_seconds.");
  assert.ok(waitSchema.includes("300"), "timeout_seconds must stay schema-compatible through 300.");
  const reviewSchema = JSON.stringify(
    (listed.result?.tools?.find((tool) => tool.name === "pi_review")?.inputSchema) || {}
  );
  assert.ok(reviewSchema.includes('"session_id"'));
  assert.ok(reviewSchema.includes('"auto_close"'));
  assert.ok(reviewSchema.includes('"max_model_calls"'), "pi_review must accept optional budgets.");
  const sessionsTool = listed.result?.tools?.find((tool) => tool.name === "pi_sessions");
  const sessionsSchema = JSON.stringify(sessionsTool?.inputSchema || {});
  assert.ok(sessionsSchema.includes('"saved_cursor"'), "pi_sessions must accept a saved_cursor for continuation.");
  const sessionsDescription = sessionsTool?.description || "";
  assert.match(sessionsDescription, /all local saved Pi sessions/i, "pi_sessions must advertise the full local store.");
  assert.match(sessionsDescription, /next_saved_cursor/, "pi_sessions must explain cursor continuation.");

  const info = await request("tools/call", {
    name: "pi_info",
    arguments: {}
  });
  assert.equal(info.error, undefined);
  if (!useLegacyProtocol) {
    assert.equal(info.result?.resultType, "complete");
    assert.equal(info.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "Pi WSL MCP");
  }
  const payload = info.result?.structuredContent?.result;
  assert.ok(payload?.pi_bin?.endsWith("/pi"));
  assert.ok(Array.isArray(payload?.allowed_roots));
  assert.equal(
    info.result?.structuredContent?.success,
    true,
    "directory-style results succeed even though they carry no answer"
  );

  // Saved-session pagination contract, exercised on the real local store in
  // both protocol eras: pages stay bounded, and the returned cursor continues
  // to the next newest session. The cursor is self-contained: the second page
  // passes ONLY saved_cursor (no limit, no workspace) and must reproduce the
  // original page size and scope.
  const pageOne = await request("tools/call", {
    name: "pi_sessions",
    arguments: { limit: 1 }
  });
  assert.equal(pageOne.error, undefined);
  const pageOneResult = pageOne.result?.structuredContent?.result;
  assert.ok("next_saved_cursor" in pageOneResult, "pi_sessions must report cursor continuation fields.");
  assert.equal(pageOneResult?.saved_sessions?.length, 1, "a bounded page must never be silently truncated.");
  if (pageOneResult?.next_saved_cursor !== null) {
    const pageTwo = await request("tools/call", {
      name: "pi_sessions",
      arguments: { saved_cursor: pageOneResult.next_saved_cursor }
    });
    assert.equal(pageTwo.error, undefined);
    const pageTwoResult = pageTwo.result?.structuredContent?.result;
    assert.equal(pageTwoResult?.saved_sessions?.length, 1, "cursor-only continuation must keep the original page size.");
    assert.notEqual(
      pageTwoResult?.saved_sessions?.[0]?.pi_session_id,
      pageOneResult?.saved_sessions?.[0]?.pi_session_id,
      "cursor continuation must move to the next newest saved session."
    );
    // A conflicting workspace or limit alongside the cursor must be rejected
    // with an actionable "start a new listing" error, never silently ignored.
    for (const conflicting of [{ limit: 5 }, { workspace: "/mnt" }]) {
      const conflict = await request("tools/call", {
        name: "pi_sessions",
        arguments: { saved_cursor: pageOneResult.next_saved_cursor, ...conflicting }
      });
      assert.equal(conflict.error, undefined);
      assert.equal(conflict.result?.isError, true, "conflicting cursor arguments must fail the call.");
      assert.match(
        conflict.result?.content?.[0]?.text || "",
        /invalid_saved_cursor.*start a new listing/i,
        "the conflict error must tell the caller to start a new listing."
      );
    }
  }

  if (process.argv.includes("--live")) {
    const research = await request("tools/call", {
      name: "pi_research",
      arguments: {
        question: "Use the web_search tool exactly once to search for the official Model Context Protocol site. Return the title and direct URL of one result, and say that the search tool was used.",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        wait_seconds: 120,
        include_details: true,
        auto_close: true
      }
    }, 150000);
    assert.equal(research.error, undefined);
    const liveResult = research.result?.structuredContent?.result;
    if (process.argv.includes("--debug")) {
      process.stdout.write(JSON.stringify(liveResult, null, 2) + "\n");
    }
    assert.equal(liveResult?.timed_out, false, "Pi research did not settle before the smoke timeout.");
    assert.equal(liveResult?.run?.status, "settled");
    const researchAnswer = answerFromContent(research.result?.content?.[0]?.text, "Pi research completed.");
    assert.notEqual(researchAnswer, null, "a settled research run must carry the final Pi text in content[0].text.");
    assert.ok(researchAnswer && researchAnswer.length > 0, "settled research must carry an answer.");
    const researchMeta = answerMeta(research.result);
    assert.equal(researchMeta?.has_answer, true);
    assert.equal(researchMeta?.truncated, false);
    assert.ok(researchMeta?.original_chars >= researchAnswer.length);
    assert.equal(research.result?.structuredContent?.answer, undefined, "structuredContent must not duplicate the full answer.");
    assert.equal(
      liveResult?.run?.result?.assistant_text,
      researchAnswer,
      "include_details must preserve the detailed run snapshot with the assistant text."
    );
    // DeepSeek's native search runs server-side: the deepseek-responses
    // web-search extension injects {type:"web_search"} into the provider
    // request, so there is no local Pi tool_execution_start event for it.
    // Observable evidence is a settled, non-empty answer that cites a
    // search-result URL - and the absence of the 400 same-name conflict.
    assert.match(researchAnswer, /https?:\/\/\S+/, "the research answer must cite a search-result URL.");
    assert.ok(
      !(liveResult?.run?.recent_events || []).some((event) => event.type === "tool_execution_start" && event.tool_name === "search"),
      "the research profile must never expose a function tool named search."
    );
    assert.equal(
      liveResult?.session?.process_status,
      "closed",
      "auto_close must close the bridge process after settlement."
    );
    assert.equal(liveResult?.session?.lifecycle, "closed");
    assert.equal(typeof liveResult?.session?.pi_session_id, "string", "auto_close must preserve the durable pi_session_id.");
    assert.equal(liveResult?.run?.progress?.phase, "settled", "compact progress must report the settled phase.");
    assert.equal(typeof liveResult?.run?.progress?.last_activity_at, "string");
    assert.ok(liveResult?.run?.stats?.model_calls >= 1, "every real assistant message_end must be counted exactly once (retries legitimately add calls).");
    assert.ok(liveResult?.run?.stats?.usage?.total > 0, "compact stats must carry token usage totals.");
    assert.ok(liveResult?.run?.stats?.usage?.input > 0);
    assert.equal(typeof liveResult?.run?.stats?.cost, "number");
    assert.ok(Array.isArray(liveResult?.run?.stats?.models) && liveResult?.run?.stats?.models.length > 0);
    assert.ok(liveResult?.run?.stats?.elapsed_ms > 0, "settled runs must report elapsed time.");

    const close = await request("tools/call", {
      name: "pi_close_session",
      arguments: { session_id: liveResult.session.session_id }
    });
    assert.equal(close.error, undefined);

    if (process.argv.includes("--resume")) {
      const listedSessions = await request("tools/call", {
        name: "pi_sessions",
        arguments: { workspace: liveResult.session.workspace, limit: 100 }
      });
      assert.equal(listedSessions.error, undefined);
      assert.equal(
        listedSessions.result?.structuredContent?.success,
        true,
        "pi_sessions succeeds with has_answer=false"
      );
      assert.ok(
        "next_saved_cursor" in listedSessions.result?.structuredContent?.result,
        "pi_sessions must report cursor continuation fields."
      );
      for (const entry of listedSessions.result?.structuredContent?.result?.live_sessions || []) {
        assert.equal(entry.job, undefined, "pi_sessions must be compact by default (no job snapshot).");
        assert.equal(entry.pi_session_file, undefined, "pi_sessions must not expose the session file by default.");
        assert.equal(entry.model, undefined, "pi_sessions must not expose the model by default.");
        assert.equal(entry.pending_ui_requests, undefined, "pi_sessions must not list pending UI requests by default.");
        assert.equal(typeof entry.session_id, "string");
        assert.equal(typeof entry.lifecycle, "string");
        assert.equal(typeof entry.pending_ui_request_count, "number");
        if (entry.active_run !== null) {
          assert.equal(typeof entry.active_run.run_id, "string");
          assert.equal(typeof entry.active_run.status, "string");
        }
      }
      const saved = listedSessions.result?.structuredContent?.result?.saved_sessions || [];
      for (const entry of saved) {
        assert.equal(entry.session_file, undefined, "saved_sessions must never expose the session file path.");
        assert.equal(entry.bytes, undefined, "saved_sessions must not expose byte size by default.");
        assert.equal(typeof entry.pi_session_id, "string");
        assert.equal(typeof entry.modified_at, "string");
        assert.ok("name" in entry, "saved_sessions must carry the derived session name field (nullable).");
        assert.ok("summary" in entry, "saved_sessions must carry the bounded first-task preview field (nullable).");
        if (entry.name !== null) {
          assert.ok(Array.from(entry.name).length <= 161, "session name must stay bounded by Unicode code points.");
          assert.ok(!entry.name.includes("\n"), "session name must be a single line.");
        }
        if (entry.summary !== null) {
          assert.ok(Array.from(entry.summary).length <= 161, "preview must stay bounded by Unicode code points.");
          assert.ok(!entry.summary.includes("\n"), "preview must be a single line.");
        }
      }
      assert.ok(
        saved.some((entry) => entry.pi_session_id === liveResult.session.pi_session_id),
        "The completed Pi session was not discoverable for resume."
      );
      const detailedListed = await request("tools/call", {
        name: "pi_sessions",
        arguments: { workspace: liveResult.session.workspace, limit: 100, include_details: true }
      });
      assert.equal(detailedListed.error, undefined);
      const detailedSaved = detailedListed.result?.structuredContent?.result?.saved_sessions || [];
      const completed = detailedSaved.find((entry) => entry.pi_session_id === liveResult.session.pi_session_id);
      assert.ok(completed, "include_details must still discover the completed Pi session.");
      assert.equal(typeof completed.bytes, "number", "include_details must restore saved-session byte size.");
      assert.equal(completed.session_file, undefined, "include_details must still hide the session file path.");
      assert.equal(
        typeof completed.summary,
        "string",
        "the completed session must be identifiable by its bounded first-task preview."
      );
      assert.ok(completed.summary.length > 0, "the first-task preview must not be empty.");
      assert.equal(detailedListed.result?.structuredContent?.success, true);
      const resumed = await request("tools/call", {
        name: "pi_resume_session",
        arguments: {
          saved_session_id: liveResult.session.pi_session_id,
          profile: "research"
        }
      });
      assert.equal(resumed.error, undefined);
      const resumedSession = resumed.result?.structuredContent?.result?.session;
      assert.equal(resumedSession?.pi_session_id, liveResult.session.pi_session_id);
      const history = await request("tools/call", {
        name: "pi_history",
        arguments: {
          session_id: resumedSession.session_id,
          limit: 10
        }
      });
      assert.equal(history.error, undefined);
      assert.ok((history.result?.structuredContent?.result?.entries || []).length > 0);
      const closeResumed = await request("tools/call", {
        name: "pi_close_session",
        arguments: { session_id: resumedSession.session_id }
      });
      assert.equal(closeResumed.error, undefined);
    }
    if (process.argv.includes("--workspace")) {
      const workspaceTask = await request("tools/call", {
        name: "pi_task",
        arguments: {
          profile: "workspace",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          wait_seconds: 120,
          include_details: true,
          message: "Use the read tool to inspect package.json in the current workspace. Return only the package name. Do not modify files or run commands."
        }
      }, 150000);
      assert.equal(workspaceTask.error, undefined);
      const workspaceResult = workspaceTask.result?.structuredContent?.result;
      assert.equal(workspaceResult?.timed_out, false);
      if (workspaceResult?.run?.status === "error") {
        // In environments where the user's workspace toolset contains a
        // function tool named `search` next to DeepSeek's native web_search
        // injection, the workspace profile keeps the normal toolset (never
        // silently rewritten) and must report the conflict as an accurate,
        // actionable run error - never a fake settled empty answer.
        assert.match(workspaceResult?.run?.error || "", /conflicts with the provider's server-side web_search/);
        assert.match(workspaceResult?.run?.error || "", /--exclude-tools search/);
        assert.equal(workspaceResult?.run?.stop_reason, "error");
        assert.equal(workspaceTask.result?.structuredContent?.answer_meta?.has_answer, false);
        assert.match(workspaceTask.result?.content?.[0]?.text || "", /Pi task ended with an error/);
      } else {
        assert.equal(workspaceResult?.run?.status, "settled");
        const workspaceAnswer = answerFromContent(workspaceTask.result?.content?.[0]?.text, "Pi completed a new task.");
        assert.ok(workspaceAnswer && workspaceAnswer.length > 0, "settled workspace task must carry the answer in content[0].text.");
        assert.equal(workspaceAnswer, workspaceResult?.run?.result?.assistant_text);
        assert.equal(workspaceTask.result?.structuredContent?.answer, undefined);
        assert.equal(workspaceResult?.run?.progress?.phase, "settled");
        assert.ok(workspaceResult?.run?.stats?.model_calls >= 1, "compact stats must count real assistant message_end events.");
        assert.ok(workspaceResult?.run?.stats?.usage?.total > 0);
        assert.ok(
          (workspaceResult?.run?.recent_events || [])
            .filter((event) => event.type === "tool_execution_start")
            .some((event) => event.tool_name === "read"),
          "The normal workspace session did not invoke Pi's read tool."
        );
      }
      const closeWorkspace = await request("tools/call", {
        name: "pi_close_session",
        arguments: { session_id: workspaceResult.session.session_id }
      });
      assert.equal(closeWorkspace.error, undefined);
    }
    if (useLifecycle) {
      const started = await request("tools/call", {
        name: "pi_start_session",
        arguments: {
          profile: "review",
          provider: "deepseek",
          model: "deepseek-v4-flash"
        }
      });
      assert.equal(started.error, undefined);
      const liveSession = started.result?.structuredContent?.result;
      assert.equal(liveSession?.lifecycle, "running");
      assert.equal(liveSession?.profile, "review");

      const sent = await request("tools/call", {
        name: "pi_send",
        arguments: {
          session_id: liveSession.session_id,
          message: "Use the read tool to inspect package.json. Return only its package name. Do not modify files or run commands."
        }
      });
      assert.equal(sent.error, undefined);
      const run = sent.result?.structuredContent?.result;
      assert.equal(run?.prompt_kind, "prompt");

      const status = await request("tools/call", {
        name: "pi_status",
        arguments: { session_id: liveSession.session_id }
      });
      assert.equal(status.error, undefined);
      const statusResult = status.result?.structuredContent?.result;
      assert.equal(statusResult?.session_id, liveSession.session_id);
      assert.ok(statusResult?.job?.run_id === run.run_id, "Status did not report the dispatched Pi run.");
      assert.equal(statusResult?.job?.tool_calls, undefined, "pi_status must not duplicate tool calls inside recent_events.");

      const waited = await request("tools/call", {
        name: "pi_wait",
        arguments: {
          session_id: liveSession.session_id,
          run_id: run.run_id,
          timeout_seconds: 120
        }
      }, 150000);
      assert.equal(waited.error, undefined);
      const waitedResult = waited.result?.structuredContent?.result;
      assert.equal(waitedResult?.timed_out, false, "Pi lifecycle task did not settle before the smoke timeout.");
      assert.equal(waitedResult?.run?.status, "settled");
      const waitedAnswer = answerFromContent(waited.result?.content?.[0]?.text, "Pi run reached settled.");
      assert.ok(waitedAnswer && waitedAnswer.length > 0, "settled wait must carry an answer in content[0].text.");
      assert.equal(waited.result?.structuredContent?.answer, undefined);
      // Compact by default: no assistant-text copy and no event replay.
      assert.equal(waitedResult?.run?.result, undefined, "pi_wait must be compact by default.");
      assert.equal(waitedResult?.run?.recent_events, undefined, "pi_wait must not include recent_events by default.");
      assert.equal(waitedResult?.run?.tool_calls, undefined, "pi_wait must not include tool_calls by default.");
      assert.match(waited.result?.content?.[0]?.text || "", /^Pi answer \(untrusted\):/);

      const history = await request("tools/call", {
        name: "pi_history",
        arguments: {
          session_id: liveSession.session_id,
          limit: 10
        }
      });
      assert.equal(history.error, undefined);
      assert.ok((history.result?.structuredContent?.result?.entries || []).length > 0);

      const reusedReview = await request("tools/call", {
        name: "pi_review",
        arguments: {
          session_id: liveSession.session_id,
          request: "Re-check package.json using the read tool and return only its package name.",
          wait_seconds: 120,
          auto_close: true
        }
      }, 150000);
      assert.equal(reusedReview.error, undefined);
      const reusedResult = reusedReview.result?.structuredContent?.result;
      assert.equal(reusedResult?.timed_out, false);
      assert.equal(reusedResult?.run?.status, "settled");
      assert.equal(reusedResult?.session?.session_id, liveSession.session_id);
      assert.equal(reusedResult?.session?.process_status, "closed");
      assert.ok(reusedResult?.run?.stats?.usage?.total > 0);

      const closed = await request("tools/call", {
        name: "pi_close_session",
        arguments: { session_id: liveSession.session_id }
      });
      assert.equal(closed.error, undefined);
    }
    process.stdout.write(
      "MCP live Pi smoke passed (DeepSeek native web_search without the search-tool conflict"
        + (process.argv.includes("--resume") ? ", saved-session resume" : "")
        + (process.argv.includes("--workspace") ? ", workspace toolset (settled or actionable conflict error)" : "")
        + (useLifecycle ? ", start/send/status/wait/history lifecycle, settled review reuse + auto-close" : "")
        + ").\n"
    );
  } else {
    process.stdout.write(
      "MCP " + (useLegacyProtocol ? "legacy" : MODERN_PROTOCOL_VERSION) + " stdio smoke passed with " + names.length + " tools.\n"
    );
  }
} finally {
  bridge.kill("SIGTERM");
}
