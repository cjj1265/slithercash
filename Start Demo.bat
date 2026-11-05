@echo off
title SnakePay demo (close this window to stop it)
cd /d "%~dp0files"
echo.
echo Starting the SnakePay demo. Your browser will open in a few seconds.
echo Close this window when you want to stop it.
echo.
start "" cmd /c "timeout /t 5 /nobreak >nul & start http://localhost:8787"
call npm run demo
echo.
echo The demo has stopped.
pause
