import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createId, PiLocalError, redactText } from "./util.mjs";

function commandError(response) {
  return new PiLocalError(
    "pi_rpc_error",
    typeof response.error === "string" ? redactText(response.error) : "Pi rejected the RPC command.",
    { command: response.command }
  );
}

export function buildPiArgs(options) {
  const args = ["--mode", "rpc"];
  if (options.sessionPath) {
    args.push("--session", options.sessionPath);
  }
  if (options.profile?.tools?.length) {
    args.push("--tools", options.profile.tools.join(","));
  }
  return args;
}

export class PiRpcProcess extends EventEmitter {
  constructor(options) {
    super();
    this.piBin = options.piBin;
    this.cwd = options.cwd;
    this.profile = options.profile;
    this.sessionPath = options.sessionPath;
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.child = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.stderrLines = [];
    this.pending = new Map();
    this.closed = false;
    this.protocolWarnings = [];
  }

  async start() {
    if (this.child && !this.closed && this.child.exitCode === null && !this.child.killed) {
      return this.command({ type: "get_state" });
    }
    this.child = null;
    this.closed = false;
    const args = buildPiArgs({
      profile: this.profile,
      sessionPath: this.sessionPath
    });
    try {
      this.child = spawn(this.piBin, args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      throw new PiLocalError("pi_start_failed", "Could not start Pi: " + redactText(error?.message || String(error)));
    }

    const child = this.child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk) => this.consumeStderr(chunk));
    child.on("error", (error) => {
      if (this.child === child) {
        this.fail(new PiLocalError(
          "pi_process_error",
          "Pi process failed: " + redactText(error?.message || String(error))
        ));
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      if (!this.closed) {
        this.fail(new PiLocalError(
          "pi_process_exited",
          "Pi process exited" + (code === null ? "" : " with code " + code) + (signal ? " (" + signal + ")" : "."),
          { code, signal, stderr: this.stderrLines.slice(-12) }
        ));
      }
      this.closed = true;
      this.child = null;
      this.emit("exit", { code, signal });
    });
    return this.command({ type: "get_state" }, this.startupTimeoutMs);
  }

  consumeStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) {
        if (this.stdoutBuffer.length > 1024 * 1024) {
          this.protocolWarning("Pi RPC emitted an overlong stdout line.");
          this.stdoutBuffer = "";
        }
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) {
        this.consumeLine(line);
      }
    }
  }

  consumeStderr(chunk) {
    this.stderrBuffer += chunk;
    while (true) {
      const newline = this.stderrBuffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = redactText(this.stderrBuffer.slice(0, newline).replace(/\r$/, ""));
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (line) {
        this.stderrLines.push(line);
        if (this.stderrLines.length > 80) {
          this.stderrLines.shift();
        }
        this.emit("stderr", line);
      }
    }
  }

  consumeLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.protocolWarning("Non-JSON output from Pi RPC: " + redactText(line.slice(0, 1000)));
      return;
    }
    if (message?.type === "response" && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success) {
        pending.resolve(message);
      } else {
        pending.reject(commandError(message));
      }
      return;
    }
    this.emit("event", message);
  }

  protocolWarning(message) {
    this.protocolWarnings.push(message);
    if (this.protocolWarnings.length > 20) {
      this.protocolWarnings.shift();
    }
    this.emit("protocol_warning", message);
  }

  command(payload, timeoutMs = this.commandTimeoutMs) {
    if (!this.child || this.closed || !this.child.stdin.writable) {
      return Promise.reject(new PiLocalError("pi_not_running", "Pi session is not running."));
    }
    const id = createId("rpc");
    const command = { ...payload, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiLocalError(
          "pi_rpc_timeout",
          "Pi did not acknowledge " + payload.type + " within " + Math.ceil(timeoutMs / 1000) + " seconds."
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify(command) + "\n", "utf8", (error) => {
          if (error && this.pending.has(id)) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(new PiLocalError("pi_write_failed", "Could not send a command to Pi."));
          }
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new PiLocalError("pi_write_failed", "Could not send a command to Pi."));
      }
    });
  }

  async respondToUi(payload) {
    if (!this.child || this.closed || !this.child.stdin.writable) {
      throw new PiLocalError("pi_not_running", "Pi session is not running.");
    }
    const permitted = payload?.cancelled === true
      ? { type: "extension_ui_response", id: payload.id, cancelled: true }
      : typeof payload?.value === "string"
        ? { type: "extension_ui_response", id: payload.id, value: payload.value }
        : typeof payload?.confirmed === "boolean"
          ? { type: "extension_ui_response", id: payload.id, confirmed: payload.confirmed }
          : null;
    if (!permitted || typeof permitted.id !== "string" || !permitted.id) {
      throw new PiLocalError("invalid_ui_response", "Provide an id and exactly one of value, confirmed, or cancelled.");
    }
    await new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) {
          reject(new PiLocalError("pi_write_failed", "Could not deliver the extension UI response to Pi."));
        } else {
          resolve();
        }
      };
      timeout = setTimeout(() => {
        finish(new Error("Pi did not accept the extension UI response in time."));
      }, this.commandTimeoutMs);
      try {
        this.child.stdin.write(JSON.stringify(permitted) + "\n", "utf8", finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  fail(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.emit("failure", error);
  }

  async close() {
    if (!this.child || this.closed) {
      return;
    }
    this.closed = true;
    this.fail(new PiLocalError("pi_session_closed", "Pi session was closed."));
    const child = this.child;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2500))
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
}
