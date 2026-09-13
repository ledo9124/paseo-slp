@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "RESOURCES_DIR=%SCRIPT_DIR%.."
set "APP_EXECUTABLE=%RESOURCES_DIR%\..\Paseo SLP.exe"
if not exist "%APP_EXECUTABLE%" (
  echo Bundled Paseo SLP executable not found at %APP_EXECUTABLE% 1>&2
  exit /b 1
)

if not defined PASEO_SLP_HOME set "PASEO_SLP_HOME=%USERPROFILE%\.paseo-slp"
if not defined PASEO_SLP_LISTEN set "PASEO_SLP_LISTEN=127.0.0.1:6777"
set "PASEO_HOME=%PASEO_SLP_HOME%"
set "PASEO_LISTEN=%PASEO_SLP_LISTEN%"
set "PASEO_HOST=%PASEO_LISTEN%"

set "ELECTRON_RUN_AS_NODE=1"
set "PASEO_NODE_ENV=production"
rem PASEO_DESKTOP_MANAGED marks daemons started through this bundled CLI as
rem desktop-managed, so the desktop app restarts them when it upgrades.
set "PASEO_DESKTOP_MANAGED=1"
set "PASEO_CLI=%~f0"
set "PASEO_SLP_DESKTOP_APP=%APP_EXECUTABLE%"
"%APP_EXECUTABLE%" --disable-warning=DEP0040 "%RESOURCES_DIR%\app.asar.unpacked\dist\daemon\node-entrypoint-runner.js" node-script "%RESOURCES_DIR%\app.asar\node_modules\@getpaseo\cli\dist\index.js" %*
exit /b %errorlevel%
