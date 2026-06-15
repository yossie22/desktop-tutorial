@echo off
cd /d "%~dp0"
set "DEST=%~dp0GitHubUpload"
if not exist "%DEST%\" mkdir "%DEST%"
copy /Y "%~dp0viewer.html" "%DEST%\viewer.html"
copy /Y "%~dp0map.html" "%DEST%\map.html"
copy /Y "%~dp0data.js" "%DEST%\data.js"
if not exist "%~dp0help\" mkdir "%~dp0help"
copy /Y "%~dp0地図の取説\取説設定.js" "%~dp0help\config.js"
if not exist "%DEST%\help\" mkdir "%DEST%\help"
copy /Y "%~dp0help\index.html" "%DEST%\help\index.html"
copy /Y "%~dp0help\help-engine.js" "%DEST%\help\help-engine.js"
copy /Y "%~dp0help\help.css" "%DEST%\help\help.css"
copy /Y "%~dp0help\config.js" "%DEST%\help\config.js"
if exist "%~dp0shadows\" (
  if not exist "%DEST%\shadows\" mkdir "%DEST%\shadows"
  copy /Y "%~dp0shadows\*.png" "%DEST%\shadows\" 2>nul
)
if exist "%~dp0video\guide_alpha_ios.mp4" copy /Y "%~dp0video\guide_alpha_ios.mp4" "%DEST%\guide_alpha_ios.mp4"
echo.
echo Done. Files copied to:
echo %DEST%
echo.
echo ============================================================
echo  GitHub Desktop を使う場合
echo ============================================================
echo  GitHubUpload ではなく、リポジトリ直下の help フォルダが必要です。
echo  アジサイ側の「GitHubDesktop用に反映.cmd」を使ってください。
echo.
echo  ブラウザで直接アップロードする場合:
echo    help\index.html  help\config.js  help\help-engine.js  help\help.css
echo    map.html  viewer.html  data.js
echo.
pause
