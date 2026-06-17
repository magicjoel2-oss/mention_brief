@echo off
REM Wrapper invoked by Task Scheduler. Captures stdout/stderr to a daily log.
cd /d "%~dp0\.."

REM Today's date as YYYY-MM-DD (zero-padded), regardless of locale
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value ^| find "="') do set _dt=%%I
set _date=%_dt:~0,4%-%_dt:~4,2%-%_dt:~6,2%

if not exist "logs" mkdir "logs"

node "scripts\generate-digest.mjs" > "logs\digest-%_date%.log" 2>&1
exit /b %ERRORLEVEL%
