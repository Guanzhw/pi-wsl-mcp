@echo off
rem Pi WSL MCP - portable Windows launcher.
rem
rem Launches the Pi WSL MCP bridge inside WSL without any fixed user, drive,
rem distro, or package paths:
rem   - uses the default WSL distro, or the distro named by PI_WSL_MCP_DISTRO
rem   - locates this package from %~dp0 and translates it to a WSL path
rem   - starts the bridge in the translated caller working directory so the
rem     default workspace follows where the MCP client was launched from
rem   - forwards PI_WSL_MCP_* configuration variables (and the deprecated
rem     PI_LOCAL_MCP_* aliases) from the Windows environment into WSL via WSLENV
rem   - sets PI_WSL_MCP_LAUNCH=1 so interactive shell rc files can guard
rem     banners or prompts that would corrupt the MCP JSONL stream
setlocal EnableExtensions EnableDelayedExpansion

where wsl.exe >nul 2>nul
if errorlevel 1 (
  >&2 echo [pi-wsl-mcp] wsl.exe was not found on PATH. Enable WSL and retry.
  exit /b 1
)

rem --- distro: PI_WSL_MCP_DISTRO or the user's default distro ---
set "DISTRO_ARG="
if defined PI_WSL_MCP_DISTRO set "DISTRO_ARG=-d !PI_WSL_MCP_DISTRO!"

rem --- translate this package's directory to a WSL path ---
set "PKG_WIN=%~dp0"
set "PKG_DRIVE=!PKG_WIN:~0,1!"
set "PKG_DRIVE_LOWER="
for %%D in (a b c d e f g h i j k l m n o p q r s t u v w x y z) do (
  if /I "!PKG_DRIVE!"=="%%D" set "PKG_DRIVE_LOWER=%%D"
)
if not defined PKG_DRIVE_LOWER (
  >&2 echo [pi-wsl-mcp] The launcher must run from a drive-letter path, not "!PKG_WIN!".
  exit /b 1
)
rem Drop both the drive colon and the leading slash so the final WSL path has
rem exactly one slash after /mnt/<drive>.
set "PKG_REST=!PKG_WIN:~3!"
set "PKG_REST=!PKG_REST:\=/!"
set "PKG_WSL=/mnt/!PKG_DRIVE_LOWER!/!PKG_REST!"

rem --- translate the caller working directory (the default workspace) ---
set "CWD_WIN=%CD%"
set "CWD_WSL="
if "!CWD_WIN:~1,1!"==":" (
  set "CWD_DRIVE=!CWD_WIN:~0,1!"
  set "CWD_DRIVE_LOWER="
  for %%D in (a b c d e f g h i j k l m n o p q r s t u v w x y z) do (
    if /I "!CWD_DRIVE!"=="%%D" set "CWD_DRIVE_LOWER=%%D"
  )
  if defined CWD_DRIVE_LOWER (
    set "CWD_REST=!CWD_WIN:~3!"
    set "CWD_REST=!CWD_REST:\=/!"
    set "CWD_WSL=/mnt/!CWD_DRIVE_LOWER!/!CWD_REST!"
  )
)
rem When the caller's directory is not translatable (for example a UNC path),
rem no --cd is passed and WSL starts in the user's home directory, which
rem becomes the bridge's default workspace.

rem --- forward configuration variables from Windows into WSL ---
set "PI_WSL_MCP_PKG=!PKG_WSL!"
set "WSLENV_LIST=PI_WSL_MCP_PKG/u:PI_WSL_MCP_PI_BIN/u:PI_WSL_MCP_DEFAULT_CWD/u:PI_WSL_MCP_ALLOWED_ROOTS/u:PI_WSL_MCP_SESSION_ROOT/u:PI_WSL_MCP_MAX_SESSIONS/u:PI_WSL_MCP_MAX_WAIT_SECONDS/u:PI_WSL_MCP_STARTUP_TIMEOUT_MS/u:PI_WSL_MCP_COMMAND_TIMEOUT_MS/u:PI_WSL_MCP_MAX_SAVED_SESSIONS/u:PI_WSL_MCP_RESULT_LIMIT/u:PI_WSL_MCP_HISTORY_LIMIT/u:PI_WSL_MCP_TOOLSET/u:PI_LOCAL_MCP_PI_BIN/u:PI_LOCAL_MCP_DEFAULT_CWD/u:PI_LOCAL_MCP_ALLOWED_ROOTS/u:PI_LOCAL_MCP_SESSION_ROOT/u:PI_LOCAL_MCP_MAX_SESSIONS/u:PI_LOCAL_MCP_MAX_WAIT_SECONDS/u:PI_LOCAL_MCP_STARTUP_TIMEOUT_MS/u:PI_LOCAL_MCP_COMMAND_TIMEOUT_MS/u:PI_LOCAL_MCP_MAX_SAVED_SESSIONS/u:PI_LOCAL_MCP_RESULT_LIMIT/u:PI_LOCAL_MCP_HISTORY_LIMIT/u:PI_LOCAL_MCP_TOOLSET/u"
if defined WSLENV (
  set "WSLENV=!WSLENV!:!WSLENV_LIST!"
) else (
  set "WSLENV=!WSLENV_LIST!"
)

rem --- launch: interactive zsh loads ~/.zshrc (credentials, extensions) ---
rem PI_WSL_MCP_PKG is the translated package directory; run the bridge entry
rem from it so no installed bin or fixed path is required.
if defined CWD_WSL (
  wsl.exe !DISTRO_ARG! --cd "!CWD_WSL!" -- env PI_WSL_MCP_LAUNCH=1 zsh -ic "exec node '!PI_WSL_MCP_PKG!/src/cli.mjs'"
) else (
  wsl.exe !DISTRO_ARG! -- env PI_WSL_MCP_LAUNCH=1 zsh -ic "exec node '!PI_WSL_MCP_PKG!/src/cli.mjs'"
)
exit /b %errorlevel%
