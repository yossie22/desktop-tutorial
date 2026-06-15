@echo off
cd /d "%~dp0"
copy /Y "%~dp0地図の取説\取説設定.js" "%~dp0help\config.js"
echo.
echo 取説を help\config.js にコピーしました。
echo 地図の「？使い方」は 地図の取説\取説設定.js を直接読みます。
echo GitHub に上げる前に、このコピーが GitHub用フォルダにも必要なら
echo 「GitHub用ファイルを更新.cmd」も実行してください。
echo.
pause
