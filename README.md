# Pi WSL MCP

Use the Pi coding agent in WSL from any MCP client without rebuilding a
`wsl.exe` command for every task. Pi WSL MCP provides one-call tasks,
resumable sessions, and explicit controls for long-running work while Pi keeps
using its normal WSL environment.

The package is installable from a local checkout (it is not currently
published to npm) and registers a `pi-wsl-mcp` bin command.

The bridge serves both initialization-based MCP clients and stateless
`2026-07-28` clients over stdio. Its existing tool surface and behavior
profiles are the same in either protocol era.
It runs Pi through the same interactive zsh environment used at the terminal,
so existing extensions, models, saved sessions, and shell configuration keep
working.

This is a process bridge to Pi's supported JSONL RPC mode, not an attempt to
reimplement Pi's agent runtime. That matters for installed extensions such as
the native DeepSeek web_search tool.

## Why Pi WSL MCP exists

Pi works well in its WSL environment, but raw `wsl.exe` calls make ordinary
agent work awkward: every caller must reconstruct the launch context, manage a
child process, and invent its own way to find or continue a durable session.

This project turns that workflow into a convenient local MCP entry point. An
ordinary task becomes one tool call, saved work stays findable and reopenable
across restarts, and live work has explicit wait, status, steer, close, and
force-exit controls. Pi still owns its runtime, extensions, transcripts, and model setup;
direct Pi CLI use remains available for Pi-specific administration such as
installing or removing extensions.

## How it evolved

The current bridge is the result of several deliberate changes rather than a
thin shell wrapper:

1. **Pi Local MCP — a protocol bridge first (July 2026).** The project began
   as a local stdio bridge to Pi's supported JSONL RPC mode. It supported both
   initialization-based clients and the stateless MCP `2026-07-28` protocol,
   while keeping Pi sessions durable and provider-owned.
2. **Answer-first results and correct run lifecycle (August 2026).** Compact
   final answers became the default response, with diagnostics available only
   on request. Reusable sessions, explicit wait/status/cancel controls, and
   actionable model or empty-answer failures replaced ambiguous “settled”
   states.
3. **Pi WSL MCP — less ceremony in daily work (August 2026).** The
   bridge was renamed and the Windows launcher stopped assuming one checkout,
   workspace, WSL distribution, or absolute Pi binary path; it derives those
   values from the caller and environment, so the default workspace follows
   whatever project you open. It preserves consistent existing line endings
   during Pi writes and keeps workspace selection scoped to configured roots.
   Research and review stay read-only, so choosing the intended behavior is a
   tool choice rather than a configuration exercise.
4. **Native DeepSeek search and host-integration repair.** Native Responses
   web search exposed a same-name collision with Pi's local `search` function.
   Read-only profiles exclude that local function so native search can run
   without the conflict. The host configuration also moved from the obsolete
   `pi_local`/`run-pi-mcp.cmd` entry to
   `pi_wsl`/`run-pi-wsl-mcp.cmd`.
5. **Public source, unchanged package boundary.** The source is now published
   under the MIT License. The package is still not published to npm; local
   installation remains the supported distribution path for now.

For the concrete configuration and naming migration, see
[Migrating from Pi Local MCP](#migrating-from-pi-local-mcp).

## What it provides

- A convenient pi_task entry point for ordinary workspace work.
- Read-only pi_research and pi_review for focused research and review.
- Synchronous one-shot execution for the three ordinary workflows: one MCP
  call waits up to 10 minutes for Pi's final answer, then hands longer work
  back as a live background session.
- Explicit continuation controls for long-running work: pi_wait, pi_status,
  and pi_kill_session are available in every toolset; full additionally adds
  pi_send, pi_cancel, and the remaining session controls.
- Persistent Pi sessions: list, close, inspect history, and resume saved
  sessions across MCP restarts.
- Pi model, thinking-level, compact, fork, and extension-command controls.
- Delivery of genuinely interactive Pi extension requests through
  pi_respond_ui.
- Minimal high-level results: the answer appears once, with terminal or
  background state in structured output.

## Toolset: core and full

`PI_WSL_MCP_TOOLSET` selects which MCP tool surface the bridge registers.
It accepts exactly two values; anything else is refused at startup rather
than silently falling back.

| Value | Surface | Intended use |
| --- | --- | --- |
| `core` (default) | pi_task, pi_research, pi_review, pi_wait, pi_status, pi_kill_session | One-shot work plus continuation and force-exit |
| `full` | The six core tools plus 15 explicit session, background, UI, and diagnostic controls | Persistent work and troubleshooting |

The three high-level tools have the same ten-minute synchronous window in both
toolsets. A run that is still active at the window is returned as a background
session with reusable lifecycle arguments; it is never cancelled just because
the one-shot call reached that boundary. `full` adds the remaining low-level
lifecycle tools for callers that intentionally manage sessions or background
runs. `PI_LOCAL_MCP_TOOLSET` remains a
deprecated alias; when both are set, `PI_WSL_MCP_TOOLSET` wins.

Choose `full` when you need session reuse, steering/follow-ups, diagnostics,
cancellation, extension UI responses, history, model/thinking switching,
compact, fork, start-session, or extension-command controls:

    PI_WSL_MCP_TOOLSET=full

The core/full choice is owned by this MCP server; Codex (or another MCP host)
may defer exposing a registered tool in its own catalog. If a named core tool
is not initially visible, search the host's deferred tool catalog before
changing the bridge. Use `PI_WSL_MCP_TOOLSET=full` and restart the host only
when an advanced tool genuinely absent from core is needed. The bridge does not
add a gateway or a duplicate tool to work around host-side deferred exposure.

## Profiles

| Profile | Intended use | Pi tool policy |
| --- | --- | --- |
| workspace | Implementing or investigating a local task | Normal Pi capabilities, including edits and commands when prompted |
| review | Code/design review | Explicit read/search-only allowlist; the function tool named `search` is excluded |
| research | Source-backed web or knowledge research | Explicit local-read and search-only allowlist; the function tool named `search` is excluded |

For most work, start with exactly one of `pi_task`, `pi_research`, or
`pi_review`. The remaining tools are advanced controls for a live or saved
session; they are not needed for an ordinary one-off task.

The read-only `research` and `review` profiles never expose a Pi function
tool named `search`: DeepSeek Responses injects a server-side `web_search`
tool, and a request carrying both a function tool named `search` and the
native search injection is rejected with a 400 `invalid_request_error`. The
profiles therefore leave that name out of their allowlist and the bridge
additionally starts those Pi processes with `--exclude-tools search`, so the
same-named tool cannot collide with the native search regardless of which
installed extension provides it. They keep `read`, `grep`, `find`, `ls`, the
installed web/knowledge tools, and the remaining CodeMapper navigation tools
(`map`, `outline`, `expand`, `path`). The `workspace` profile keeps the user's
normal toolset untouched: the bridge does not promise to rewrite a
user-composed `search` tool, and if such a combination collides with the
provider's native search, the run reports an actionable error explaining how
to resolve it instead of masquerading as success.

Prefer pi_research and pi_review when mutation is not wanted. Use pi_task or
pi_start_session with profile workspace only when a task is allowed to act in
the selected workspace.

## Most useful tools

| Need | Tool |
| --- | --- |
| One-off implementation or investigation | pi_task |
| Web research using the installed DeepSeek search extension | pi_research |
| Evidence-based, read-only review | pi_review |
| Deliberately run in the background | pi_start_session, pi_send, then one pi_wait |
| Continue a one-shot run after 10 minutes | returned pi_wait or pi_status arguments |
| Force-exit a live run | pi_kill_session |
| Redirect an explicit background task (`full`) | pi_send with behavior steer |
| Reopen past work | pi_sessions, then pi_resume_session |
| Continue or inspect a live session | pi_send, pi_history, pi_commands |
| Handle an extension confirmation/input dialog | pi_status, then pi_respond_ui |

The bridge reports a logical session_id for its live process and Pi's own
durable pi_session_id. After a restart, use the durable identifier returned
by pi_sessions with pi_resume_session.

pi_task, pi_research, and pi_review wait for terminal settlement for up to ten
minutes. If Pi is still working, the process stays alive and the response is a
background handoff containing session/run ids plus pi_wait, pi_status, and
pi_kill_session arguments. The final Pi text appears exactly once in
`content[0].text`; completed structured output contains only
`status: completed` and the untrusted-content marker. Background structured
output adds the continuation ids needed to retrieve or force-exit that run.
`PI_WSL_MCP_RESULT_LIMIT` bounds the answer and adds an explicit
`… [truncated]` marker. Advanced status/wait tools retain bounded progress,
usage, lifecycle, and optional diagnostic snapshots for troubleshooting.
`pi_sessions` returns a minimal session directory by default: live entries
carry only session_id, lifecycle with an explicit `process_status` (the
process state, kept separate from the run state in active_run), workspace,
profile, created_at, pi_session_id, pi_session_name, active_run (run id and
status, or null), and pending_ui_request_count; saved entries carry
pi_session_id, workspace, created_at, modified_at, and default-visible nullable
`name` and `summary` identity fields. The name comes from Pi's session metadata;
the summary is the first user-task preview. Both are redacted, collapsed to one
line, and bounded to 160 Unicode code points plus an explicit ellipsis from a
fixed-size session-file prefix. Assistant/tool output and saved-session file
paths are never exposed, and saved byte sizes stay out of the default output.
`include_details: true` restores the full diagnostic live summary (model,
thinking level, streaming state, protocol warnings, pending UI requests, and
the job snapshot with recent events, but never `run.result.assistant_text`) and
adds saved-session byte sizes.
`pi_status` is the dedicated live process/run view. It returns a compact live
and job snapshot by default (without `result`, `recent_events`, or
`tool_calls`); pass `include_details: true` for bounded diagnostics. The
final assistant answer has one carrier only: `content[0].text`.

### Synchronous completion and automatic background handoff

pi_task, pi_review, and pi_research have no caller-supplied budget or timeout
arguments. They wait on Pi's `agent_settled` event and final-answer collection
through one event-driven Promise. After ten minutes, the call returns a
background handoff without cancelling the Pi process. Use the returned
pi_wait to collect the answer, pi_status to inspect progress, or
pi_kill_session to force-exit the session.

pi_wait has no timeout argument either. It uses the same fixed ten-minute
bridge window, returns a settled answer when available, and otherwise returns
the current background state with the same continuation controls.

### Streaming and lifecycle consistency

`agent_settled` alone never counts as success. A run is only `settled` when
Pi's final assistant message did not stop with an error and a real answer
text was collected; otherwise the run is `error`. Concretely, a run whose
last assistant message carries `stop_reason=error` (for example the DeepSeek
400 conflict above), a run that settles without any collectable answer text,
and a run whose final collection fails are all reported as `error` runs with
a redacted, actionable message in `run.error` and `stop_reason` in the run
snapshot - the bridge never reports an empty `settled` answer. The three
high-level tools return a minimal `status: failed` result with `isError: true`
for terminal failures, or `status: background` with session/run ids and
continuation arguments when the ten-minute window expires.

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

### Persistent and background sessions

High-level calls create a live session for the duration of the run. If the
ten-minute window expires, keep using the returned pi_wait or pi_status
arguments; use pi_kill_session when the process must stop immediately. For a
persistent conversation or deliberately steered background task, select
`full` and use pi_start_session plus pi_send. Close the live process with
pi_close_session when finished.

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

## Prerequisites

- Windows with WSL enabled and at least one installed Linux distro.
- In that distro:
  - Node.js >= 22.19.0.
  - Pi installed per its own documentation (typically an npm global install,
    for example at `$HOME/.npm-global/bin/pi`).
  - zsh (the launcher uses `zsh -ic` so `~/.zshrc` loads Pi credentials and
    extension environment; bash works when invoked directly, see below).
- A local checkout of this package on the Windows side or inside WSL.

No configuration is required to start: safe defaults are derived from the
actual WSL home directory, the current working directory, and `~/.pi/agent`
state. Override any of them through the `PI_WSL_MCP_*` variables in the
configuration section.

## Install

From the checkout (either side):

    cd /path/to/pi-wsl-mcp
    npm install

The bridge can then be launched directly in WSL:

    cd /path/to/pi-wsl-mcp
    node src/cli.mjs            # run by an MCP client over stdio

To make the `pi-wsl-mcp` bin command available without publishing:

    cd /path/to/pi-wsl-mcp
    npm install -g .

After that, `pi-wsl-mcp` on the WSL PATH starts the same bridge, and WSL-side
MCP clients can use it as their command directly.

## Windows launcher

`run-pi-wsl-mcp.cmd` starts the bridge from Windows without any fixed paths:

- it uses the default WSL distro, or the distro named by `PI_WSL_MCP_DISTRO`;
- it locates the package from its own directory (`%~dp0`) and translates it to
  a WSL path, so the checkout can live anywhere on any drive;
- it starts the bridge in the translated caller working directory, so the
  default workspace follows where the MCP client was launched from;
- it forwards `PI_WSL_MCP_*` variables (and the deprecated `PI_LOCAL_MCP_*`
  aliases) from the Windows environment into WSL via WSLENV;
- it sets `PI_WSL_MCP_LAUNCH=1`; if `~/.zshrc` adds interactive prompts or
  stdout banners, guard those UI-only lines with that variable so they do not
  corrupt the MCP JSONL stream.

The launcher requires that the caller's working directory and the package
directory live on a drive-letter path (`C:`, `D:`, ...) that WSL mounts under
`/mnt/<drive>`. When the caller's directory is not translatable (for example a
UNC path), WSL starts in the distro user's home directory and that becomes the
default workspace.

To select a non-default WSL distro, set `PI_WSL_MCP_DISTRO` in the Windows
environment before starting the client; without it the default distro is used.

## Line-ending preservation

Pi's builtin `write` tool always writes content byte-for-byte, which can
convert a CRLF file to LF (or the reverse) on a full rewrite. The bridge loads
a bundled, session-scoped Pi extension (`src/eol-extension.mjs`) into every Pi
process it spawns that narrows this to safe, bounded behavior:

- If the target of a `write` call is an existing regular text file with
  **consistent CRLF endings**, the incoming content is rewritten to CRLF
  before execution.
- If it has **consistent LF endings**, the incoming content is rewritten to LF.
- **New files, binary files (NUL bytes), empty or no-newline files, and
  mixed-EOL files are left unchanged.** Files larger than 1 MiB are analyzed
  from their first 1 MiB only; a sample cut mid-CRLF reads as mixed and the
  write is left unchanged (the conservative direction).
- Pi's builtin `edit` tool already preserves existing line endings, so it is
  not patched.

The extension also appends guidance to Pi's system prompt: preserve existing
line endings, prefer exact `edit` replacements for existing text files, honor
`.gitattributes` line-ending directives, and never attempt bulk line-ending
cleanup through shell commands (arbitrary bash rewrites cannot be claimed
safe). The guard is intentionally scoped: it does not rewrite `bash`, `sed`,
or any other command, and it never touches user-level Pi configuration - the
extension exists only for the lifetime of the spawned Pi process.

## Codex configuration

A user-level Codex entry, for example in `C:\Users\<you>\.codex\config.toml`:

    [mcp_servers.pi_wsl]
    enabled = true
    command = "cmd"
    args = ["/d", "/s", "/c", 'C:\path\to\pi-wsl-mcp\run-pi-wsl-mcp.cmd']
    startup_timeout_sec = 60.0
    tool_timeout_sec = 900.0

Restart Codex (or start a new Codex session) after changing its configuration.
The host tool timeout should exceed the bridge's ten-minute synchronous window
so the bridge can return a background handoff when needed. It is a host
transport setting, not a Pi task budget.
Replace any previous `[mcp_servers.pi_local]` entry with the `pi_wsl` name
shown above. If the bridge is moved, only the launcher path in this entry
changes - nothing inside the checkout references its own location.

The launcher forwards Windows-side `PI_WSL_MCP_*` environment variables into
WSL, so configuration can be set either in the Windows environment or inside
the distro's shell profile.

## Configuration

All configuration is optional and is read by the bridge inside WSL. Defaults
are derived from the real WSL environment - the user's home directory, the
bridge's current working directory (set by the Windows launcher to the
translated caller directory), and Pi's standard `~/.pi` state - so an
arbitrary user can run the bridge with zero setup.

| Variable | Default | Purpose |
| --- | --- | --- |
| PI_WSL_MCP_PI_BIN | `pi` on PATH | Pi command; resolved through the interactive zsh PATH unless set |
| PI_WSL_MCP_DEFAULT_CWD | bridge working directory | Default workspace |
| PI_WSL_MCP_ALLOWED_ROOTS | bridge working directory | Semicolon-separated allowed workspace roots |
| PI_WSL_MCP_SESSION_ROOT | $HOME/.pi/agent/sessions | Pi's saved-session store |
| PI_WSL_MCP_MAX_SESSIONS | 3 | Concurrent live Pi processes |
| PI_WSL_MCP_STARTUP_TIMEOUT_MS | 45000 | Pi startup acknowledgement timeout |
| PI_WSL_MCP_COMMAND_TIMEOUT_MS | 30000 | Individual Pi RPC acknowledgement timeout |
| PI_WSL_MCP_MAX_SAVED_SESSIONS | 100 | Saved sessions returned by pi_sessions at most |
| PI_WSL_MCP_RESULT_LIMIT | 24000 | Bounds the final Pi answer in `content[0].text` and every nested diagnostic string; truncation is explicit |
| PI_WSL_MCP_HISTORY_LIMIT | 80 | Bounded history entry count |
| PI_WSL_MCP_TOOLSET | `core` | MCP tool surface: `core` registers 3 expert tools plus wait/status/force-exit; `full` registers all 21 tools. Invalid values are rejected at startup |
| PI_WSL_MCP_LAUNCH | (launcher sets it) | Guard flag for interactive rc-file banners |
| PI_WSL_MCP_DISTRO | (unset) | WSL distro name used by the Windows launcher; default distro when unset |

The pre-release variable names `PI_LOCAL_MCP_*` remain accepted as
**deprecated aliases** with identical meanings (for example
`PI_LOCAL_MCP_PI_BIN` or `PI_LOCAL_MCP_TOOLSET`). When both names are set,
the `PI_WSL_MCP_*` value wins.
Migrate configurations to the new names.

Workspace arguments can be WSL paths such as `/home/<you>/projects/example` or
Windows drive paths such as `D:\projects\example`. The bridge canonicalizes
them and refuses paths outside `PI_WSL_MCP_ALLOWED_ROOTS`, so explicit
cross-project workspace selection works under configured roots:

    PI_WSL_MCP_ALLOWED_ROOTS="/home/<you>/projects/example;/home/<you>/projects/other;/srv/team/project-x"
    PI_WSL_MCP_DEFAULT_CWD="/home/<you>/projects/example"
    node src/cli.mjs

Then `pi_task`, `pi_start_session`, `pi_review`, and `pi_research` accept a
`workspace` argument selecting any project under those roots, and everything
else is refused with `workspace_not_allowed`.

### Allowed workspaces

Allowed roots are exactly what the name says: a Pi task under an allowed root
may read, edit, or run commands anywhere inside that root. List each workspace
**explicitly as its own root** - the project directory itself - and not a
broad parent such as `$HOME`, `/home/<you>`, or a whole drive mount like
`/mnt/d`: a broad root would make every project under it a selectable
workspace. Explicit roots keep the workspace list predictable and visible in
configuration:

    PI_WSL_MCP_ALLOWED_ROOTS="/home/<you>/projects/example;/home/<you>/projects/other;/srv/team/project-x"

When a host launches the bridge from a project directory, that directory
becomes the default workspace and the default allowed root; add further
project directories explicitly when a second workspace is needed. Sessions
are pinned to the workspace chosen at creation and cannot be silently moved
elsewhere; restoring a saved session re-checks its recorded workspace
against the configured roots.

## Migrating from Pi Local MCP

The old product names are deprecated; nothing new should use them, and the
old Windows launcher (`run-pi-mcp.cmd`) is gone. To migrate:

1. Rename the Codex server entry from `[mcp_servers.pi_local]` to
   `[mcp_servers.pi_wsl]` and point it at `run-pi-wsl-mcp.cmd` (see Codex
   configuration above).
2. Replace `PI_LOCAL_MCP_*` environment variables with the `PI_WSL_MCP_*`
   names in the table above. The old names keep working as deprecated aliases
   while you migrate, and the new name always wins when both are set.
3. The bridge package is now `pi-wsl-mcp` with the `pi-wsl-mcp` bin command;
   old package names are not published under any new name.
4. Old default values (`~/.../OpenSession`, a fixed `D:\...` workspace, an
   absolute Pi binary path) no longer exist; the bridge now derives its
   defaults from the WSL home directory, the caller's working directory, and
   `pi` on the interactive zsh PATH.

## Local validation

Run the static checks and the stdio smoke from WSL or PowerShell. On Windows
the smoke automatically uses the same `run-pi-wsl-mcp.cmd` launcher registered
with Codex. Run live checks from an interactive Pi environment:

    cd /path/to/pi-wsl-mcp
    npm run check
    npm run smoke:mcp
    npm run smoke:mcp -- --live --resume --workspace --lifecycle

To explicitly validate the exact Windows launcher used by Codex:

    cd D:\path\to\pi-wsl-mcp
    node scripts\mcp-smoke.mjs --windows-launcher --live

The live smoke test performs a real Pi task, confirms that DeepSeek's native
web_search completed without the same-name `search` tool conflict, can verify
saved-session resume and the start/send/status/wait/history lifecycle, and
closes live bridge sessions while preserving Pi's durable transcripts.

## Development notes

- The 21-tool MCP surface (`full` toolset), the default six-tool `core`
  surface (three experts plus continuation controls), protocol compatibility (initialization-based and stateless
  `2026-07-28`), read-only profile allowlists, redaction, bounded payloads,
  and allowed-root containment are behavior contracts; keep them intact when
  changing the bridge.
- `npm run check` runs `node --check` over the sources plus the full `node
  --test` suite, including config-default/legacy-alias, launcher portability,
  and EOL-guard tests.
- The package is public-ready (`pi-wsl-mcp`, `pi-wsl-mcp` bin, `files`
  allowlist, no `private` flag) but is intentionally not published; install
  from the checkout with `npm install -g .` when needed. It is licensed under
  the [MIT License](LICENSE).
