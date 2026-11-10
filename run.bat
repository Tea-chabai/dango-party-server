@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title Dango Music - 一起听歌服务器

where node >nul 2>nul
if errorlevel 1 goto NONODE

netstat -ano | findstr ":8787" | findstr "LISTENING" >nul
if not errorlevel 1 goto INUSE

echo ============================================================
echo.
echo    Dango Music · 一起听歌 · 自建服务器
echo.
echo ============================================================
echo.
for /f "delims=" %%v in ('node --version') do echo    Node 版本      %%v
echo    监听地址       http://127.0.0.1:8787
echo    自检地址       http://127.0.0.1:8787/healthz
echo.
echo    换端口         先 set PORT=9000，再运行本脚本
echo    停止服务       关闭这个窗口，或者按 Ctrl+C
echo.
echo ------------------------------------------------------------
echo.
echo    下面会打印 apiKey、运维口令、配置文件位置
echo.
echo ------------------------------------------------------------
echo.

node server.mjs
echo.
echo 服务器已停止。
pause
exit /b 0

:NONODE
echo.
echo [X] 没找到 Node.js
echo     请先安装 https://nodejs.org/ 18 以上版本，再运行本脚本
echo.
pause
exit /b 1

:INUSE
echo.
echo [i] 端口 8787 已经有程序在监听，服务器可能已经在跑了
echo.
echo     直接进游戏用就行；要重启的话：
echo       1. 先关掉之前那个黑窗口，或者
echo       2. 在任务管理器里结束 node.exe
echo.
echo     确认它是不是我们的服务器：
echo       curl http://127.0.0.1:8787/healthz
echo.
pause
exit /b 0
