import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createPiMcpServer } from "../src/server.mjs";
import { PiLocalError } from "../src/util.mjs";

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
      session_id: "session-1",
      run_id: "run-1",
      session: { session_id: "session-1" },
      run: { run_id: "run-1", status: "running", pending_ui_requests: [] },
      continuation: {
        pi_wait: { session_id: "session-1", run_id: "run-1" },
        pi_status: { session_id: "session-1" }
      }
    })
  };

  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_task",
      arguments: { message: "Continue the task.", wait_seconds: 30 }
    });
    assert.equal(result.structuredContent?.answer, null);
    const payload = result.structuredContent?.result;
    assert.equal(payload.session_id, "session-1");
    assert.equal(payload.run_id, "run-1");
    assert.deepEqual(payload.continuation, {
      pi_wait: { session_id: "session-1", run_id: "run-1" },
      pi_status: { session_id: "session-1" }
    });
    const text = result.content?.[0]?.text || "";
    assert.match(text, /Pi task is still running after the requested wait; use pi_wait or pi_status/);
    // No-answer calls end with concise session/run references, never a payload dump.
    assert.ok(text.endsWith("\n\nsession session-1 · run run-1"), "expected references suffix in: " + text);
    assert.ok(!text.includes('"run_id"'), "no-answer text must not pretty-print the structured result");
  });
});

test("pi_wait accepts a 300s timeout without schema rejection and exposes the clamp metadata", async () => {
  const inputs = [];
  const service = {
    wait: async (input) => {
      inputs.push(input);
      return {
        timed_out: true,
        session_id: "session-1",
        run_id: "run-1",
        session: { session_id: "session-1", process_status: "running" },
        run: { run_id: "run-1", status: "running", model_status: "running", cleanup_status: "pending" },
        continuation: {
          pi_wait: { session_id: "session-1", run_id: "run-1" },
          pi_status: { session_id: "session-1" }
        },
        wait: { requested_seconds: 300, effective_seconds: 285, clamped: true, max_seconds: 285 }
      };
    }
  };
  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_wait",
      arguments: { session_id: "session-1", run_id: "run-1", timeout_seconds: 300 }
    });
    assert.equal(result.isError, undefined, "300s must stay schema-compatible, not rejected");
    assert.equal(inputs[0].timeout_seconds, 300, "the service receives the requested 300s and clamps internally");
    const payload = result.structuredContent?.result;
    assert.equal(payload.session_id, "session-1");
    assert.equal(payload.run_id, "run-1");
    assert.deepEqual(payload.wait, { requested_seconds: 300, effective_seconds: 285, clamped: true, max_seconds: 285 });
    assert.equal(payload.run.model_status, "running");
    assert.equal(payload.run.cleanup_status, "pending");
    assert.equal(payload.session.process_status, "running");
    assert.match(result.content?.[0]?.text || "", /continue with the returned continuation/);
  });
});

test("budget options are accepted on the high-level tools and validated positive and bounded", async () => {
  const inputs = [];
  const service = {
    task: async (input) => {
      inputs.push(input);
      return {
        timed_out: false,
        answer: "done",
        session_id: "session-1",
        run_id: "run-1",
        session: { session_id: "session-1" },
        run: { run_id: "run-1", status: "settled" },
        continuation: {
          pi_wait: { session_id: "session-1", run_id: "run-1" },
          pi_status: { session_id: "session-1" }
        }
      };
    }
  };
  await withClient(service, async (client) => {
    const task = await client.callTool({
      name: "pi_task",
      arguments: {
        message: "go",
        wait_seconds: 0,
        max_elapsed_seconds: 120,
        max_model_calls: 5,
        max_cost: 0.5
      }
    });
    assert.equal(task.error, undefined);
    assert.equal(inputs[0].max_elapsed_seconds, 120);
    assert.equal(inputs[0].max_model_calls, 5);
    assert.equal(inputs[0].max_cost, 0.5);

    const research = await client.callTool({
      name: "pi_research",
      arguments: {
        question: "q",
        wait_seconds: 0,
        max_elapsed_seconds: 60,
        budget: { max_model_calls: 4 }
      }
    });
    assert.equal(research.error, undefined);
    assert.equal(inputs[1].max_elapsed_seconds, 60);
    assert.deepEqual(inputs[1].budget, { max_model_calls: 4 });
    assert.equal(inputs[1].profile, "research");

    const review = await client.callTool({
      name: "pi_review",
      arguments: {
        request: "r",
        wait_seconds: 0,
        max_cost: 1,
        budget: { max_elapsed_seconds: 30 }
      }
    });
    assert.equal(review.error, undefined);
    assert.equal(inputs[2].max_cost, 1);
    assert.deepEqual(inputs[2].budget, { max_elapsed_seconds: 30 });
    assert.equal(inputs[2].profile, "review");

    for (const bad of [0, -1]) {
      const rejected = await client.callTool({
        name: "pi_task",
        arguments: { message: "go", max_elapsed_seconds: bad }
      });
      assert.equal(rejected.isError, true, "max_elapsed_seconds=" + bad + " must be rejected");
    }
    const fractionalCalls = await client.callTool({
      name: "pi_task",
      arguments: { message: "go", max_model_calls: 2.5 }
    });
    assert.equal(fractionalCalls.isError, true, "max_model_calls must be an integer");
    const oversized = await client.callTool({
      name: "pi_task",
      arguments: { message: "go", max_cost: 100000 }
    });
    assert.equal(oversized.isError, true, "max_cost must be bounded");
  });
});

test("accepted run failures preserve ids and continuation in error results", async () => {
  const acceptedResult = {
    answer: null,
    session_id: "session-accepted",
    run_id: "run-accepted",
    session: { session_id: "session-accepted", process_status: "running" },
    run: { run_id: "run-accepted", status: "error", error: "prompt rejected" },
    continuation: {
      pi_wait: { session_id: "session-accepted", run_id: "run-accepted" },
      pi_status: { session_id: "session-accepted" }
    }
  };
  const service = {
    task: async () => {
      throw new PiLocalError("prompt_failed", "prompt rejected", {
        accepted_result: acceptedResult
      });
    }
  };

  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_task",
      arguments: { message: "go", wait_seconds: 0 }
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.answer, null);
    const { answer, ...expectedResult } = acceptedResult;
    assert.deepEqual(result.structuredContent?.result, expectedResult);
    assert.equal(result.structuredContent?.untrustedContent, true);
    assert.match(result.content?.[0]?.text || "", /^prompt_failed: prompt rejected/);
    assert.match(result.content?.[0]?.text || "", /session session-accepted · run run-accepted$/);
  });
});

test("dispatched pi_task results carry ids and a continuation for pi_wait/pi_status", async () => {
  const service = {
    task: async () => ({
      timed_out: false,
      answer: null,
      session_id: "session-1",
      run_id: "run-1",
      session: { session_id: "session-1", process_status: "running" },
      run: { run_id: "run-1", status: "accepted", model_status: "idle", cleanup_status: "pending" },
      continuation: {
        pi_wait: { session_id: "session-1", run_id: "run-1" },
        pi_status: { session_id: "session-1" }
      }
    })
  };
  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_task",
      arguments: { message: "go", wait_seconds: 0 }
    });
    assert.equal(result.error, undefined);
    const payload = result.structuredContent?.result;
    assert.equal(payload.session_id, "session-1");
    assert.equal(payload.run_id, "run-1");
    assert.equal(payload.run.model_status, "idle");
    assert.equal(payload.run.cleanup_status, "pending");
    assert.deepEqual(payload.continuation.pi_wait, { session_id: "session-1", run_id: "run-1" });
    assert.match(result.content?.[0]?.text || "", /session session-1 · run run-1/);
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

test("high-level tools thread session_id reuse and auto_close; reuse suppresses start-only defaults", async () => {
  const inputs = [];
  const service = {
    task: async (input) => {
      inputs.push(input);
      return settledTask();
    }
  };

  await withClient(service, async (client) => {
    const review = await client.callTool({
      name: "pi_review",
      arguments: { request: "Re-review the diff.", session_id: "session-9", auto_close: true }
    });
    assert.equal(review.error, undefined);
    assert.equal(inputs[0].session_id, "session-9");
    assert.equal(inputs[0].auto_close, true);
    assert.equal(inputs[0].profile, "review", "reuse still enforces the review profile.");
    assert.equal(inputs[0].provider, undefined, "reuse must not inject the DeepSeek review default.");
    assert.equal(inputs[0].model, undefined, "reuse must not inject the DeepSeek Pro review default.");
    assert.equal(inputs[0].thinking, undefined);

    const research = await client.callTool({
      name: "pi_research",
      arguments: { question: "Keep researching.", session_id: "session-8", auto_close: true }
    });
    assert.equal(research.error, undefined);
    assert.equal(inputs[1].session_id, "session-8");
    assert.equal(inputs[1].auto_close, true);
    assert.equal(inputs[1].profile, "research");
    assert.equal(inputs[1].provider, undefined);
    assert.equal(inputs[1].model, undefined);

    const task = await client.callTool({
      name: "pi_task",
      arguments: { message: "Continue.", session_id: "session-7", auto_close: true }
    });
    assert.equal(task.error, undefined);
    assert.equal(inputs[2].session_id, "session-7");
    assert.equal(inputs[2].auto_close, true);
    assert.equal(inputs[2].profile, undefined, "pi_task leaves the default profile unset; the service enforces workspace.");
  });

  // Fresh calls still get the review defaults.
  await withClient(service, async (client) => client.callTool({
    name: "pi_review",
    arguments: { request: "Fresh review." }
  }));
  assert.equal(inputs[3].session_id, undefined);
  assert.equal(inputs[3].provider, "deepseek");
  assert.equal(inputs[3].model, "deepseek-v4-pro");
});

test("reuse conflicts surface as tool errors with the service code", async () => {
  const service = {
    task: async (input) => {
      if (input.session_id && input.provider) {
        throw new PiLocalError("reuse_conflict", "session_id cannot be combined with provider.");
      }
      return settledTask();
    }
  };
  await withClient(service, async (client) => {
    const taskResult = await client.callTool({
      name: "pi_task",
      arguments: { message: "go", session_id: "session-1", provider: "deepseek" }
    });
    assert.equal(taskResult.isError, true);
    assert.match(taskResult.content?.[0]?.text || "", /reuse_conflict/);

    const reviewResult = await client.callTool({
      name: "pi_review",
      arguments: { request: "go", session_id: "session-1", provider: "deepseek" }
    });
    assert.equal(reviewResult.isError, true);
    assert.match(reviewResult.content?.[0]?.text || "", /reuse_conflict/);
  });
});

test("pi_sessions lists a minimal session directory and include_details restores diagnostics", async () => {
  const calls = [];
  const service = {
    listSessions: async (input) => {
      calls.push(input);
      const live = {
        session_id: "session-1",
        lifecycle: "running",
        process_status: "running",
        workspace: "/mnt/d/WorkSpace/pi-local-mcp",
        profile: "review",
        created_at: "2026-08-01T00:00:00.000Z",
        pi_session_id: "pi-1",
        pi_session_name: "Review pass",
        active_run: { run_id: "run-1", status: "running" },
        pending_ui_request_count: 1
      };
      const saved = [{
        pi_session_id: "pi-9",
        workspace: "/mnt/d/WorkSpace",
        created_at: "2026-07-01T00:00:00.000Z",
        modified_at: "2026-07-02T00:00:00.000Z"
      }];
      if (input.include_details) {
        live.job = {
          run_id: "run-1",
          status: "running",
          recent_events: [{ type: "tool_execution_start", tool_name: "read" }]
        };
        saved[0].bytes = 1234;
      }
      return {
        live_sessions: [live],
        saved_sessions: saved
      };
    }
  };

  await withClient(service, async (client) => {
    const compact = await client.callTool({ name: "pi_sessions", arguments: {} });
    const compactLive = compact.structuredContent?.result?.live_sessions?.[0];
    assert.equal(compactLive.job, undefined);
    assert.equal(compactLive.pi_session_file, undefined);
    assert.equal(compactLive.model, undefined);
    assert.equal(compactLive.pending_ui_requests, undefined);
    assert.equal(compactLive.process_status, "running", "process state must be explicit next to run state.");
    assert.equal(compactLive.lifecycle, "running");
    assert.deepEqual(compactLive.active_run, { run_id: "run-1", status: "running" });
    assert.equal(compactLive.pending_ui_request_count, 1);
    const compactSaved = compact.structuredContent?.result?.saved_sessions?.[0];
    assert.deepEqual(compactSaved, {
      pi_session_id: "pi-9",
      workspace: "/mnt/d/WorkSpace",
      created_at: "2026-07-01T00:00:00.000Z",
      modified_at: "2026-07-02T00:00:00.000Z"
    });
    assert.equal(compactSaved.bytes, undefined);
    assert.equal(compactSaved.session_file, undefined);
    assert.ok(!calls[0].include_details);

    const detailed = await client.callTool({
      name: "pi_sessions",
      arguments: { include_details: true }
    });
    const detailedLive = detailed.structuredContent?.result?.live_sessions?.[0];
    assert.equal(detailedLive.job.run_id, "run-1");
    assert.equal(detailedLive.job.recent_events.length, 1);
    assert.equal(detailed.structuredContent?.result?.saved_sessions?.[0]?.bytes, 1234);
    assert.equal(detailed.structuredContent?.result?.saved_sessions?.[0]?.session_file, undefined);
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
