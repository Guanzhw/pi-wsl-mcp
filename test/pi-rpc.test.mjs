import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { EOL_EXTENSION_PATH, PiRpcProcess, buildPiArgs } from "../src/pi-rpc.mjs";

test("buildPiArgs preserves normal Pi behavior for workspace and constrains read-only profiles", () => {
  assert.deepEqual(
    buildPiArgs({
      profile: { id: "workspace", tools: null },
      extensionPath: "/opt/pi-wsl-mcp/eol-extension.mjs"
    }),
    ["--mode", "rpc", "--extension", "/opt/pi-wsl-mcp/eol-extension.mjs"]
  );
  assert.deepEqual(
    buildPiArgs({
      profile: { id: "review", tools: ["read", "grep", "web_search"], excludeTools: ["search"] },
      sessionPath: "/home/user/.pi/agent/sessions/example.jsonl",
      extensionPath: "/opt/pi-wsl-mcp/eol-extension.mjs"
    }),
    [
      "--mode", "rpc",
      "--session", "/home/user/.pi/agent/sessions/example.jsonl",
      "--tools", "read,grep,web_search",
      // The named `search` function tool is excluded so it cannot collide
      // with DeepSeek Responses' server-side web_search injection.
      "--exclude-tools", "search",
      "--extension", "/opt/pi-wsl-mcp/eol-extension.mjs"
    ]
  );
  // A workspace profile with no allowlist never gains the exclusion: normal
  // Pi tools (including any user-composed `search` tool) stay untouched.
  assert.deepEqual(
    buildPiArgs({
      profile: { id: "workspace", tools: null },
      sessionPath: "/home/user/.pi/agent/sessions/example.jsonl",
      extensionPath: "/opt/pi-wsl-mcp/eol-extension.mjs"
    }),
    [
      "--mode", "rpc",
      "--session", "/home/user/.pi/agent/sessions/example.jsonl",
      "--extension", "/opt/pi-wsl-mcp/eol-extension.mjs"
    ]
  );
});

test("buildPiArgs defaults to the bundled session-scoped EOL extension", () => {
  assert.ok(EOL_EXTENSION_PATH.replace(/\\/g, "/").endsWith("/src/eol-extension.mjs"));
  const args = buildPiArgs({ profile: { id: "workspace", tools: null } });
  assert.deepEqual(args, ["--mode", "rpc", "--extension", EOL_EXTENSION_PATH]);
});

test("PiRpcProcess frames streamed JSONL responses and events", async () => {
  const rpc = new PiRpcProcess({
    piBin: "/bin/true",
    cwd: "/tmp",
    profile: { id: "workspace", tools: null },
    startupTimeoutMs: 1000,
    commandTimeoutMs: 1000
  });
  const events = [];
  rpc.on("event", (event) => events.push(event));

  const response = new Promise((resolve, reject) => {
    rpc.pending.set("request-1", {
      resolve,
      reject,
      timer: setTimeout(() => reject(new Error("response did not arrive")), 1000)
    });
  });
  rpc.consumeStdout("{\"type\":\"agent_start\"}\n{\"type\":\"response\",\"id\":\"request-1\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"pi-1\"}}\n");

  assert.deepEqual(events, [{ type: "agent_start" }]);
  assert.deepEqual(await response, {
    type: "response",
    id: "request-1",
    command: "get_state",
    success: true,
    data: { sessionId: "pi-1" }
  });
  assert.equal(rpc.pending.size, 0);
});

test("PiRpcProcess treats non-JSON stdout as a bounded protocol warning", () => {
  const rpc = new PiRpcProcess({
    piBin: "/bin/true",
    cwd: "/tmp",
    profile: { id: "workspace", tools: null },
    startupTimeoutMs: 1000,
    commandTimeoutMs: 1000
  });
  rpc.consumeStdout("not json\n");
  assert.equal(rpc.protocolWarnings.length, 1);
  assert.match(rpc.protocolWarnings[0], /Non-JSON output/);
});

test("PiRpcProcess bounds an unterminated stderr line", () => {
  const rpc = new PiRpcProcess({
    piBin: "/tmp/pi",
    cwd: "/tmp",
    profile: { id: "workspace", tools: null },
    startupTimeoutMs: 1000,
    commandTimeoutMs: 1000
  });
  rpc.consumeStderr("x".repeat(1024 * 1024 + 100));
  assert.equal(rpc.stderrBuffer.length, 1024 * 1024);
  assert.match(rpc.protocolWarnings.at(-1), /stderr line exceeded 1 MiB/);
});

test("PiRpcProcess waits for an extension UI response to reach stdin", async () => {
  const stdin = new PassThrough();
  let line = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => {
    line += chunk;
  });
  const rpc = new PiRpcProcess({
    piBin: "/bin/true",
    cwd: "/tmp",
    profile: { id: "workspace", tools: null },
    startupTimeoutMs: 1000,
    commandTimeoutMs: 1000
  });
  rpc.child = { stdin };
  await rpc.respondToUi({ id: "confirm-1", confirmed: true });
  assert.deepEqual(JSON.parse(line), {
    type: "extension_ui_response",
    id: "confirm-1",
    confirmed: true
  });
});
