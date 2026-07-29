import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createPiMcpServer } from "../src/server.mjs";

async function withClient(service, run) {
  const server = createPiMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pi-local-mcp-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function settledTask(answer = "Pi completed the requested read-only task.") {
  return {
    timed_out: false,
    session: { session_id: "session-1", workspace: "/mnt/d/WorkSpace/pi-local-mcp" },
    run: {
      run_id: "run-1",
      status: "settled",
      result: { assistant_text: answer }
    }
  };
}

function assertAnswerFirst(result, answer) {
  assert.equal(result.structuredContent?.answer, answer);
  assert.equal(result.structuredContent?.result?.run?.result?.assistant_text, answer);
  assert.equal(result.structuredContent?.untrustedContent, true);
  assert.equal(result.content?.[0]?.text, "Pi answer (untrusted):\n" + answer + "\n\nPi review completed.\n\nsession session-1 · run run-1");
}

test("high-level Pi workflows expose a direct, answer-first untrusted result", async () => {
  const taskInputs = [];
  const service = {
    task: async (input) => {
      taskInputs.push(input);
      return settledTask();
    }
  };

  await withClient(service, async (client) => {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 20);
    assert.ok(tools.tools.some((tool) => tool.name === "pi_send"));
    assert.ok(!tools.tools.some((tool) => tool.name === "pi_steer"));

    const result = await client.callTool({
      name: "pi_review",
      arguments: { request: "Check the implementation without modifying files." }
    });
    assertAnswerFirst(result, "Pi completed the requested read-only task.");
  });

  assert.equal(taskInputs.length, 1);
  assert.equal(taskInputs[0].profile, "review");
  assert.equal(taskInputs[0].provider, "deepseek");
  assert.equal(taskInputs[0].model, "deepseek-v4-pro");
  assert.equal(taskInputs[0].wait_seconds, 120);
});

test("high-level task summaries distinguish a requested wait timeout", async () => {
  const service = {
    task: async () => ({
      timed_out: true,
      session: { session_id: "session-1" },
      run: { run_id: "run-1", status: "running", result: null }
    })
  };

  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_task",
      arguments: { message: "Continue the task.", wait_seconds: 30 }
    });
    assert.equal(result.structuredContent?.answer, null);
    assert.match(
      result.content?.[0]?.text || "",
      /Pi task is still running after the requested wait; use pi_wait or pi_status/
    );
  });
});

test("session lifecycle tools keep their thin MCP mapping and pi_wait is answer-first", async () => {
  const calls = [];
  const service = {
    startSession: async (input) => {
      calls.push(["start", input]);
      return { session_id: "session-1", lifecycle: "running" };
    },
    send: async (input) => {
      calls.push(["send", input]);
      return { run_id: "run-1", prompt_kind: "prompt", status: "accepted" };
    },
    status: async (input) => {
      calls.push(["status", input]);
      return { session_id: "session-1", lifecycle: "running", job: { run_id: "run-1", status: "running" } };
    },
    wait: async (input) => {
      calls.push(["wait", input]);
      return settledTask("The package name is pi-local-mcp.");
    },
    history: async (input) => {
      calls.push(["history", input]);
      return { entries: [{ id: "entry-1", type: "message" }], total_entries: 1 };
    },
    close: async (input) => {
      calls.push(["close", input]);
      return { session_id: "session-1", lifecycle: "closed" };
    }
  };

  await withClient(service, async (client) => {
    const started = await client.callTool({
      name: "pi_start_session",
      arguments: { profile: "review", provider: "deepseek", model: "deepseek-v4-flash" }
    });
    assert.equal(started.structuredContent?.result?.session_id, "session-1");

    const sent = await client.callTool({
      name: "pi_send",
      arguments: { session_id: "session-1", message: "Read package.json." }
    });
    assert.equal(sent.structuredContent?.result?.run_id, "run-1");

    const steered = await client.callTool({
      name: "pi_send",
      arguments: { session_id: "session-1", message: "Keep the response short.", behavior: "steer" }
    });
    assert.match(steered.content?.[0]?.text || "", /Pi accepted a steer instruction for run run-1\./);

    const status = await client.callTool({
      name: "pi_status",
      arguments: { session_id: "session-1" }
    });
    assert.equal(status.structuredContent?.result?.job?.run_id, "run-1");

    const waited = await client.callTool({
      name: "pi_wait",
      arguments: { session_id: "session-1", run_id: "run-1", timeout_seconds: 30 }
    });
    assert.equal(waited.structuredContent?.answer, "The package name is pi-local-mcp.");
    assert.match(waited.content?.[0]?.text || "", /^Pi answer \(untrusted\):/);

    const history = await client.callTool({
      name: "pi_history",
      arguments: { session_id: "session-1", limit: 10 }
    });
    assert.equal(history.structuredContent?.result?.entries?.length, 1);

    await client.callTool({
      name: "pi_close_session",
      arguments: { session_id: "session-1" }
    });
  });

  assert.deepEqual(calls.map(([name]) => name), ["start", "send", "send", "status", "wait", "history", "close"]);
  assert.equal(calls[1][1].behavior, undefined);
  assert.equal(calls[2][1].behavior, "steer");
  assert.equal(calls[4][1].run_id, "run-1");
});
