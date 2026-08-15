import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createPiMcpServer } from "../src/server.mjs";
import { PiWslError } from "../src/util.mjs";

async function withClient(service, run, options = {}) {
  // The helper pins the full toolset by default because the existing tests
  // exercise the complete 20-tool surface. Tests proving the server's own
  // default-core behavior pass injectToolset: false; an explicit toolset
  // option selects that surface directly.
  const configured = options.injectToolset === false
    ? service
    : { ...service, config: { toolset: options.toolset ?? "full", ...(service?.config || {}) } };
  const server = createPiMcpServer(configured);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pi-wsl-mcp-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

// The daily-agent workflow surface of the default core toolset and the
// diagnostics/advanced controls that only the full toolset registers.
const CORE_TOOLSET_TOOLS = [
  "pi_task", "pi_research", "pi_review", "pi_send", "pi_wait", "pi_status",
  "pi_sessions", "pi_resume_session", "pi_close_session"
];
const FULL_ONLY_TOOLS = [
  "pi_info", "pi_start_session", "pi_cancel", "pi_respond_ui", "pi_history",
  "pi_models", "pi_set_model", "pi_set_thinking", "pi_compact", "pi_fork", "pi_commands"
];

function settledTask(answer = "Pi completed the requested read-only task.") {
  return {
    timed_out: false,
    answer,
    session: { session_id: "session-1", workspace: "/home/user/pi-wsl-mcp" },
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
  // Compact by default: content[0].text is the single final-text carrier and
  // the structured part carries answer_meta instead of a duplicate answer.
  assert.deepEqual(result.structuredContent?.answer_meta, {
    has_answer: true,
    truncated: false,
    original_chars: answer.length
  });
  assert.equal(result.structuredContent?.success, true, "answer-first results are structured successes");
  assert.equal(result.structuredContent?.answer, undefined);
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
    assert.equal(result.structuredContent?.answer_meta?.has_answer, false);
    assert.equal(result.structuredContent?.success, true, "a requested-wait timeout is still a structured success");
    assert.equal(result.structuredContent?.answer_meta?.truncated, false);
    assert.equal(result.structuredContent?.answer_meta?.original_chars, 0);
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
      throw new PiWslError("prompt_failed", "prompt rejected", {
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
    assert.equal(result.structuredContent?.success, false, "an accepted run that later failed is a failed operation (success=false, isError=true)");
    assert.equal(result.structuredContent?.answer_meta?.has_answer, false);
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
      return settledTask("The package name is pi-wsl-mcp.");
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
    assert.equal(waited.structuredContent?.answer_meta?.has_answer, true);
    assert.equal(waited.structuredContent?.answer_meta?.truncated, false);
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
        answer: "The package name is pi-wsl-mcp.",
        session: { session_id: "session-1" },
        run: {
          run_id: "run-1",
          status: "settled",
          started_at: "2026-08-01T00:00:00.000Z",
          settled_at: "2026-08-01T00:01:00.000Z",
          prompt_kind: "prompt",
          error: null,
          pending_ui_requests: [],
          result: { assistant_text: "The package name is pi-wsl-mcp." },
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
    assert.deepEqual(result.structuredContent?.answer_meta, {
      has_answer: true,
      truncated: false,
      original_chars: "The package name is pi-wsl-mcp.".length
    });
    assert.equal(result.structuredContent?.result?.run?.result?.assistant_text, "The package name is pi-wsl-mcp.");
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
  assert.equal(research.structuredContent?.answer_meta?.has_answer, true);
  assert.equal(research.structuredContent?.answer_meta?.truncated, false);
  assert.match(research.content?.[0]?.text || "", /Searched sources\./);
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
        throw new PiWslError("reuse_conflict", "session_id cannot be combined with provider.");
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
        workspace: "/home/user/pi-wsl-mcp",
        profile: "review",
        created_at: "2026-08-01T00:00:00.000Z",
        pi_session_id: "pi-1",
        pi_session_name: "Review pass",
        active_run: { run_id: "run-1", status: "running" },
        pending_ui_request_count: 1
      };
      const saved = [{
        pi_session_id: "pi-9",
        workspace: "/home/user/work",
        created_at: "2026-07-01T00:00:00.000Z",
        modified_at: "2026-07-02T00:00:00.000Z",
        name: "Review pass",
        summary: "Check the unstaged diff"
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
      workspace: "/home/user/work",
      created_at: "2026-07-01T00:00:00.000Z",
      modified_at: "2026-07-02T00:00:00.000Z",
      name: "Review pass",
      summary: "Check the unstaged diff"
    });
    assert.equal(compactSaved.bytes, undefined);
    assert.equal(compactSaved.session_file, undefined);
    assert.equal(
      compact.structuredContent?.success,
      true,
      "pi_sessions succeeds even though its directory result has no answer"
    );
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

test("PI_WSL_MCP_RESULT_LIMIT bounds the final answer and truncation is explicit", async () => {
  const longAnswer = "The package name is pi-wsl-mcp and it bridges the Pi coding agent into MCP hosts from WSL. ".repeat(4);
  const service = {
    config: { resultLimit: 60 },
    task: async () => ({
      timed_out: false,
      answer: longAnswer,
      session: { session_id: "session-1" },
      run: { run_id: "run-1", status: "settled", error: null, pending_ui_requests: [] }
    })
  };
  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_task",
      arguments: { message: "go", wait_seconds: 0 }
    });
    const meta = result.structuredContent?.answer_meta;
    assert.deepEqual(meta, { has_answer: true, truncated: true, original_chars: longAnswer.length });
    // The final text lives exactly once: in content[0].text, cut at the limit
    // with an explicit truncation marker, never duplicated in structured data.
    const text = result.content?.[0]?.text || "";
    assert.ok(text.startsWith("Pi answer (untrusted):\n"));
    const summaryStart = text.indexOf("\n\nPi completed a new task.");
    assert.ok(summaryStart > 0, "the summary must follow the bounded answer");
    const shown = text.slice("Pi answer (untrusted):\n".length, summaryStart);
    assert.equal(shown.length, 60 + "\n… [truncated]".length);
    assert.ok(shown.endsWith("… [truncated]"));
    assert.equal(result.structuredContent?.answer, undefined);
    assert.ok(!JSON.stringify(result.structuredContent).includes(longAnswer.slice(0, 200)), "the full answer must not be duplicated in structuredContent");
  });
});

test("error results carry answer_meta with no answer and keep the accepted snapshot", async () => {
  const service = {
    task: async () => {
      throw new PiWslError("prompt_failed", "prompt rejected", {
        accepted_result: {
          answer: null,
          session_id: "session-accepted",
          run_id: "run-accepted",
          session: { session_id: "session-accepted", process_status: "running" },
          run: { run_id: "run-accepted", status: "error", error: "prompt rejected" },
          continuation: {
            pi_wait: { session_id: "session-accepted", run_id: "run-accepted" },
            pi_status: { session_id: "session-accepted" }
          }
        }
      });
    }
  };
  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_task",
      arguments: { message: "go", wait_seconds: 0 }
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.success, false, "accepted structured errors must not claim success");
    assert.deepEqual(result.structuredContent?.answer_meta, {
      has_answer: false,
      truncated: false,
      original_chars: 0
    });
    assert.equal(result.structuredContent?.answer, undefined);
    assert.equal(result.structuredContent?.result?.run?.status, "error");
  });
});

test("plain rejected errors stay isError-only and never carry a structured success", async () => {
  const service = {
    status: async () => {
      throw new PiWslError("unknown_session", "No live Pi session exists with id missing.");
    }
  };
  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_status",
      arguments: { session_id: "missing" }
    });
    assert.equal(result.isError, true, "unaccepted rejections keep isError semantics");
    assert.equal(result.structuredContent, undefined, "plain errors carry no success signal");
    assert.match(result.content?.[0]?.text || "", /unknown_session/);
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

test("the default core toolset registers exactly the daily-agent workflow tools", async () => {
  // injectToolset: false keeps the service untouched, so the server's own
  // default (core, matching createConfig) is exercised.
  await withClient({ task: async () => settledTask() }, async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...CORE_TOOLSET_TOOLS].sort(), "core must register exactly the daily-agent workflow tools");
    for (const name of FULL_ONLY_TOOLS) {
      assert.ok(!tools.tools.some((tool) => tool.name === name), "core must not register " + name);
    }
    const instructions = client.getInstructions() || "";
    // Compact, journey-first instructions: the fastest routes come first and
    // the core/full boundary stays truthful without enumerating tools.
    assert.ok(instructions.length < 460, "core instructions must stay compact (" + instructions.length + " chars)");
    assert.match(instructions, /Core toolset \(PI_WSL_MCP_TOOLSET=core\)/);
    assert.match(instructions, /pi_task: one-call workspace work/);
    assert.match(instructions, /pi_research\/pi_review: read-only work/);
    assert.match(instructions, /pi_send: prompt or steer live work/);
    assert.match(instructions, /pi_wait\/pi_status: follow a run/);
    assert.match(instructions, /pi_sessions\/pi_resume_session: find or reopen saved work/);
    assert.match(instructions, /pi_close_session: free a live slot/);
    const coreOrder = ["pi_task", "pi_research", "pi_send", "pi_wait", "pi_sessions", "pi_close_session"];
    assert.ok(
      coreOrder.every((name, i) => i === 0 || instructions.indexOf(name) > instructions.indexOf(coreOrder[i - 1])),
      "core instructions must lead with the fastest user journeys in order"
    );
    assert.match(instructions, /Use full for cancel, history, models, UI responses, compact, fork, and commands/, "core instructions must keep the full-only boundary useful");
    assert.ok(!instructions.includes("pi_history"), "core instructions must not advertise full-only tools");
  }, { injectToolset: false });
});

test("the full toolset registers all 20 tools with their current names and core keeps its 9", async () => {
  const core = await withClient({ task: async () => settledTask() }, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.length, CORE_TOOLSET_TOOLS.length);
    assert.match(client.getInstructions() || "", /Core toolset/);
    const coreInstructions = client.getInstructions() || "";
    assert.ok(coreInstructions.length < 460, "core instructions must stay compact");
    return names;
  }, { toolset: "core" });

  const full = await withClient({ task: async () => settledTask() }, async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.equal(names.length, 20, "full must keep the complete 20-tool surface");
    for (const name of [...CORE_TOOLSET_TOOLS, ...FULL_ONLY_TOOLS]) {
      assert.ok(names.includes(name), "full must register " + name);
    }
    const fullInstructions = client.getInstructions() || "";
    assert.ok(fullInstructions.length < 340, "full instructions must stay compact (" + fullInstructions.length + " chars)");
    assert.match(fullInstructions, /pi_task: one-call workspace work/);
    assert.match(fullInstructions, /pi_research\/pi_review: read-only work/);
    assert.match(fullInstructions, /pi_send: prompt or steer live work/);
    assert.match(fullInstructions, /pi_wait\/pi_status: follow a run/);
    assert.match(fullInstructions, /pi_sessions\/pi_resume_session: find or reopen saved work/);
    assert.match(fullInstructions, /pi_close_session: free a live slot/);
    assert.match(fullInstructions, /Full also provides cancel, history, models, UI responses, compact, fork, and commands/);
    const fullOrder = ["pi_task", "pi_research", "pi_send", "pi_wait", "pi_sessions", "pi_close_session"];
    assert.ok(
      fullOrder.every((name, i) => i === 0 || fullInstructions.indexOf(name) > fullInstructions.indexOf(fullOrder[i - 1])),
      "full instructions must lead with the fastest user journeys in order"
    );
    assert.ok(!fullInstructions.includes("PI_WSL_MCP_TOOLSET"), "full instructions must not reference core-only env configuration");
    return names;
  });

  for (const name of CORE_TOOLSET_TOOLS) {
    assert.ok(full.includes(name), "full must keep the core tool " + name);
  }
  assert.ok(full.includes("pi_info") && !core.includes("pi_info"));
  assert.ok(full.includes("pi_history") && !core.includes("pi_history"));
  assert.ok(full.includes("pi_steer") === false, "pi_steer must never be registered");
});

test("an explicit core toolset config registers the same surface as the default", async () => {
  await withClient({ task: async () => settledTask() }, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), [...CORE_TOOLSET_TOOLS].sort());
  }, { toolset: "core" });
});

test("budget-exhausted runs without a final answer say so and keep the structured budget fields", async () => {
  const service = {
    task: async () => ({
      timed_out: false,
      answer: null,
      session_id: "session-budget",
      run_id: "run-budget",
      session: { session_id: "session-budget", process_status: "running" },
      run: {
        run_id: "run-budget",
        status: "error",
        error: "Pi's max_model_calls budget was exhausted before a final answer was collected.",
        budget: { max_elapsed_seconds: 60, max_model_calls: 5, max_cost: null },
        budget_exceeded: "model_calls",
        pending_ui_requests: []
      },
      continuation: {
        pi_wait: { session_id: "session-budget", run_id: "run-budget" },
        pi_status: { session_id: "session-budget" }
      }
    })
  };

  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_task",
      arguments: { message: "go", wait_seconds: 30, max_model_calls: 5 }
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.success, true, "a budget-exhausted structured result is still a successful call");
    assert.deepEqual(result.structuredContent?.answer_meta, {
      has_answer: false,
      truncated: false,
      original_chars: 0
    });
    // Structured budget fields are preserved verbatim.
    assert.equal(result.structuredContent?.result?.run?.budget_exceeded, "model_calls");
    assert.deepEqual(result.structuredContent?.result?.run?.budget, {
      max_elapsed_seconds: 60,
      max_model_calls: 5,
      max_cost: null
    });
    const text = result.content?.[0]?.text || "";
    assert.match(text, /max_model_calls=5 budget was exhausted before a final answer was collected/);
    assert.match(text, /run was cancelled without an answer/);
    assert.match(text, /Retry without that budget limit, or with a higher max_model_calls/);
    assert.match(text, /structured result keeps the effective budget fields/);
    assert.ok(!text.includes("api_key") && !text.includes("provider error"), "no raw provider text may leak");
    assert.ok(text.endsWith("\n\nsession session-budget · run run-budget"));
  });
});

test("elapsed and cost budget exhaustion get the same explicit no-answer treatment", async () => {
  const service = {
    wait: async () => ({
      timed_out: false,
      answer: null,
      session: { session_id: "session-1" },
      run: {
        run_id: "run-1",
        status: "error",
        error: null,
        budget: { max_elapsed_seconds: 30, max_model_calls: null, max_cost: null },
        budget_exceeded: "elapsed",
        pending_ui_requests: []
      }
    })
  };
  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_wait",
      arguments: { session_id: "session-1", run_id: "run-1", timeout_seconds: 5 }
    });
    const text = result.content?.[0]?.text || "";
    assert.match(text, /max_elapsed_seconds=30 budget was exhausted/);
    assert.match(text, /with a higher max_elapsed_seconds/);
    assert.equal(result.structuredContent?.result?.run?.budget_exceeded, "elapsed");
  });
});
