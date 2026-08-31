import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  boundedValue,
  createConfig,
  isPathWithin,
  normalizeWslPath,
  redactText,
  resolveExecutable,
  splitPathList
} from "../src/util.mjs";

test("normalizes Windows and WSL paths without accepting generic UNC paths", () => {
  assert.equal(
    normalizeWslPath("D:\\dev\\project-x"),
    "/mnt/d/dev/project-x"
  );
  assert.equal(
    normalizeWslPath("/home/user/work/../work/codefacts"),
    "/home/user/work/codefacts"
  );
  assert.equal(
    normalizeWslPath("\\\\wsl.localhost\\Debian\\home\\user\\work\\project-x"),
    "/home/user/work/project-x"
  );
  assert.throws(
    () => normalizeWslPath("\\\\server\\share\\secret"),
    /generic UNC paths/
  );
});

test("path containment rejects siblings and parent traversal", () => {
  assert.equal(isPathWithin("/home/user/work/project-x", "/home/user/work"), true);
  assert.equal(isPathWithin("/home/user/work", "/home/user/work"), true);
  assert.equal(isPathWithin("/home/user/workElsewhere", "/home/user/work"), false);
  assert.equal(isPathWithin("/home/user", "/home/user/work"), false);
});

test("redacts credential-looking values before MCP output", () => {
  assert.equal(redactText("api_key=abc123 secret"), "api_key=[redacted] secret");
  assert.equal(redactText('token: "abc123"'), "token: [redacted]");
  assert.deepEqual(
    boundedValue({
      apiKey: "never-return-this",
      detail: "Authorization: Bearer example-token",
      nested: { access_token: "also-never-return-this" }
    }),
    {
      apiKey: "[redacted]",
      detail: "Authorization: [redacted]",
      nested: { access_token: "[redacted]" }
    }
  );
});

test("bounds large arrays and parses semicolon-delimited allowed roots", () => {
  const result = boundedValue([1, 2, 3], { maxItems: 2 });
  assert.deepEqual(result, [1, 2, "[+1 more items]"]);
  assert.deepEqual(
    splitPathList(" /home/user/work ; /srv/src ;; "),
    ["/home/user/work", "/srv/src"]
  );
});

test("config defaults derive from the actual WSL home and working directory", () => {
  const config = createConfig({ HOME: "/home/alice" });
  assert.equal(config.piBin, "pi", "the pi command resolves through the interactive zsh PATH by default");
  assert.equal(config.defaultWorkspace, process.cwd());
  assert.deepEqual(config.allowedRootInputs, [process.cwd()]);
  assert.equal(config.sessionRootInput, "/home/alice/.pi/agent/sessions");
  assert.equal(config.maxSessions, 3);
  assert.equal(config.startupTimeoutMs, 45000);
  assert.equal(config.commandTimeoutMs, 30000);
  assert.equal(config.maxSavedSessions, 100);
  assert.equal(config.resultLimit, 24000);
  assert.equal(config.historyLimit, 80);
});

test("toolset defaults to core and accepts only core or full", () => {
  assert.equal(createConfig({ HOME: "/home/alice" }).toolset, "core", "the default toolset must be core");
  assert.equal(createConfig({ HOME: "/home/alice", PI_WSL_MCP_TOOLSET: "full" }).toolset, "full");
  assert.equal(createConfig({ HOME: "/home/alice", PI_WSL_MCP_TOOLSET: "core" }).toolset, "core");
  assert.equal(
    createConfig({ HOME: "/home/alice", PI_WSL_MCP_TOOLSET: "  FULL " }).toolset,
    "full",
    "toolset values are trimmed and case-insensitive"
  );
  assert.equal(
    createConfig({ HOME: "/home/alice", PI_LOCAL_MCP_TOOLSET: "full" }).toolset,
    "full",
    "PI_LOCAL_MCP_TOOLSET remains a deprecated alias"
  );
  const precedence = createConfig({
    HOME: "/home/alice",
    PI_WSL_MCP_TOOLSET: "core",
    PI_LOCAL_MCP_TOOLSET: "full"
  });
  assert.equal(precedence.toolset, "core", "the current variable must beat its legacy alias");
  for (const invalid of ["all", "1", "FULL+EXTRA"]) {
    assert.throws(
      () => createConfig({ HOME: "/home/alice", PI_WSL_MCP_TOOLSET: invalid }),
      /PI_WSL_MCP_TOOLSET must be "core" or "full"/,
      "invalid toolset " + invalid + " must be rejected"
    );
  }
  assert.throws(
    () => createConfig({ HOME: "/home/alice", PI_LOCAL_MCP_TOOLSET: "everything" }),
    /must be "core" or "full"/,
    "the deprecated alias is validated the same way"
  );
});

test("PI_WSL_MCP_* overrides win and PI_LOCAL_MCP_* remains a deprecated alias", () => {
  const viaCurrent = createConfig({
    HOME: "/home/alice",
    PI_WSL_MCP_PI_BIN: "/opt/pi/bin/pi",
    PI_WSL_MCP_DEFAULT_CWD: "/home/alice/work",
    PI_WSL_MCP_ALLOWED_ROOTS: "/home/alice/work;/srv/src",
    PI_WSL_MCP_SESSION_ROOT: "/srv/sessions",
    PI_WSL_MCP_MAX_SESSIONS: "5"
  });
  assert.equal(viaCurrent.piBin, "/opt/pi/bin/pi");
  assert.equal(viaCurrent.defaultWorkspace, "/home/alice/work");
  assert.deepEqual(viaCurrent.allowedRootInputs, ["/home/alice/work", "/srv/src"]);
  assert.equal(viaCurrent.sessionRootInput, "/srv/sessions");
  assert.equal(viaCurrent.maxSessions, 5);

  const viaLegacy = createConfig({
    HOME: "/home/alice",
    PI_LOCAL_MCP_PI_BIN: "/opt/pi/bin/pi",
    PI_LOCAL_MCP_DEFAULT_CWD: "/home/alice/work",
    PI_LOCAL_MCP_ALLOWED_ROOTS: "/home/alice/work;/srv/src"
  });
  assert.equal(viaLegacy.piBin, "/opt/pi/bin/pi");
  assert.equal(viaLegacy.defaultWorkspace, "/home/alice/work");
  assert.deepEqual(viaLegacy.allowedRootInputs, ["/home/alice/work", "/srv/src"]);

  const precedence = createConfig({
    HOME: "/home/alice",
    PI_WSL_MCP_PI_BIN: "/new/bin/pi",
    PI_LOCAL_MCP_PI_BIN: "/old/bin/pi"
  });
  assert.equal(precedence.piBin, "/new/bin/pi", "the current variable must beat its legacy alias");
});

test("resolveExecutable resolves bare commands through PATH and normalizes absolute paths", {
  skip: process.platform !== "linux" && "Pi executable resolution runs inside the WSL/Linux bridge runtime."
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-wsl-mcp-bin-"));
  await writeFile(path.join(dir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const pathValue = dir + ":/usr/bin";
  assert.equal(
    await resolveExecutable("pi", "Pi binary", pathValue),
    path.join(dir, "pi")
  );
  assert.equal(
    await resolveExecutable(path.join(dir, "pi"), "Pi binary", pathValue),
    path.join(dir, "pi"),
    "absolute paths pass through after normalization"
  );
  await assert.rejects(
    resolveExecutable("no-such-tool-xyz", "Pi binary", pathValue),
    /was not found on PATH/
  );
  await assert.rejects(
    resolveExecutable("/bin/definitely-missing-pi", "Pi binary", pathValue),
    /is not executable/
  );
});
