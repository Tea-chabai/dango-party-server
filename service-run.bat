@echo off
rem 计划任务用的启动脚本：固定 8789、无交互、日志写 data\server.log
cd /d "%~dp0"
set HOST=127.0.0.1
set PORT=8789
"C:\Program Files\nodejs\node.exe" server.mjs >> "%~dp0data\server.log" 2>&1
