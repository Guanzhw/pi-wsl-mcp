// Pi WSL MCP bundled, session-scoped Pi extension.
//
// Loaded by PiRpcProcess through `pi --extension <this file>` for every bridge
// session. It never touches user-level Pi configuration; it exists only for
// the lifetime of the spawned Pi process. Two jobs:
//
//  1. tool_call guard on Pi's builtin `write` tool: when the target is an
//     existing regular text file with consistent CRLF or LF endings, rewrite
//     the incoming content to that exact existing style before execution.
//     New files, binary files, empty/no-newline files, and mixed-EOL files are
//     left unchanged. Pi's builtin `edit` tool already preserves line endings,
//     so only `write` needs the guard.
//
//  2. before_agent_start system-prompt guidance: tell Pi to preserve existing
//     line endings, prefer exact edit for existing text files, honor
//     .gitattributes, and never attempt unsafe bulk line-ending cleanup via
//     shell commands (arbitrary bash rewrites cannot be claimed safe).
//
// EOL analysis is bounded: files up to SCAN_LIMIT bytes are analyzed in full;
// larger files are analyzed from their first SCAN_LIMIT bytes only. A sample
// that is cut mid-CRLF reads as mixed and the write is left unchanged, which
// is the conservative direction.

import { open, stat } from "node:fs/promises";
import path from "node:path";

export const SCAN_LIMIT = 1024 * 1024;
export const SYSTEM_PROMPT_MARKER = "[pi-wsl-mcp line-ending guard]";
export const SYSTEM_PROMPT_APPEND = SYSTEM_PROMPT_MARKER + " " +
  "Preserve the existing line-ending style (CRLF or LF) of any regular text file you modify. " +
  "For existing text files, prefer Pi's edit tool with exact replacements over write. " +
  "Honor .gitattributes line-ending directives. " +
  "Pi's write tool preserves the existing line-ending style of a regular text file automatically, " +
  "so no shell conversion is needed. " +
  "Do not attempt bulk line-ending cleanup with shell commands: rewriting many files at once " +
  "is unsafe, and arbitrary bash commands cannot be rewritten safely.";

// Pure EOL classification: returns "\r\n" for consistent CRLF, "\n" for
// consistent LF, "mixed" when styles are combined, or null when the text has
// no line endings at all.
export function detectLineEndings(text) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf += 1;
        i += 1;
      } else {
        cr += 1;
      }
    } else if (code === 10) {
      lf += 1;
    }
  }
  if (crlf === 0 && lf === 0 && cr === 0) {
    return null;
  }
  if (lf === 0 && cr === 0) {
    return "\r\n";
  }
  if (crlf === 0 && cr === 0) {
    return "\n";
  }
  return "mixed";
}

// Rewrite content to the given style ("\r\n" or "\n"); any other style returns
// the content unchanged.
export function normalizeLineEndings(content, style) {
  if (style === "\r\n") {
    return content.replace(/\r\n|\r|\n/g, "\r\n");
  }
  if (style === "\n") {
    return content.replace(/\r\n|\r/g, "\n");
  }
  return content;
}

// Resolve the style to preserve for an existing target file, or null when the
// file should be left alone: missing (new file), not a regular file, empty,
// binary (NUL bytes), or mixed/inconsistent endings.
async function existingLineEndings(filePath) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    return null;
  }
  if (!fileStat.isFile() || fileStat.size === 0) {
    return null;
  }
  const buffer = Buffer.alloc(Math.min(SCAN_LIMIT, fileStat.size));
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    return null;
  }
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
  } catch (error) {
    return null;
  } finally {
    await handle.close();
  }
  const sample = buffer.subarray(0, bytesRead).toString("utf8");
  // NUL bytes indicate byte-oriented (binary) content, not text.
  if (sample.includes("\0")) {
    return null;
  }
  const style = detectLineEndings(sample);
  return style === "\r\n" || style === "\n" ? style : null;
}

export default async function createEolGuardExtension(pi) {
  pi.on("tool_call", async (event) => {
    if (event?.toolName !== "write") {
      return;
    }
    const input = event.input;
    if (!input || typeof input.path !== "string" || typeof input.content !== "string") {
      return;
    }
    const target = path.isAbsolute(input.path)
      ? input.path
      : path.resolve(process.cwd(), input.path);
    const style = await existingLineEndings(target);
    if (style) {
      input.content = normalizeLineEndings(input.content, style);
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!event || typeof event.systemPrompt !== "string" || !event.systemPrompt) {
      return undefined;
    }
    if (event.systemPrompt.includes(SYSTEM_PROMPT_MARKER)) {
      return undefined;
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + SYSTEM_PROMPT_APPEND };
  });
}
