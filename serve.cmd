@echo off
REM AURA-AgriNet local server.
REM
REM A service worker will NOT register over file:// -- it needs a real origin.
REM So the PWA must be tested over http://localhost, never by double-clicking
REM index.html. localhost is treated as a secure context, so no HTTPS needed here.

cd /d "%~dp0"
echo.
echo   AURA-AgriNet  --  http://localhost:8080
echo.
echo   Open that URL, then DevTools ^> Application to check the
echo   manifest and service worker. Ctrl+C to stop.
echo.
start "" "http://localhost:8080"
python -m http.server 8080
