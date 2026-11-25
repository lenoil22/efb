@echo off
rem Baut EFB-Bridge.exe mit dem in Windows eingebauten C#-Compiler (.NET Framework 4.x) – keine Installation nötig.
cd /d "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
powershell -NoProfile -ExecutionPolicy Bypass -File make-icon.ps1
"%CSC%" /nologo /codepage:65001 /target:winexe /optimize+ /win32icon:efb.ico /out:..\EFB-Bridge.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll EFB-Bridge.cs
if errorlevel 1 (echo Build fehlgeschlagen & exit /b 1)
echo Fertig: ..\EFB-Bridge.exe
