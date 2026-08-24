import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|cookie|credential|pass(?:word)?|secret|token)/i;
const SECRET_ASSIGNMENT = /((?:api[_ -]?key|authorization|bearer|cookie|credential|pass(?:word)?|secret|token)\s*[:=]\s*)(?:(?:Bearer)\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"',}\]]+)/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const WINDOWS_DRIVE_PATH = /^([a-z]):[\\/](.*)$/i;
const WSL_UNC_PATH = /^\\\\wsl(?:\.localhost)?\\[^\\]+\\(.*)$/i;

export class PiWslError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PiWslError";
    this.code = code;
    this.details = details;
  }
}

export function createId(prefix) {
  return prefix + "_" + randomUUID();
}

export function positiveInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PiWslError(
      "invalid_configuration",
      "Expected an integer between " + minimum + " and " + maximum + "."
    );
  }
  return parsed;
}

export function normalizeWslPath(value, label = "path") {
  if (typeof value !== "string") {
    throw new PiWslError("invalid_path", label + " must be a string.");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw new PiWslError("invalid_path", label + " must be a non-empty path without NUL bytes.");
  }

  const drive = trimmed.match(WINDOWS_DRIVE_PATH);
  if (drive) {
    return path.posix.normalize("/mnt/" + drive[1].toLowerCase() + "/" + drive[2].replace(/\\/g, "/"));
  }

  const unc = trimmed.match(WSL_UNC_PATH);
  if (unc) {
    return path.posix.normalize("/" + unc[1].replace(/\\/g, "/"));
  }

  if (trimmed.includes("\\")) {
    throw new PiWslError(
      "invalid_path",
      label + " must be a WSL path or a Windows drive path; generic UNC paths are not supported."
    );
  }
  if (!path.posix.isAbsolute(trimmed)) {
    throw new PiWslError("invalid_path", label + " must be absolute.");
  }
  return path.posix.normalize(trimmed);
}

export function splitPathList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isPathWithin(candidate, root) {
  // Callers must pass canonical paths: this is intentionally a lexical
  // containment check, while canonicalDirectory/canonicalRoots resolve
  // symlinks with fs.realpath before calling it.
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

export async function canonicalDirectory(input, roots, label = "workspace") {
  const normalized = normalizeWslPath(input, label);
  let canonical;
  try {
    canonical = await fs.realpath(normalized);
  } catch (error) {
    throw new PiWslError("workspace_not_found", label + " does not exist: " + normalized);
  }
  let stat;
  try {
    stat = await fs.stat(canonical);
  } catch (error) {
    throw new PiWslError("workspace_not_found", label + " cannot be inspected: " + normalized);
  }
  if (!stat.isDirectory()) {
    throw new PiWslError("invalid_workspace", label + " must be a directory.");
  }
  if (!roots.some((root) => isPathWithin(canonical, root))) {
    throw new PiWslError(
      "workspace_not_allowed",
      label + " is outside the configured allowed roots.",
      { workspace: canonical }
    );
  }
  return canonical;
}

export async function canonicalRoots(inputs) {
  const roots = [];
  for (const input of inputs) {
    const normalized = normalizeWslPath(input, "allowed root");
    let canonical;
    try {
      canonical = await fs.realpath(normalized);
    } catch (error) {
      throw new PiWslError("invalid_configuration", "Allowed root does not exist: " + normalized);
    }
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) {
      throw new PiWslError("invalid_configuration", "Allowed root is not a directory: " + normalized);
    }
    if (!roots.includes(canonical)) {
      roots.push(canonical);
    }
  }
  if (roots.length === 0) {
    throw new PiWslError("invalid_configuration", "At least one allowed root is required.");
  }
  return roots;
}

export async function canonicalFileWithin(input, root, label = "file") {
  const normalized = normalizeWslPath(input, label);
  let canonical;
  try {
    canonical = await fs.realpath(normalized);
  } catch (error) {
    throw new PiWslError("file_not_found", label + " does not exist.");
  }
  if (!isPathWithin(canonical, root)) {
    throw new PiWslError("file_not_allowed", label + " is outside the Pi session store.");
  }
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) {
    throw new PiWslError("invalid_file", label + " must be a regular file.");
  }
  return canonical;
}

export function redactText(value) {
  return String(value)
    .replace(SECRET_ASSIGNMENT, (_whole, prefix) => prefix + "[redacted]")
    .replace(BEARER_VALUE, "Bearer [redacted]");
}

export function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key));
}

export function boundedValue(value, options = {}, depth = 0, seen = new WeakSet()) {
  const maxDepth = options.maxDepth ?? 10;
  const maxItems = options.maxItems ?? 80;
  const maxString = options.maxString ?? 12000;

  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "string") {
    const text = redactText(value);
    return text.length > maxString ? text.slice(0, maxString) + "\n… [truncated]" : text;
  }
  if (typeof value !== "object") {
    return redactText(String(value));
  }
  if (depth >= maxDepth) {
    return "[max depth reached]";
  }
  if (seen.has(value)) {
    return "[circular reference]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.slice(0, maxItems).map((item) => boundedValue(item, options, depth + 1, seen));
    if (value.length > maxItems) {
      result.push("[+" + (value.length - maxItems) + " more items]");
    }
    return result;
  }

  const result = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, maxItems)) {
    result[key] = isSensitiveKey(key)
      ? "[redacted]"
      : boundedValue(item, options, depth + 1, seen);
  }
  if (entries.length > maxItems) {
    result._truncated_keys = entries.length - maxItems;
  }
  return result;
}

export function boundedJson(value, maximum = 30000) {
  const text = JSON.stringify(boundedValue(value), null, 2);
  return text.length > maximum ? text.slice(0, maximum) + "\n… [response truncated]" : text;
}

export async function readFirstLine(filePath, maximum = 65536) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline === -1 && bytesRead === maximum) {
      throw new PiWslError("invalid_session_file", "Pi session header is unexpectedly large.");
    }
    return text.slice(0, newline === -1 ? text.length : newline).replace(/\r$/, "");
  } finally {
    await handle.close();
  }
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Resolve an executable for spawning. Absolute paths (WSL or Windows drive
// paths) are normalized and checked; a bare command name is resolved through
// the inherited PATH, which is the interactive zsh PATH when the bridge is
// launched through the Windows launcher. This keeps the default (`pi`)
// portable: no absolute binary path is hard-coded anywhere.
export async function resolveExecutable(input, label = "executable", pathValue = process.env.PATH) {
  const value = String(input).trim();
  if (!value) {
    throw new PiWslError("invalid_configuration", label + " must not be empty.");
  }
  if (value.includes("/") || WINDOWS_DRIVE_PATH.test(value)) {
    const normalized = normalizeWslPath(value, label);
    try {
      await fs.access(normalized, fsConstants.X_OK);
    } catch (error) {
      throw new PiWslError("invalid_configuration", label + " is not executable: " + normalized);
    }
    return normalized;
  }
  const pathDirs = String(pathValue || "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.posix.join(dir, value);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch (error) {
      // Keep searching the next PATH entry.
    }
  }
  throw new PiWslError("invalid_configuration", label + " was not found on PATH: " + value);
}

// PI_WSL_MCP_TOOLSET selects which MCP tool surface the bridge registers.
// core (the default) registers only the daily-agent workflow tools; full
// registers the complete 20-tool surface. Values are trimmed and
// case-insensitive; anything else is a configuration error rather than a
// silent fallback.
export function toolsetSetting(input) {
  if (input === undefined || input === null || input === "") {
    return "core";
  }
  const normalized = String(input).trim().toLowerCase();
  if (normalized !== "core" && normalized !== "full") {
    throw new PiWslError(
      "invalid_configuration",
      "PI_WSL_MCP_TOOLSET must be \"core\" or \"full\"."
    );
  }
  return normalized;
}

export function createConfig(environment = process.env) {
  const home = environment.HOME || os.homedir();
  // The bridge derives its portable defaults from the real WSL environment:
  // the saved-session store under the user's home, and the default workspace
  // and allowed roots from the bridge's current working directory (which the
  // Windows launcher sets to the translated caller directory). The pi
  // command itself resolves through the inherited interactive zsh PATH.
  const cwd = process.cwd();
  // PI_WSL_MCP_* is the current configuration namespace. The PI_LOCAL_MCP_*
  // names remain accepted as documented deprecated aliases so existing
  // deployments keep working; the new names always win when both are set.
  const value = (name) => {
    const current = environment["PI_WSL_MCP_" + name];
    if (current !== undefined && current !== "") {
      return current;
    }
    const legacy = environment["PI_LOCAL_MCP_" + name];
    return legacy !== undefined && legacy !== "" ? legacy : undefined;
  };
  const allowedInputs = splitPathList(value("ALLOWED_ROOTS"));
  return {
    // Default: the `pi` command through the interactive zsh PATH this bridge
    // inherits. Set PI_WSL_MCP_PI_BIN only to point elsewhere.
    piBin: value("PI_BIN") || "pi",
    defaultWorkspace: value("DEFAULT_CWD") || cwd,
    allowedRootInputs: allowedInputs.length > 0 ? allowedInputs : [cwd],
    sessionRootInput: value("SESSION_ROOT") || path.posix.join(home, ".pi", "agent", "sessions"),
    maxSessions: positiveInteger(value("MAX_SESSIONS"), 3, 1, 12),
    // Advanced pi_wait remains bounded so it can return a continuation before
    // a conservative host timeout. Synchronous high-level workflows do not use
    // this limit; they await Pi's settlement event directly.
    maxWaitSeconds: positiveInteger(value("MAX_WAIT_SECONDS"), 285, 5, 295),
    maxSavedSessions: positiveInteger(value("MAX_SAVED_SESSIONS"), 100, 1, 500),
    startupTimeoutMs: positiveInteger(value("STARTUP_TIMEOUT_MS"), 45000, 5000, 120000),
    commandTimeoutMs: positiveInteger(value("COMMAND_TIMEOUT_MS"), 30000, 1000, 120000),
    resultLimit: positiveInteger(value("RESULT_LIMIT"), 24000, 2000, 100000),
    historyLimit: positiveInteger(value("HISTORY_LIMIT"), 80, 1, 300),
    // core (default) registers only the daily-agent workflow tools; full
    // registers the complete 20-tool surface. PI_LOCAL_MCP_TOOLSET remains a
    // deprecated alias with the same precedence rules as the other legacy names.
    toolset: toolsetSetting(value("TOOLSET"))
  };
}
