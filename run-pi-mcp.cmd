@echo off
setlocal
wsl.exe -d Ubuntu -- env PI_LOCAL_MCP_LAUNCH=1 zsh -ic "exec node /mnt/d/WorkSpace/pi-local-mcp/src/cli.mjs"
exit /b %errorlevel%
