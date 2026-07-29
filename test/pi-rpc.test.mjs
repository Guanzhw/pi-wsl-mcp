import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { PiRpcProcess, buildPiArgs } from "../src/pi-rpc.mjs";

test("buildPiArgs preserves normal Pi behavior for workspace and constrains read-only profiles", () => {
  assert.deepEqual(
    buildPiArgs({ profile: { id: "workspace", tools: null } }),
    ["--mode", "rpc"]
  );
  assert.deepEqual(
    buildPiArgs({
      profile: { id: "review", tools: ["read", "grep", "web_search"] },
      sessionPath: "/home/qq110/.pi/agent/sessions/example.jsonl"
    }),
    [
      "--mode", "rpc",
      "--session", "/home/qq110/.pi/agent/sessions/example.jsonl",
      "--tools", "read,grep,web_search"
    ]
  );
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
