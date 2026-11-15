@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\project-vp.ps1" %*
exit /b %ERRORLEVEL%
