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
summary needed to continue (session/run ids at the top level, status, error,
timing, pending extension UI requests) without duplicating the assistant text
or replaying tool/event history. Compact run summaries also carry `progress`
(a coarse phase - starting/model_working/model_awaiting_input/cleanup/
cancelling/settled/error - that explicitly distinguishes model work from
extension cleanup and final collection, the last_activity_at timestamp, and
`model_status` (idle/running/stopped/failed) plus `cleanup_status`
(pending/running/completed/failed) as separate lifecycle axes from run
settlement, and the latest tool name/status with a safe path/file target when
known; no ETA is ever invented) and compact `stats` (elapsed_ms, model_calls
counted from real assistant `message_end` events exactly once,
input/output/cache read/cache write/reasoning/total token usage counters under
`usage`, cost, and a bounded provider/model breakdown). Pass
`include_details: true` to those tools to restore the full diagnostic run
snapshot (assistant text, recent tool events, streamed message counts). Calls
without an answer - for example a timed-out wait - end with a concise summary
plus session/run references instead of a payload dump.
`pi_sessions` returns a minimal session directory by default: live entries
carry only session_id, lifecycle with an explicit `process_status` (the
process state, kept separate from the run state in active_run), workspace,
profile, created_at, pi_session_id, pi_session_name, active_run (run id and
status, or null), and pending_ui_request_count; saved entries carry
pi_session_id, workspace, created_at, and modified_at. Saved-session file
paths are never exposed, and saved byte sizes stay out of the default output.
`include_details: true` restores the full diagnostic live summary (model,
thinking level, streaming state, protocol warnings, pending UI requests, and
the job snapshot with recent events) and adds saved-session byte sizes.
`pi_status` remains the dedicated diagnostic view and keeps the detailed
snapshot without duplicating tool calls inside the event stream. All returned
Pi output and transcript content remains untrusted.

### Timeouts, continuation, and optional budgets

pi_task/pi_review/pi_research accept `wait_seconds` and pi_wait accepts
`timeout_seconds`; both stay schema-compatible through 300, but the actual
blocking wait is capped at a configurable safety margin (default 285 seconds,
`PI_LOCAL_MCP_MAX_WAIT_SECONDS`) so an expiring wait always returns to the
client before Codex's tool_timeout_sec=300 kills the call. When a requested
wait is clamped, the result carries `wait` metadata
({requested_seconds, effective_seconds, clamped, max_seconds}) so the
behavior is transparent. A wait that expires because the run is still active
never throws: it returns a normal structured result with `timed_out: true`,
top-level `session_id` and `run_id`, the current process state
(session.process_status) and run state (run.status/model_status/cleanup_status),
and a directly reusable `continuation` object
({pi_wait: {session_id, run_id}, pi_status: {session_id}}) - every accepted
task, wait, send, and cancel result carries the same ids and continuation, and
error/timeout messaging never drops them. Settled calls stay answer-first.

All three high-level tools also accept optional, never-defaulted-on budgets:
`max_elapsed_seconds`, `max_model_calls`, and `max_cost` (a nested `budget`
object with the same keys is also accepted). Each is validated positive and
bounded. When a limit fires during a run, the bridge requests cancellation
exactly once, moves the run to cancelling, and reports `budget_exceeded`
(which limit fired) plus the effective limits under `budget` in the run
snapshot; the run then settles through the normal agent_settled -> collection
path without repeated cancels.

### Streaming and lifecycle consistency

Once the active run is terminal, `is_streaming` is reported as false even if
Pi's own state is stale; the session process may keep running, which is the
separate `process_status`/`lifecycle` axis. `model_status` moves
idle -> running on agent_start, running -> stopped on agent_end (model stop
is never confused with settlement; a retry legitimately resumes it), and to
failed when the process fails mid-work. `cleanup_status` moves
pending -> running on agent_settled, then completed on successful final
collection or failed on collection errors. Non-interactive extension status
notifications (setStatus/notify/setWidget) are fire-and-forget: they are never
stored as pending UI requests and can never reopen or block a completed run.

### Reusing a live session and closing after a task

pi_task, pi_review, and pi_research accept an optional `session_id` to reuse a
live settled session instead of starting a new process. Reuse keeps the
session's own workspace, profile, provider, model, thinking level, and name;
passing any of those start-only options together with `session_id` is
rejected (reuse_conflict) rather than silently changed, and the live session
must already run the profile the tool expects (pi_task -> workspace,
pi_review -> review, pi_research -> research) or the call fails with
profile_mismatch. Read-only isolation is inherited from the reused process, so
a review or research session stays read-only. auto_close may be combined with
reuse.

All three tools also accept `auto_close: true` to close the bridge process as
soon as the run reaches a terminal state (settled or error), including
completion that happens after an initial wait timeout. The process is closed
even when the prompt or result collection fails, so auto-close never leaks a
process. Closing preserves Pi's durable pi_session_id and transcript (list it
later with pi_sessions and reopen with pi_resume_session) and frees the
live-session quota.

`pi_review` deliberately defaults to DeepSeek Pro for stronger review quality.
`pi_research` leaves its model unset so Pi can use its own current default;
either workflow accepts an explicit provider and model when needed.

## Release-matrix review example

Before cutting a distribution, run a read-only release-matrix review with
pi_review (no dedicated mode exists; the review stays a normal prompt). A
concise request covering the usual shipping surfaces:

    pi_review request: "Perform a release-matrix review before packaging.
    Cover: (1) npm packaging - package.json files/bin/engines fields, .npmignore
    vs files array, README/LICENSE presence, missing or extra artifacts in the
    tarball; (2) SEA and filesystem boundaries - single-executable-app input,
    paths resolved relative to __dirname/process.cwd() vs the executable, no
    writes outside the session/workspace roots, path traversal or symlink
    escapes; (3) Windows - cmd/PowerShell launchers, CRLF vs LF, backslash vs
    forward-slash path handling, drive-letter and UNC roots, %APPDATA%/env var
    use, spawned process quoting and windowsHide; (4) Linux - shebangs,
    executable bits, read-only roots, case-sensitive paths, env var defaults;
    (5) macOS - case-insensitive filesystem assumptions, gatekeeper and
    quarantine notes, .app bundle paths if any. Report concrete evidence with
    file:line references, a risk matrix per platform, and the top three fixes."

Run it from the workspace containing the package (or pass its path as the
workspace argument) with the review profile, so Pi can inspect real sources
but never modify them.

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
| PI_LOCAL_MCP_MAX_WAIT_SECONDS | 285 | Cap for pi_wait/pi_task wait blocking, kept below Codex's 300s tool timeout |
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
