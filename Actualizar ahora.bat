@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo   NFL PREDICTOR - Actualizacion manual
echo ==============================================
echo.
echo [1/2] Pidiendo a GitHub que actualice la pagina web...
git checkout -- data >nul 2>&1
git clean -fdq -- data >nul 2>&1
git pull -q --rebase
echo %date% %time%> .ultima_actualizacion
git add .ultima_actualizacion
git commit -q -m "Actualizacion manual"
git push -q
if errorlevel 1 (
  echo     No se pudo conectar con GitHub. Solo se actualizara tu copia local.
) else (
  echo     Listo. La pagina web estara al dia en 1-2 minutos.
)
echo.
echo [2/2] Actualizando tu copia local...
python nfl_predictor.py
echo.
echo Listo. Abriendo NFL Predictor...
start "" "%~dp0index.html"
timeout /t 6 >nul
