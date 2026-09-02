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
    // The smoke asserts the complete 21-tool protocol surface (it also calls
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

function expertAnswer(text, label) {
  const prefix = "Pi " + label + " (untrusted):\n";
  return typeof text === "string" && text.startsWith(prefix) ? text.slice(prefix.length) : null;
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
  assert.equal(names.length, 21, "Pi WSL MCP should keep its 21-tool surface.");
  for (const name of ["pi_info", "pi_task", "pi_research", "pi_review", "pi_wait", "pi_status", "pi_kill_session", "pi_resume_session"]) {
    assert.ok(names.includes(name), "Missing MCP tool " + name);
  }
  const taskTool = listed.result?.tools?.find((tool) => tool.name === "pi_task");
  const taskSchema = JSON.stringify(taskTool?.inputSchema || {});
  assert.ok(!taskSchema.includes('"session_id"'), "pi_task must be an ephemeral one-shot call.");
  assert.ok(!taskSchema.includes('"auto_close"'), "pi_task manages the session lifecycle internally.");
  assert.ok(!taskSchema.includes('"wait_seconds"'), "pi_task must not expose async continuation controls.");
  assert.ok(!taskSchema.includes('"include_details"'), "pi_task must not expose diagnostics in its high-level result.");
  assert.ok(!taskSchema.includes('"max_elapsed_seconds"'), "pi_task must not expose caller budgets.");
  assert.ok(!taskSchema.includes('"max_model_calls"'), "pi_task must not expose caller budgets.");
  assert.ok(!taskSchema.includes('"max_cost"'), "pi_task must not expose caller budgets.");
  const waitTool = listed.result?.tools?.find((tool) => tool.name === "pi_wait");
  const waitSchema = JSON.stringify(waitTool?.inputSchema || {});
  assert.ok(!waitSchema.includes('"timeout_seconds"'), "pi_wait must not expose a caller timeout.");
  const reviewSchema = JSON.stringify(
    (listed.result?.tools?.find((tool) => tool.name === "pi_review")?.inputSchema) || {}
  );
  assert.ok(!reviewSchema.includes('"session_id"'));
  assert.ok(!reviewSchema.includes('"auto_close"'));
  assert.ok(!reviewSchema.includes('"max_model_calls"'), "pi_review must not expose caller budgets.");

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
  assert.equal(payload?.default_provider, "deepseek");
  assert.equal(payload?.default_model, "deepseek-v4-flash-vision-exp");
  assert.equal(payload?.sync_window_seconds, 600);
  assert.equal(
    info.result?.structuredContent?.success,
    true,
    "directory-style results succeed even though they carry no answer"
  );

  if (process.argv.includes("--live")) {
    const research = await request("tools/call", {
      name: "pi_research",
      arguments: {
        question: "Use the web_search tool exactly once to search for the official Model Context Protocol site. Return the title and direct URL of one result, and say that the search tool was used.",
      }
    }, 3600000);
    assert.equal(research.error, undefined);
    const liveResult = research.result?.structuredContent;
    if (process.argv.includes("--debug")) {
      process.stdout.write(JSON.stringify(liveResult, null, 2) + "\n");
    }
    assert.equal(liveResult?.status, "completed");
    const researchAnswer = expertAnswer(research.result?.content?.[0]?.text, "research result");
    assert.notEqual(researchAnswer, null, "a settled research run must carry the final Pi text in content[0].text.");
    assert.ok(researchAnswer && researchAnswer.length > 0, "settled research must carry an answer.");
    assert.deepEqual(liveResult, { status: "completed", untrustedContent: true });
    // DeepSeek's native search runs server-side: the deepseek-responses
    // web-search extension injects {type:"web_search"} into the provider
    // request, so there is no local Pi tool_execution_start event for it.
    // Observable evidence is a settled, non-empty answer that cites a
    // search-result URL - and the absence of the 400 same-name conflict.
    assert.match(researchAnswer, /https?:\/\/\S+/, "the research answer must cite a search-result URL.");
    assert.equal(JSON.stringify(liveResult).includes("session_id"), false);
    assert.equal(JSON.stringify(liveResult).includes("continuation"), false);

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
          message: "Use the read tool to inspect package.json in the current workspace. Return only the package name. Do not modify files or run commands."
        }
      }, 3600000);
      const workspaceResult = workspaceTask.result?.structuredContent;
      if (workspaceTask.result?.isError) {
        // In environments where the user's workspace toolset contains a
        // function tool named `search` next to DeepSeek's native web_search
        // injection, the workspace profile keeps the normal toolset (never
        // silently rewritten) and must report the conflict as an accurate,
        // actionable run error - never a fake settled empty answer.
        assert.equal(workspaceResult?.status, "failed");
        assert.match(workspaceTask.result?.content?.[0]?.text || "", /conflicts with the provider's server-side web_search/);
      } else {
        assert.equal(workspaceTask.error, undefined);
        assert.equal(workspaceResult?.status, "completed");
        const workspaceAnswer = expertAnswer(workspaceTask.result?.content?.[0]?.text, "task result");
        assert.ok(workspaceAnswer && workspaceAnswer.length > 0, "settled workspace task must carry the answer in content[0].text.");
        assert.equal(JSON.stringify(workspaceResult).includes("run_id"), false);
      }
    }
    if (useLifecycle) {
      const started = await request("tools/call", {
        name: "pi_start_session",
        arguments: {
          profile: "review",
        }
      });
      assert.equal(started.error, undefined);
      const liveSession = started.result?.structuredContent?.result;
      assert.equal(liveSession?.lifecycle, "running");
      assert.equal(liveSession?.profile, "review");

      // Vision model prompt acknowledgements can exceed the smoke harness's
      // default 30-second envelope timeout; this is test-only, not a caller
      // budget or a production API setting.
      const sent = await request("tools/call", {
        name: "pi_send",
        arguments: {
          session_id: liveSession.session_id,
          message: "Use the read tool to inspect package.json. Return only its package name. Do not modify files or run commands."
        }
      }, 150000);
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
          run_id: run.run_id
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

      const continued = await request("tools/call", {
        name: "pi_send",
        arguments: {
          session_id: liveSession.session_id,
          message: "Re-check package.json using the read tool and return only its package name."
        }
      }, 150000);
      assert.equal(continued.error, undefined);
      const continuedRun = continued.result?.structuredContent?.result?.run_id;
      const continuedResult = await request("tools/call", {
        name: "pi_wait",
        arguments: { session_id: liveSession.session_id, run_id: continuedRun }
      }, 150000);
      assert.equal(continuedResult.error, undefined);
      assert.equal(continuedResult.result?.structuredContent?.result?.run?.status, "settled");

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
        + (useLifecycle ? ", explicit start/send/status/wait/history lifecycle" : "")
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
