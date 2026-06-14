@echo off
cd /d "%~dp0"
set "DEST=%~dp0GitHubUpload"
if not exist "%DEST%\" mkdir "%DEST%"
copy /Y "%~dp0viewer.html" "%DEST%\viewer.html"
copy /Y "%~dp0map.html" "%DEST%\map.html"
copy /Y "%~dp0data.js" "%DEST%\data.js"
if exist "%~dp0help\" (
  if not exist "%DEST%\help\" mkdir "%DEST%\help"
  copy /Y "%~dp0help\index.html" "%DEST%\help\index.html"
  copy /Y "%~dp0help\config.js" "%DEST%\help\config.js"
)
if exist "%~dp0shadows\" (
  if not exist "%DEST%\shadows\" mkdir "%DEST%\shadows"
  copy /Y "%~dp0shadows\*.png" "%DEST%\shadows\" 2>nul
)
if exist "%~dp0video\guide_alpha_ios.mp4" copy /Y "%~dp0video\guide_alpha_ios.mp4" "%DEST%\guide_alpha_ios.mp4"
echo.
echo Done. Files copied to:
echo %DEST%
echo.
echo Upload to GitHub (changed files only if already uploaded once):
echo   map.html  viewer.html  data.js
echo   help/index.html  help/config.js
echo   shadows/*.png  (if you saved foot shadows)
echo.
echo Put guide_alpha_ios.mp4 into video/ on GitHub if not there yet.
pause
