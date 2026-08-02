#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const useWindowsLauncher = process.argv.includes("--windows-launcher") || process.platform === "win32";
const useLifecycle = process.argv.includes("--lifecycle");
const useLegacyProtocol = process.argv.includes("--legacy");
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const bridge = useWindowsLauncher
  ? spawn("cmd.exe", ["/d", "/s", "/c", "D:\\WorkSpace\\pi-local-mcp\\run-pi-mcp.cmd"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true
  })
  : spawn(process.execPath, ["src/cli.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  shell: false
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

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  const requestParams = useLegacyProtocol
    ? params
    : {
      ...(params || {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "pi-local-mcp-smoke", version: "0.1.0" },
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
      clientInfo: { name: "pi-local-mcp-smoke", version: "0.1.0" }
    });
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.result?.serverInfo?.name, "Pi Local MCP");
    bridge.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }) + "\n");
  } else {
    const discovered = await request("server/discover", {});
    assert.equal(discovered.error, undefined);
    assert.equal(discovered.result?.resultType, "complete");
    assert.ok(discovered.result?.supportedVersions?.includes(MODERN_PROTOCOL_VERSION));
    assert.equal(discovered.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "Pi Local MCP");
  }

  const listed = await request("tools/list", {});
  assert.equal(listed.error, undefined);
  if (!useLegacyProtocol) {
    assert.equal(listed.result?.resultType, "complete");
    assert.equal(listed.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "Pi Local MCP");
  }
  const names = listed.result?.tools?.map((tool) => tool.name) || [];
  assert.equal(names.length, 20, "The Pi MCP should keep its 20-tool surface.");
  for (const name of ["pi_info", "pi_task", "pi_research", "pi_review", "pi_resume_session"]) {
    assert.ok(names.includes(name), "Missing MCP tool " + name);
  }

  const info = await request("tools/call", {
    name: "pi_info",
    arguments: {}
  });
  assert.equal(info.error, undefined);
  if (!useLegacyProtocol) {
    assert.equal(info.result?.resultType, "complete");
    assert.equal(info.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "Pi Local MCP");
  }
  const payload = info.result?.structuredContent?.result;
  assert.ok(payload?.pi_bin?.endsWith("/pi"));
  assert.ok(Array.isArray(payload?.allowed_roots));

  if (process.argv.includes("--live")) {
    const research = await request("tools/call", {
      name: "pi_research",
      arguments: {
        question: "Use the web_search tool exactly once to search for the official Model Context Protocol site. Return the title and direct URL of one result, and say that the search tool was used.",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        wait_seconds: 120,
        include_details: true
      }
    }, 150000);
    assert.equal(research.error, undefined);
    const liveResult = research.result?.structuredContent?.result;
    if (process.argv.includes("--debug")) {
      process.stdout.write(JSON.stringify(liveResult, null, 2) + "\n");
    }
    assert.equal(liveResult?.timed_out, false, "Pi research did not settle before the smoke timeout.");
    assert.equal(liveResult?.run?.status, "settled");
    assert.equal(typeof research.result?.structuredContent?.answer, "string");
    assert.ok(research.result?.structuredContent?.answer.length > 0, "settled research must carry an answer.");
    assert.equal(
      liveResult?.run?.result?.assistant_text,
      research.result?.structuredContent?.answer,
      "include_details must preserve the detailed run snapshot with the assistant text."
    );
    const toolNames = (liveResult?.run?.recent_events || [])
      .filter((event) => event.type === "tool_execution_start")
      .map((event) => event.tool_name);
    assert.ok(toolNames.includes("web_search"), "The live Pi task did not invoke DeepSeek web_search.");

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
      for (const entry of listedSessions.result?.structuredContent?.result?.live_sessions || []) {
        assert.equal(entry.job, undefined, "pi_sessions must be compact by default (no job snapshot).");
      }
      const saved = listedSessions.result?.structuredContent?.result?.saved_sessions || [];
      assert.ok(
        saved.some((entry) => entry.pi_session_id === liveResult.session.pi_session_id),
        "The completed Pi session was not discoverable for resume."
      );
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
      assert.equal(workspaceResult?.run?.status, "settled");
      assert.equal(workspaceTask.result?.structuredContent?.answer, workspaceResult?.run?.result?.assistant_text);
      assert.ok(
        (workspaceResult?.run?.recent_events || [])
          .filter((event) => event.type === "tool_execution_start")
          .some((event) => event.tool_name === "read"),
        "The normal workspace session did not invoke Pi's read tool."
      );
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
      assert.equal(typeof waited.result?.structuredContent?.answer, "string");
      assert.ok(waited.result?.structuredContent?.answer.length > 0, "settled wait must carry an answer.");
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

      const closed = await request("tools/call", {
        name: "pi_close_session",
        arguments: { session_id: liveSession.session_id }
      });
      assert.equal(closed.error, undefined);
    }
    process.stdout.write(
      "MCP live Pi smoke passed (DeepSeek web_search"
        + (process.argv.includes("--resume") ? ", saved-session resume" : "")
        + (process.argv.includes("--workspace") ? ", normal workspace tools" : "")
        + (useLifecycle ? ", start/send/status/wait/history lifecycle" : "")
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
