# Pi Local MCP

A user-level stdio MCP bridge for the Pi coding agent installed in Ubuntu WSL.

The bridge serves both initialization-based MCP clients and stateless
`2026-07-28` clients over stdio. Its existing tool surface and safety profiles
are the same in either protocol era.
It deliberately runs Pi inside WSL, through an interactive zsh, so Pi retains
its normal extensions, session store, workspace guard, model configuration, and
environment-provided credentials. No API key is copied into Codex configuration
or returned by an MCP tool.

This is a process bridge to Pi's supported JSONL RPC mode, not an attempt to
reimplement Pi's agent runtime. That matters for installed extensions such as
the native DeepSeek web_search tool.

## What it provides

- A convenient pi_task entry point for ordinary workspace work.
- Enforced read-only pi_research and pi_review workflows.
- Long-running task control: pi_send (including `behavior=steer`), pi_wait,
  pi_status, and pi_cancel.
- Persistent Pi sessions: list, close, inspect history, and resume saved
  sessions across MCP restarts.
- Pi model, thinking-level, compact, fork, and extension-command controls.
- Delivery of genuinely interactive Pi extension requests through
  pi_respond_ui.
- Bounded, redacted result payloads. Pi output, fetched pages, and transcript
  content are always marked as untrusted.

## Profiles

| Profile | Intended use | Pi tool policy |
| --- | --- | --- |
| workspace | Implementing or investigating a local task | Normal Pi capabilities, including edits and commands when prompted |
| review | Code/design review | Explicit read/search-only allowlist |
| research | Source-backed web or knowledge research | Explicit local-read and search-only allowlist |

For most work, start with exactly one of `pi_task`, `pi_research`, or
`pi_review`. The remaining tools are advanced controls for a live or saved
session; they are not needed for an ordinary one-off task.

Prefer pi_research and pi_review when mutation is not wanted. Use pi_task or
pi_start_session with profile workspace only when a task is allowed to act in
the selected workspace.

## Most useful tools

| Need | Tool |
| --- | --- |
| One-off implementation or investigation | pi_task |
| Web research using the installed DeepSeek search extension | pi_research |
| Evidence-based, read-only review | pi_review |
| Follow a long task | pi_wait, then pi_status |
| Redirect a running task | pi_send with behavior steer |
| Reopen past work | pi_sessions, then pi_resume_session |
| Continue or inspect a live session | pi_send, pi_history, pi_commands |
| Handle an extension confirmation/input dialog | pi_status, then pi_respond_ui |

The bridge reports a logical session_id for its live process and Pi's own
durable pi_session_id. After a restart, use the durable identifier returned
by pi_sessions with pi_resume_session.

High-level calls (pi_task, pi_research, pi_review, pi_wait) return compact
results by default: the bounded, redacted final answer lives in
`structuredContent.answer`, and `structuredContent.result` carries the run
summary needed to continue (session/run ids, status, error, timing, pending
extension UI requests) without duplicating the assistant text or replaying
tool/event history. Pass `include_details: true` to those tools to restore the
full diagnostic run snapshot (assistant text, recent tool events, streamed
message counts). Calls without an answer - for example a timed-out wait - end
with a concise summary plus session/run references instead of a payload dump.
`pi_sessions` lists live sessions compactly; `include_details: true` adds full
job snapshots. `pi_status` remains the dedicated diagnostic view and keeps the
detailed snapshot without duplicating tool calls inside the event stream. All
returned Pi output and transcript content remains untrusted.

`pi_review` deliberately defaults to DeepSeek Pro for stronger review quality.
`pi_research` leaves its model unset so Pi can use its own current default;
either workflow accepts an explicit provider and model when needed.

## Codex installation

The user-level Codex entry is in C:\Users\QQ110\.codex\config.toml:

    [mcp_servers.pi_local]
    enabled = true
    command = "cmd"
    args = ["/d", "/s", "/c", 'D:\WorkSpace\pi-local-mcp\run-pi-mcp.cmd']
    startup_timeout_sec = 60.0
    tool_timeout_sec = 300.0

Restart Codex (or start a new Codex session) after changing its configuration.
The shown paths are this machine's user-level installation paths; update both
the Codex entry and launcher if this bridge is moved.
The Windows launcher starts:

    wsl.exe -d Ubuntu -- zsh -ic "exec node /mnt/d/WorkSpace/pi-local-mcp/src/cli.mjs"

The interactive shell is intentional: this Pi setup loads its DeepSeek
credential and extension environment from ~/.zshrc.
The launcher also sets PI_LOCAL_MCP_LAUNCH=1. If future ~/.zshrc changes add
interactive prompts or stdout banners, guard those UI-only lines with that
variable so they do not corrupt the MCP JSONL stream.

## Configuration

All configuration is optional and is read by the bridge inside WSL.

| Variable | Default | Purpose |
| --- | --- | --- |
| PI_LOCAL_MCP_PI_BIN | /home/qq110/.npm-global/bin/pi | Absolute Pi binary path |
| PI_LOCAL_MCP_DEFAULT_CWD | /mnt/d/WorkSpace/OpenSession | Default workspace |
| PI_LOCAL_MCP_ALLOWED_ROOTS | /mnt/d/WorkSpace | Semicolon-separated allowed workspace roots |
| PI_LOCAL_MCP_SESSION_ROOT | ~/.pi/agent/sessions | Pi's saved-session store |
| PI_LOCAL_MCP_MAX_SESSIONS | 3 | Concurrent live Pi processes |
| PI_LOCAL_MCP_STARTUP_TIMEOUT_MS | 45000 | Pi startup acknowledgement timeout |
| PI_LOCAL_MCP_COMMAND_TIMEOUT_MS | 30000 | Individual Pi RPC acknowledgement timeout |

Workspace arguments can be WSL paths such as /mnt/d/WorkSpace/OpenSession or
Windows drive paths such as D:\WorkSpace\OpenSession. The bridge
canonicalizes them and refuses paths outside PI_LOCAL_MCP_ALLOWED_ROOTS.

## Local validation

Run the static smoke from WSL or PowerShell. On Windows it automatically uses
the same WSL launcher registered with Codex. Run live checks from an
interactive Pi environment:

    cd /mnt/d/WorkSpace/pi-local-mcp
    npm run check
    npm run smoke:mcp
    npm run smoke:mcp -- --live --resume --workspace --lifecycle

To explicitly validate the exact Windows launcher used by Codex:

    cd D:\WorkSpace\pi-local-mcp
    node scripts\mcp-smoke.mjs --windows-launcher --live

The live smoke test performs a real Pi task, confirms that the installed
DeepSeek web_search tool ran, can verify saved-session resume and the
start/send/status/wait/history lifecycle, and closes live bridge sessions while
preserving Pi's durable transcripts.
