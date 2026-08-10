import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")
);
const launcher = readFileSync(
  path.join(import.meta.dirname, "..", "run-pi-wsl-mcp.cmd"),
  "utf8"
);
const smoke = readFileSync(
  path.join(import.meta.dirname, "..", "scripts", "mcp-smoke.mjs"),
  "utf8"
);

test("the package identity is public-ready without a fixed private flag", () => {
  assert.equal(packageJson.name, "pi-wsl-mcp");
  assert.equal(packageJson.private, undefined, "a public-ready package must not be private");
  assert.equal(packageJson.bin["pi-wsl-mcp"], "src/cli.mjs", "the pi-wsl-mcp bin must point at the bridge entry");
  assert.ok(Array.isArray(packageJson.files), "a files allowlist is required for installability");
});

test("the Windows launcher derives everything from the environment, never fixed paths", () => {
  assert.ok(!launcher.includes("-d Ubuntu"), "the launcher must not default to a specific distro");
  assert.ok(!launcher.includes("qq110"), "the launcher must not embed a user name");
  assert.ok(!/(?<![A-Za-z_0-9])[A-Za-z]:\\/.test(launcher), "the launcher must not embed a fixed Windows drive path");
  assert.ok(launcher.includes("PI_WSL_MCP_DISTRO"), "the launcher must support PI_WSL_MCP_DISTRO");
  assert.ok(launcher.includes("%~dp0"), "the launcher must resolve its own package directory");
  assert.ok(launcher.includes("%CD%"), "the launcher must derive the default workspace from the caller directory");
  assert.ok(launcher.includes("PI_WSL_MCP_LAUNCH=1"), "the launcher must set PI_WSL_MCP_LAUNCH");
  assert.ok(launcher.includes("WSLENV"), "the launcher must forward configuration into WSL via WSLENV");
});

test("the smoke script locates the launcher relative to the checkout and expects the new names", () => {
  assert.ok(!smoke.includes("D:\\"), "the smoke script must not embed a fixed Windows path");
  assert.ok(!smoke.includes("qq110"), "the smoke script must not embed a user name");
  assert.ok(smoke.includes("run-pi-wsl-mcp.cmd"), "the smoke script must use the renamed launcher");
  assert.ok(!smoke.includes("pi-local-mcp-smoke"), "the smoke client must use the new client name");
  assert.ok(smoke.includes("Pi WSL MCP"), "the smoke script must assert the renamed server");
  assert.ok(smoke.includes("PI_WSL_MCP_TOOLSET: \"full\""), "the smoke must pin the full toolset because it asserts the 20-tool surface");
});

test("the smoke script passes the launcher path to cmd.exe without literal quote wrapping", () => {
  // cmd.exe receives the batch path as a single unquoted argv entry: Node
  // applies proper MSVCRT quoting, which is required because the WSL interop
  // layer would otherwise backslash-escape the quotes, which cmd.exe does not
  // understand and would report as an unrecognized command.
  assert.ok(
    /spawn\("cmd\.exe", \["\/d", "\/s", "\/c", await windowsPath\(launcherPath\)\]/.test(smoke),
    "the smoke client must spawn cmd.exe with the converted launcher path as a plain argv entry"
  );
  assert.ok(
    smoke.includes('execFile("wslpath", ["-w", input]'),
    "inside WSL the smoke client must convert the launcher path with wslpath -w"
  );
  assert.ok(
    !smoke.includes('"' + "+" + ' launcherPath ' + "+" + '"'),
    "the smoke client must never wrap the launcher path in literal quotes"
  );
});

test("the launcher forwards every configuration variable through WSLENV", () => {
  for (const name of [
    "PI_WSL_MCP_PKG", "PI_WSL_MCP_PI_BIN", "PI_WSL_MCP_DEFAULT_CWD",
    "PI_WSL_MCP_ALLOWED_ROOTS", "PI_WSL_MCP_SESSION_ROOT", "PI_WSL_MCP_MAX_SESSIONS",
    "PI_WSL_MCP_MAX_WAIT_SECONDS", "PI_WSL_MCP_STARTUP_TIMEOUT_MS",
    "PI_WSL_MCP_COMMAND_TIMEOUT_MS", "PI_WSL_MCP_MAX_SAVED_SESSIONS",
    "PI_WSL_MCP_RESULT_LIMIT", "PI_WSL_MCP_HISTORY_LIMIT", "PI_WSL_MCP_TOOLSET"
  ]) {
    assert.ok(launcher.includes(name + "/u"), "WSLENV must forward " + name);
  }
  for (const name of [
    "PI_LOCAL_MCP_PI_BIN", "PI_LOCAL_MCP_DEFAULT_CWD", "PI_LOCAL_MCP_ALLOWED_ROOTS",
    "PI_LOCAL_MCP_SESSION_ROOT", "PI_LOCAL_MCP_MAX_SESSIONS", "PI_LOCAL_MCP_MAX_WAIT_SECONDS",
    "PI_LOCAL_MCP_STARTUP_TIMEOUT_MS", "PI_LOCAL_MCP_COMMAND_TIMEOUT_MS",
    "PI_LOCAL_MCP_MAX_SAVED_SESSIONS", "PI_LOCAL_MCP_RESULT_LIMIT", "PI_LOCAL_MCP_HISTORY_LIMIT",
    "PI_LOCAL_MCP_TOOLSET"
  ]) {
    assert.ok(launcher.includes(name + "/u"), "WSLENV must forward deprecated alias " + name);
  }
});
