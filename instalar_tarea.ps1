# Crea la tarea programada de Windows: cada martes 3:00 a.m. actualiza el NFL Predictor.
# Si la PC esta apagada a esa hora, se ejecuta en cuanto se encienda.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command python.exe).Source }

$action   = New-ScheduledTaskAction -Execute $py -Argument "`"$dir\nfl_predictor.py`"" -WorkingDirectory $dir
# Cada 8 horas: 3:00 a.m. (ya termino el Monday Night), 11:00 a.m. y 7:00 p.m.
$trigger  = @(
  (New-ScheduledTaskTrigger -Daily -At 3:00am),
  (New-ScheduledTaskTrigger -Daily -At 11:00am),
  (New-ScheduledTaskTrigger -Daily -At 7:00pm)
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName "NFL Predictor - Actualizacion semanal" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Descarga estadisticas NFL y recalcula predicciones (martes 3 a.m.)" -Force | Out-Null
Write-Host "Tarea creada: cada 8 horas (3:00 a.m., 11:00 a.m. y 7:00 p.m.) usando $py"
