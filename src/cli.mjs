#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createPiMcpServer } from "./server.mjs";
import { PiService } from "./pi-service.mjs";
import { createConfig, redactText } from "./util.mjs";

function printHelp() {
  process.stdout.write("Pi WSL MCP - stdio bridge for a Pi coding agent installed in WSL\n\nRun this program through an MCP client. It intentionally writes protocol messages only to stdout.\n");
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const service = new PiService(createConfig());
try {
  await service.initialize();
  const handle = serveStdio(() => createPiMcpServer(service), {
    onerror(error) {
      process.stderr.write("[pi-wsl-mcp] " + redactText(error.message) + "\n");
    }
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await handle.close();
    await service.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (error) {
  process.stderr.write("[pi-wsl-mcp] " + redactText(error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(1);
}
