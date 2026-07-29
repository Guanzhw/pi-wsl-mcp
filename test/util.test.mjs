import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedValue,
  isPathWithin,
  normalizeWslPath,
  redactText,
  splitPathList
} from "../src/util.mjs";

test("normalizes Windows and WSL paths without accepting generic UNC paths", () => {
  assert.equal(
    normalizeWslPath("D:\\WorkSpace\\OpenSession"),
    "/mnt/d/WorkSpace/OpenSession"
  );
  assert.equal(
    normalizeWslPath("/mnt/d/WorkSpace/../WorkSpace/codefacts"),
    "/mnt/d/WorkSpace/codefacts"
  );
  assert.equal(
    normalizeWslPath("\\\\wsl.localhost\\Ubuntu\\mnt\\d\\WorkSpace\\OpenSession"),
    "/mnt/d/WorkSpace/OpenSession"
  );
  assert.throws(
    () => normalizeWslPath("\\\\server\\share\\secret"),
    /generic UNC paths/
  );
});

test("path containment rejects siblings and parent traversal", () => {
  assert.equal(isPathWithin("/mnt/d/WorkSpace/OpenSession", "/mnt/d/WorkSpace"), true);
  assert.equal(isPathWithin("/mnt/d/WorkSpace", "/mnt/d/WorkSpace"), true);
  assert.equal(isPathWithin("/mnt/d/WorkSpaceElsewhere", "/mnt/d/WorkSpace"), false);
  assert.equal(isPathWithin("/mnt/d", "/mnt/d/WorkSpace"), false);
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
    splitPathList(" /mnt/d/WorkSpace ; /mnt/c/src ;; "),
    ["/mnt/d/WorkSpace", "/mnt/c/src"]
  );
});
