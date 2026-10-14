# Crea la tarea programada de Windows: cada martes 3:00 a.m. actualiza el NFL Predictor.
# Si la PC esta apagada a esa hora, se ejecuta en cuanto se encienda.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command python.exe).Source }

$action   = New-ScheduledTaskAction -Execute $py -Argument "`"$dir\nfl_predictor.py`"" -WorkingDirectory $dir
# Martes 3 a.m.: estadisticas nuevas. Jueves 2 p.m. y domingo 9 a.m.: refresca lesiones y clima.
$trigger  = @(
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Tuesday  -At 3:00am),
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Thursday -At 2:00pm),
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday   -At 9:00am)
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName "NFL Predictor - Actualizacion semanal" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Descarga estadisticas NFL y recalcula predicciones (martes 3 a.m.)" -Force | Out-Null
Write-Host "Tarea creada: martes 3:00 a.m. (estadisticas), jueves 2:00 p.m. y domingo 9:00 a.m. (lesiones/clima) usando $py"
