import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import createEolGuardExtension, {
  SCAN_LIMIT,
  SYSTEM_PROMPT_APPEND,
  SYSTEM_PROMPT_MARKER,
  detectLineEndings,
  normalizeLineEndings
} from "../src/eol-extension.mjs";

async function loadExtension() {
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    }
  };
  await createEolGuardExtension(pi);
  return handlers;
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-wsl-mcp-eol-"));
  try {
    return await run(dir);
  } finally {
    // Leave cleanup to the OS temp dir; test contents are tiny.
  }
}

test("detectLineEndings classifies consistent styles and rejects mixed or none", () => {
  assert.equal(detectLineEndings("a\r\nb\r\nc"), "\r\n");
  assert.equal(detectLineEndings("a\nb\nc"), "\n");
  assert.equal(detectLineEndings("one line"), null, "files without newlines have no style");
  assert.equal(detectLineEndings(""), null);
  assert.equal(detectLineEndings("a\r\nb\nc"), "mixed");
  assert.equal(detectLineEndings("a\nb\r\nc"), "mixed");
  assert.equal(detectLineEndings("a\rb"), "mixed", "lone CR is neither CRLF nor LF");
});

test("normalizeLineEndings rewrites content to the target style only", () => {
  assert.equal(normalizeLineEndings("a\nb\r\nc", "\r\n"), "a\r\nb\r\nc");
  assert.equal(normalizeLineEndings("a\nb\r\nc\rd", "\n"), "a\nb\nc\nd");
  assert.equal(normalizeLineEndings("a\nb", "\n"), "a\nb");
  assert.equal(normalizeLineEndings("a\nb", "mixed"), "a\nb", "unknown styles never rewrite");
});

test("the extension registers only its two session-scoped hooks", async () => {
  const handlers = await loadExtension();
  assert.ok(handlers.has("tool_call"));
  assert.ok(handlers.has("before_agent_start"));
  assert.deepEqual(Array.from(handlers.keys()).sort(), ["before_agent_start", "tool_call"]);
});

test("write to an existing CRLF file is rewritten to CRLF before execution", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "crlf.txt");
    await writeFile(target, "keep\r\nthese\r\nendings\r\n");
    const handlers = await loadExtension();
    const event = { toolName: "write", input: { path: target, content: "new\ncontent\r\nmixed" } };
    await handlers.get("tool_call")[0](event);
    assert.equal(event.input.content, "new\r\ncontent\r\nmixed");
  });
});

test("write to an existing LF file is rewritten to LF before execution", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "lf.txt");
    await writeFile(target, "keep\nlf\nendings\n");
    const handlers = await loadExtension();
    const event = { toolName: "write", input: { path: target, content: "new\r\ncontent\r\nmixed" } };
    await handlers.get("tool_call")[0](event);
    assert.equal(event.input.content, "new\ncontent\nmixed");
  });
});

test("new, binary, no-newline, and mixed-EOL targets are left unchanged", async () => {
  await withTempDir(async (dir) => {
    const binary = path.join(dir, "blob.bin");
    await writeFile(binary, Buffer.from([0x00, 0x01, 0x0a, 0x0d, 0x0a]));
    const noNewline = path.join(dir, "flat.txt");
    await writeFile(noNewline, "no newlines here");
    const mixed = path.join(dir, "mixed.txt");
    await writeFile(mixed, "a\r\nb\nc");
    const missing = path.join(dir, "new.txt");

    const handlers = await loadExtension();
    for (const [target, content] of [
      [binary, "x\nbinary\ny"],
      [noNewline, "x\ny"],
      [mixed, "x\ny"],
      [missing, "brand\nnew\nfile"]
    ]) {
      const event = { toolName: "write", input: { path: target, content } };
      await handlers.get("tool_call")[0](event);
      assert.equal(event.input.content, content, "write content must stay untouched for " + path.basename(target));
    }
  });
});

test("non-write tool calls are never touched", async () => {
  const handlers = await loadExtension();
  const event = { toolName: "edit", input: { path: "/nonexistent", content: "anything" } };
  await handlers.get("tool_call")[0](event);
  assert.equal(event.input.content, "anything");
});

test("relative write paths resolve against the bridge working directory", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "lf.txt"), "lf\nstyle\n");
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const handlers = await loadExtension();
      const event = { toolName: "write", input: { path: "lf.txt", content: "a\r\nb" } };
      await handlers.get("tool_call")[0](event);
      assert.equal(event.input.content, "a\nb");
    } finally {
      process.chdir(previous);
    }
  });
});

test("files larger than the scan bound are analyzed from their first bytes only", async () => {
  await withTempDir(async (dir) => {
    const large = path.join(dir, "large.txt");
    // LF style established in the first bytes; the tail is beyond the bound.
    await writeFile(large, "lf\nstyle\n" + "x".repeat(SCAN_LIMIT));
    const handlers = await loadExtension();
    const event = { toolName: "write", input: { path: large, content: "a\r\nb" } };
    await handlers.get("tool_call")[0](event);
    assert.equal(event.input.content, "a\nb", "the sampled beginning must drive the style");
  });
});

test("before_agent_start appends the EOL guidance exactly once", async () => {
  const handlers = await loadExtension();
  const beforeAgentStart = handlers.get("before_agent_start")[0];
  const result = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "do work",
    systemPrompt: "Base system prompt."
  });
  assert.equal(result.systemPrompt, "Base system prompt.\n\n" + SYSTEM_PROMPT_APPEND);
  assert.ok(result.systemPrompt.includes("prefer Pi's edit tool"));
  assert.ok(result.systemPrompt.includes(".gitattributes"));
  assert.ok(result.systemPrompt.includes("cannot be rewritten safely"));

  const second = await beforeAgentStart({ type: "before_agent_start", prompt: "again", systemPrompt: result.systemPrompt });
  assert.equal(second, undefined, "the marker must prevent duplicate appends");
});

test("before_agent_start leaves empty or marked system prompts untouched", async () => {
  const handlers = await loadExtension();
  const beforeAgentStart = handlers.get("before_agent_start")[0];
  assert.equal(await beforeAgentStart({ type: "before_agent_start", prompt: "x", systemPrompt: "" }), undefined);
  assert.equal(
    await beforeAgentStart({ type: "before_agent_start", prompt: "x", systemPrompt: SYSTEM_PROMPT_MARKER + " already there" }),
    undefined
  );
});
