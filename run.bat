@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title Dango Music - 一起听歌服务器

if not defined HOST set HOST=127.0.0.1
if not defined PORT set PORT=8787

where node >nul 2>nul
if errorlevel 1 goto NONODE

netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 goto INUSE

echo ============================================================
echo.
echo    Dango Music · 一起听歌 · 自建服务器
echo.
echo ============================================================
echo.
for /f "delims=" %%v in ('node --version') do echo    Node 版本      %%v
echo    监听地址       http://%HOST%:%PORT%
echo    自检地址       http://%HOST%:%PORT%/healthz
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
echo [i] 端口 %PORT% 已经有程序在监听，服务器可能已经在跑了
echo.
echo     如果那是别的程序（比如 nginx 占了 8787），换个端口再启动：
echo       set PORT=8789
echo       run.bat
echo.
echo     如果确实是本服务器已经在跑：
echo       直接进游戏用就行；要重启就先关掉那个窗口
echo.
echo     确认它是不是我们的服务器：
echo       curl http://%HOST%:%PORT%/healthz
echo.
pause
exit /b 0
