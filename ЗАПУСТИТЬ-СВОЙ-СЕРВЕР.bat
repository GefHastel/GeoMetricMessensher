@echo off
chcp 65001 >nul
cd /d "%~dp0"
runtime\python.exe server.py --host 0.0.0.0 --port 5000
pause
