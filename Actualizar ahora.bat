@echo off
cd /d "%~dp0"
echo Descargando estadisticas de la NFL y recalculando predicciones...
python nfl_predictor.py
echo.
echo Listo. Abriendo NFL Predictor...
start "" "%~dp0index.html"
timeout /t 5 >nul
