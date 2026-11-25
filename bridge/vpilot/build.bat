@echo off
rem Baut das vPilot-Plugin und kopiert es nach %LOCALAPPDATA%\vPilot\Plugins (vPilot vorher schliessen).
setlocal
cd /d "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
set VP=%LOCALAPPDATA%\vPilot
if not exist "%VP%\RossCarlson.Vatsim.Vpilot.Plugins.dll" (
  echo vPilot nicht gefunden unter %VP%
  exit /b 1
)
"%CSC%" /nologo /target:library /optimize+ /out:EFB-Waechter-vPilot.dll ^
  /reference:"%VP%\RossCarlson.Vatsim.Vpilot.Plugins.dll" /reference:"%FW%\System.Web.Extensions.dll" EfbPlugin.cs
if errorlevel 1 exit /b 1
if not exist "%VP%\Plugins" mkdir "%VP%\Plugins"
copy /y EFB-Waechter-vPilot.dll "%VP%\Plugins\" >nul
if errorlevel 1 (
  echo Kopieren fehlgeschlagen - laeuft vPilot noch?
  exit /b 1
)
echo Fertig: Plugin liegt in %VP%\Plugins. Beim naechsten vPilot-Start ist es aktiv.
