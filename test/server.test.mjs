import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createPiMcpServer } from "../src/server.mjs";
import { PiWslError } from "../src/util.mjs";

async function withClient(service, run, options = {}) {
  // The helper pins the full toolset by default because the existing tests
  // exercise the complete 21-tool surface. Tests proving the server's own
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

// The daily-agent workflow surface of the default core toolset, plus the
// continuation controls shared with full; remaining diagnostics stay full-only.
const CORE_TOOLSET_TOOLS = [
  "pi_task", "pi_research", "pi_review", "pi_wait", "pi_status", "pi_kill_session"
];
const FULL_ONLY_TOOLS = [
  "pi_info", "pi_start_session", "pi_send", "pi_cancel",
  "pi_respond_ui", "pi_history", "pi_sessions", "pi_resume_session", "pi_models",
  "pi_set_model", "pi_set_thinking", "pi_compact", "pi_fork", "pi_commands", "pi_close_session"
];

function settledTask(answer = "Pi completed the requested read-only task.") {
  return { status: "completed", answer, error: null };
}

function assertAnswerFirst(result, answer) {
  assert.deepEqual(result.structuredContent, { status: "completed", untrustedContent: true });
  assert.equal(result.structuredContent?.untrustedContent, true);
  assert.equal(result.content?.[0]?.text, "Pi review result (untrusted):\n" + answer);
}

test("high-level Pi workflows expose a direct, answer-first untrusted result", async () => {
  const taskInputs = [];
  const service = {
    runOnce: async (input) => {
      taskInputs.push(input);
      return settledTask();
    }
  };

  await withClient(service, async (client) => {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 21);
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
  assert.equal(taskInputs[0].wait_seconds, undefined);
});

test("high-level workflows reject legacy async controls", async () => {
  await withClient({ runOnce: async () => settledTask() }, async (client) => {
    for (const arguments_ of [
      { message: "go", wait_seconds: 30 },
      { message: "go", session_id: "session-1" },
      { message: "go", include_details: true },
      { message: "go", auto_close: false }
    ]) {
      const result = await client.callTool({ name: "pi_task", arguments: arguments_ });
      assert.equal(result.isError, true);
      assert.match(result.content?.[0]?.text || "", /Unrecognized key/);
    }
  });
});

test("pi_wait removes the public timeout parameter and keeps continuation controls", async () => {
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
          pi_status: { session_id: "session-1" },
          pi_kill_session: { session_id: "session-1" }
        }
      };
    }
  };
  await withClient(service, async (client) => {
    const rejected = await client.callTool({
      name: "pi_wait",
      arguments: { session_id: "session-1", run_id: "run-1", timeout_seconds: 300 }
    });
    assert.equal(rejected.isError, true, "timeout_seconds must no longer be accepted");
    assert.equal(inputs.length, 0);
    const result = await client.callTool({
      name: "pi_wait",
      arguments: { session_id: "session-1", run_id: "run-1" }
    });
    assert.equal(inputs[0].timeout_seconds, undefined);
    const payload = result.structuredContent?.result;
    assert.equal(payload.session_id, "session-1");
    assert.equal(payload.run_id, "run-1");
    assert.equal(payload.wait, undefined);
    assert.equal(payload.run.model_status, "running");
    assert.equal(payload.run.cleanup_status, "pending");
    assert.equal(payload.session.process_status, "running");
    assert.match(result.content?.[0]?.text || "", /continue with the returned continuation/);
  });
});

test("budget fields are rejected by every high-level workflow", async () => {
  const inputs = [];
  const service = {
    runOnce: async (input) => {
      inputs.push(input);
      return settledTask("done");
    }
  };
  await withClient(service, async (client) => {
    const cases = [
      ["pi_task", { message: "go", max_elapsed_seconds: 120 }],
      ["pi_task", { message: "go", max_model_calls: 5 }],
      ["pi_task", { message: "go", max_cost: 0.5 }],
      ["pi_research", { question: "q", budget: { max_model_calls: 4 } }],
      ["pi_review", { request: "r", max_cost: 1 }]
    ];
    for (const [name, arguments_] of cases) {
      const rejected = await client.callTool({ name, arguments: arguments_ });
      assert.equal(rejected.isError, true, name + " must reject budget fields");
      assert.match(rejected.content?.[0]?.text || "", /Unrecognized key/);
    }
  });
  assert.equal(inputs.length, 0, "a rejected budget field must never start Pi");
});

test("high-level failures return only a minimal terminal error", async () => {
  const service = {
    runOnce: async () => ({ status: "failed", answer: null, error: "prompt rejected" })
  };
  await withClient(service, async (client) => {
    const result = await client.callTool({ name: "pi_task", arguments: { message: "go" } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { status: "failed", untrustedContent: true });
    assert.equal(JSON.stringify(result).includes("session_id"), false);
    assert.equal(JSON.stringify(result).includes("run_id"), false);
    assert.match(result.content?.[0]?.text || "", /prompt rejected/);
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
      return {
        answer: "The package name is pi-wsl-mcp.",
        timed_out: false,
        session: { session_id: "session-1" },
        run: { run_id: "run-1", status: "settled" }
      };
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
      arguments: { session_id: "session-1", run_id: "run-1" }
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
    runOnce: async () => settledTask(longAnswer)
  };
  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_task",
      arguments: { message: "go" }
    });
    assert.deepEqual(result.structuredContent, { status: "completed", untrustedContent: true });
    const text = result.content?.[0]?.text || "";
    assert.ok(text.startsWith("Pi task result (untrusted):\n"));
    const shown = text.slice("Pi task result (untrusted):\n".length);
    assert.equal(shown.length, 60 + "\n… [truncated]".length);
    assert.ok(shown.endsWith("… [truncated]"));
    assert.ok(!JSON.stringify(result.structuredContent).includes(longAnswer.slice(0, 200)), "the full answer must not be duplicated in structuredContent");
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

test("pi_status exposes include_details and keeps the answer out of structured snapshots", async () => {
  const calls = [];
  const service = {
    status: async (input) => {
      calls.push(input);
      return {
        session_id: "session-1",
        lifecycle: "running",
        job: input.include_details
          ? {
              run_id: "run-1",
              status: "settled",
              result: { assistant_text: "must stay in content" },
              recent_events: [{ type: "agent_settled" }]
            }
          : { run_id: "run-1", status: "running" },
        continuation: { pi_status: { session_id: "session-1" } }
      };
    }
  };

  await withClient(service, async (client) => {
    const statusTool = (await client.listTools()).tools.find((tool) => tool.name === "pi_status");
    assert.equal(statusTool.inputSchema.properties.include_details.type, "boolean");
    assert.deepEqual(statusTool.inputSchema.required, ["session_id"]);

    const compact = await client.callTool({ name: "pi_status", arguments: { session_id: "session-1" } });
    assert.equal(compact.structuredContent?.result?.job?.recent_events, undefined);

    const detailed = await client.callTool({ name: "pi_status", arguments: { session_id: "session-1", include_details: true } });
    assert.equal(calls[0].include_details, undefined);
    assert.equal(calls[1].include_details, true);
    assert.equal(detailed.structuredContent?.result?.job?.recent_events?.length, 1);
    assert.equal(detailed.structuredContent?.result?.job?.result?.assistant_text, undefined);
    assert.deepEqual(detailed.structuredContent?.result?.continuation, { pi_status: { session_id: "session-1" } });
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
      arguments: { session_id: "session-1", run_id: "run-1", include_details: true }
    });
    assert.equal(calls[0].include_details, true);
    assert.equal(result.structuredContent?.result?.run?.recent_events?.length, 1);
    assert.equal(result.structuredContent?.result?.run?.pending_ui_requests?.[0]?.id, "confirm-1");
    const text = result.content?.[0]?.text || "";
    assert.ok(!text.includes("recent_events"), "no-answer text must stay concise even with include_details");
  });
});

test("the default core toolset registers expert workflows and continuation controls", async () => {
  // injectToolset: false keeps the service untouched, so the server's own
  // default (core, matching createConfig) is exercised.
  await withClient({ runOnce: async () => settledTask() }, async (client) => {
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
    assert.match(instructions, /wait up to 10 minutes/);
    assert.match(instructions, /research and review are read-only/);
    assert.match(instructions, /pi_wait/);
  }, { injectToolset: false });
});

test("the full toolset keeps advanced lifecycle tools while core stays compact", async () => {
  const core = await withClient({ runOnce: async () => settledTask() }, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.length, CORE_TOOLSET_TOOLS.length);
    assert.match(client.getInstructions() || "", /wait up to 10 minutes/);
    const coreInstructions = client.getInstructions() || "";
    assert.ok(coreInstructions.length < 460, "core instructions must stay compact");
    return names;
  }, { toolset: "core" });

  const full = await withClient({ runOnce: async () => settledTask() }, async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.equal(names.length, 21, "full must keep the complete 21-tool surface");
    for (const name of [...CORE_TOOLSET_TOOLS, ...FULL_ONLY_TOOLS]) {
      assert.ok(names.includes(name), "full must register " + name);
    }
    const fullInstructions = client.getInstructions() || "";
    assert.ok(fullInstructions.length < 460, "full instructions must stay compact (" + fullInstructions.length + " chars)");
    assert.match(fullInstructions, /wait up to 10 minutes/);
    assert.match(fullInstructions, /explicit session, continuation, UI, and diagnostic controls/);
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
  await withClient({ runOnce: async () => settledTask() }, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), [...CORE_TOOLSET_TOOLS].sort());
  }, { toolset: "core" });
});

test("a high-level run can return a usable background continuation", async () => {
  const service = {
    runOnce: async () => ({
      status: "background",
      answer: null,
      session_id: "session-1",
      run_id: "run-1",
      continuation: {
        pi_wait: { session_id: "session-1", run_id: "run-1" },
        pi_status: { session_id: "session-1" },
        pi_kill_session: { session_id: "session-1" }
      }
    })
  };
  await withClient(service, async (client) => {
    const result = await client.callTool({ name: "pi_task", arguments: { message: "go" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      status: "background",
      session_id: "session-1",
      run_id: "run-1",
      continuation: {
        pi_wait: { session_id: "session-1", run_id: "run-1" },
        pi_status: { session_id: "session-1" },
        pi_kill_session: { session_id: "session-1" }
      },
      untrustedContent: true
    });
    assert.match(result.content?.[0]?.text || "", /continues in the background after the 10-minute synchronous window/);
    assert.match(result.content?.[0]?.text || "", /pi_kill_session/);
  });
});

test("pi_kill_session maps the force-exit service operation", async () => {
  const calls = [];
  const service = {
    killSession: async (input) => {
      calls.push(input);
      return { session_id: input.session_id, killed: true };
    }
  };
  await withClient(service, async (client) => {
    const result = await client.callTool({
      name: "pi_kill_session",
      arguments: { session_id: "session-1" }
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.result?.killed, true);
    assert.match(result.content?.[0]?.text || "", /Force-exited Pi session session-1/);
  });
  assert.deepEqual(calls, [{ session_id: "session-1" }]);
});
