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
    answer,
    session: { session_id: "session-1", workspace: "/mnt/d/WorkSpace/pi-local-mcp" },
    run: {
      run_id: "run-1",
      status: "settled",
      started_at: "2026-08-01T00:00:00.000Z",
      settled_at: "2026-08-01T00:01:00.000Z",
      prompt_kind: "prompt",
      error: null,
      pending_ui_requests: []
    }
  };
}

function assertAnswerFirst(result, answer) {
  assert.equal(result.structuredContent?.answer, answer);
  // Compact by default: the answer channel is not duplicated inside the
  // snapshot, and the run snapshot carries no assistant text copy.
  assert.equal(result.structuredContent?.result?.answer, undefined);
  assert.equal(result.structuredContent?.result?.run?.result, undefined);
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
      run: { run_id: "run-1", status: "running", pending_ui_requests: [] }
    })
  };

  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_task",
      arguments: { message: "Continue the task.", wait_seconds: 30 }
    });
    assert.equal(result.structuredContent?.answer, null);
    const text = result.content?.[0]?.text || "";
    assert.match(text, /Pi task is still running after the requested wait; use pi_wait or pi_status/);
    // No-answer calls end with concise session/run references, never a payload dump.
    assert.ok(text.endsWith("\n\nsession session-1 · run run-1"), "expected references suffix in: " + text);
    assert.ok(!text.includes('"run_id"'), "no-answer text must not pretty-print the structured result");
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
    // Compact by default: no assistant-text copy and no event replay.
    assert.equal(waited.structuredContent?.result?.run?.result, undefined);
    assert.equal(waited.structuredContent?.result?.run?.recent_events, undefined);
    assert.equal(waited.structuredContent?.result?.run?.tool_calls, undefined);

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

test("include_details restores the full diagnostic run snapshot and is threaded to the service", async () => {
  const inputs = [];
  const service = {
    task: async (input) => {
      inputs.push(input);
      return {
        timed_out: false,
        answer: "The package name is pi-local-mcp.",
        session: { session_id: "session-1" },
        run: {
          run_id: "run-1",
          status: "settled",
          started_at: "2026-08-01T00:00:00.000Z",
          settled_at: "2026-08-01T00:01:00.000Z",
          prompt_kind: "prompt",
          error: null,
          pending_ui_requests: [],
          result: { assistant_text: "The package name is pi-local-mcp." },
          streamed_message_updates: 3,
          recent_events: [
            { type: "tool_execution_start", tool_call_id: "t1", tool_name: "read", at: "2026-08-01T00:00:30.000Z" },
            { type: "agent_settled", at: "2026-08-01T00:01:00.000Z" }
          ]
        }
      };
    }
  };

  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_task",
      arguments: { message: "Read package.json.", include_details: true }
    });
    assert.equal(inputs[0].include_details, true);
    assert.equal(result.structuredContent?.answer, "The package name is pi-local-mcp.");
    assert.equal(result.structuredContent?.result?.run?.result?.assistant_text, "The package name is pi-local-mcp.");
    assert.equal(result.structuredContent?.result?.run?.recent_events?.length, 2);
    assert.equal(result.structuredContent?.result?.run?.streamed_message_updates, 3);
    // The answer channel still is not duplicated at the top level of the result.
    assert.equal(result.structuredContent?.result?.answer, undefined);
  });

  const research = await withClient({
    task: async (input) => {
      inputs.push(input);
      return settledTask("Searched sources.");
    }
  }, async (client) => client.callTool({
    name: "pi_research",
    arguments: { question: "Search the web.", include_details: true }
  }));
  assert.equal(inputs[1].include_details, true);
  assert.equal(inputs[1].profile, "research");
  assert.equal(research.structuredContent?.answer, "Searched sources.");
});

test("pi_sessions lists live sessions compactly and include_details restores job snapshots", async () => {
  const calls = [];
  const service = {
    listSessions: async (input) => {
      calls.push(input);
      const live = {
        session_id: "session-1",
        lifecycle: "running"
      };
      if (input.include_details) {
        live.job = {
          run_id: "run-1",
          status: "running",
          recent_events: [{ type: "tool_execution_start", tool_name: "read" }]
        };
      }
      return {
        live_sessions: [live],
        saved_sessions: []
      };
    }
  };

  await withClient(service, async (client) => {
    const compact = await client.callTool({ name: "pi_sessions", arguments: {} });
    assert.equal(compact.structuredContent?.result?.live_sessions?.[0]?.job, undefined);
    assert.ok(!calls[0].include_details);

    const detailed = await client.callTool({
      name: "pi_sessions",
      arguments: { include_details: true }
    });
    assert.equal(detailed.structuredContent?.result?.live_sessions?.[0]?.job?.run_id, "run-1");
    assert.ok(calls[1].include_details);
  });
});

test("pi_wait accepts include_details and reflects it in the run snapshot", async () => {
  const calls = [];
  const service = {
    wait: async (input) => {
      calls.push(input);
      return {
        timed_out: true,
        session: { session_id: "session-1" },
        run: {
          run_id: "run-1",
          status: "running",
          started_at: "2026-08-01T00:00:00.000Z",
          settled_at: null,
          prompt_kind: "prompt",
          error: null,
          pending_ui_requests: [{ id: "confirm-1", method: "confirm" }],
          recent_events: [{ type: "tool_execution_start", tool_call_id: "t1", tool_name: "read" }]
        }
      };
    }
  };

  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_wait",
      arguments: { session_id: "session-1", run_id: "run-1", timeout_seconds: 5, include_details: true }
    });
    assert.equal(calls[0].include_details, true);
    assert.equal(result.structuredContent?.result?.run?.recent_events?.length, 1);
    assert.equal(result.structuredContent?.result?.run?.pending_ui_requests?.[0]?.id, "confirm-1");
    const text = result.content?.[0]?.text || "";
    assert.ok(!text.includes("recent_events"), "no-answer text must stay concise even with include_details");
  });
});
