@echo off
chcp 936 >nul
setlocal
set "SRC=%~dp0firebase.properties"
set "GAMEDIR=%~1"

if "%GAMEDIR%"=="" set "GAMEDIR=%APPDATA%\.minecraft"
if not exist "%GAMEDIR%" goto NOGAME
if not exist "%SRC%" goto NOSRC

set "DEST=%GAMEDIR%\config\dangomusic"
if not exist "%DEST%" mkdir "%DEST%"
copy /y "%SRC%" "%DEST%\firebase.properties" >nul
if errorlevel 1 goto COPYFAIL

echo [OK] 已安装到
echo      %DEST%\firebase.properties
echo.
findstr /c:"party.example.com" "%DEST%\firebase.properties" >nul
if not errorlevel 1 goto PLACEHOLDER

echo 接下来：重启游戏，按 M 打开播放器，点左侧的一起听歌
echo 第一次进来请在页面底部"连接方式"里选 Direct
echo.
pause
exit /b 0

:PLACEHOLDER
echo [注意] 配置里还是占位的 party.example.com，需要先改成
echo        你们自己的服务器域名才能用。改好后再运行一次本脚本。
echo.
pause
exit /b 0

:NOGAME
echo [X] 找不到游戏目录：%GAMEDIR%
echo.
echo 如果你用 PCL / HMCL / 整合包，把那个 .minecraft 或者
echo 实例目录直接拖到这个 bat 文件上再松手。
echo 也可以手动复制 firebase.properties 到：
echo    ^<游戏目录^>\config\dangomusic\
pause
exit /b 1

:NOSRC
echo [X] 这个 bat 旁边没有 firebase.properties
echo     请把整个压缩包解压后再运行，不要只拿出 bat。
pause
exit /b 1

:COPYFAIL
echo [X] 复制失败，可能是没有写入权限。请手动复制：
echo      firebase.properties  -^>  %DEST%\
pause
exit /b 1
