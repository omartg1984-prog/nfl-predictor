# Crea la tarea programada de Windows: actualiza el NFL Predictor cada 6 horas.
# Si la PC esta apagada a esa hora, se ejecuta en cuanto se encienda.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command python.exe).Source }

$action   = New-ScheduledTaskAction -Execute $py -Argument "`"$dir\nfl_predictor.py`"" -WorkingDirectory $dir
# Cada 6 horas: 12:00 a.m., 6:00 a.m., 12:00 p.m. y 6:00 p.m.
$trigger  = @(
  (New-ScheduledTaskTrigger -Daily -At 12:00am),
  (New-ScheduledTaskTrigger -Daily -At 6:00am),
  (New-ScheduledTaskTrigger -Daily -At 12:00pm),
  (New-ScheduledTaskTrigger -Daily -At 6:00pm)
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName "NFL Predictor - Actualizacion semanal" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Descarga estadisticas NFL y recalcula predicciones (cada 6 horas)" -Force | Out-Null
Write-Host "Tarea creada: cada 6 horas (12 a.m., 6 a.m., 12 p.m. y 6 p.m.) usando $py"
