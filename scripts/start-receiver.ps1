<#
start-receiver.ps1 - runs the standby receiver on this PC, and can make it start at login.

What it does:
  (no switch)   Runs `python -m dryer_backend.remote` from backend/ and keeps it running:
                if it crashes it is restarted after 10 s. Output goes to logs\receiver.log
                (rotated at 5 MB). Exits straight away if a standby receiver is already
                running, so it never starts a second one.
  -Install      Registers a Windows Task Scheduler task, "DryerSensor Receiver", that runs
                this script hidden every time you log in, and starts it now.
  -Uninstall    Stops and removes that task.
  -Status       Shows the task's state, whether the receiver is running, and the last
                log lines.

Talks to:
  - backend\.venv (created by `uv sync` in backend/) and backend/src/dryer_backend/remote.py,
    which reads the repo-root .env (DATABASE_URL must point at the same database as the
    dashboard - Timescale Cloud when using the Vercel site).
  - docs/deployment_plan.md step D4.

How to run (PowerShell, from the repo root):
  powershell -ExecutionPolicy Bypass -File scripts\start-receiver.ps1 -Install
  powershell -ExecutionPolicy Bypass -File scripts\start-receiver.ps1 -Status
  powershell -ExecutionPolicy Bypass -File scripts\start-receiver.ps1 -Uninstall
  powershell -ExecutionPolicy Bypass -File scripts\start-receiver.ps1     (run in this window; Ctrl+C stops)
#>
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$Status
)

$ErrorActionPreference = "Continue"
$TaskName = "DryerSensor Receiver"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $RepoRoot "backend"
$Python = Join-Path $BackendDir ".venv\Scripts\python.exe"
$LogDir = Join-Path $RepoRoot "logs"
$LogFile = Join-Path $LogDir "receiver.log"
$MaxLogBytes = 5MB

# The log is opened in SHARED mode, so -Status (and you, in an editor) can read it while
# the receiver is writing to it. Plain Add-Content in a pipeline locks the file.
function Open-LogWriter {
    $stream = New-Object System.IO.FileStream($LogFile, [System.IO.FileMode]::Append,
        [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
    $writer.AutoFlush = $true
    return $writer
}

function Read-LogTail([int]$Count) {
    $stream = New-Object System.IO.FileStream($LogFile, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $reader = New-Object System.IO.StreamReader($stream)
    try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    return ($text -split "`r?`n" | Where-Object { $_ }) | Select-Object -Last $Count
}

function Write-Log([string]$Text) {
    $line = "{0} [start-receiver] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Text
    Write-Host $line
    $writer = Open-LogWriter
    try { $writer.WriteLine($line) } finally { $writer.Dispose() }
}

function Get-ReceiverProcesses {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -match 'dryer_backend\.remote' }
}

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# ---------------------------------------------------------------- -Install
if ($Install) {
    if (-not (Test-Path $Python)) {
        Write-Host "Python environment not found at $Python. Run 'uv sync' in backend\ first." -ForegroundColor Red
        exit 1
    }
    $script = $PSCommandPath
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Description "Standby receiver for the dryer lint monitor (scripts\start-receiver.ps1)" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Installed '$TaskName': it starts at every login, and is starting now." -ForegroundColor Green
    Write-Host "Check it with:  powershell -ExecutionPolicy Bypass -File scripts\start-receiver.ps1 -Status"
    exit 0
}

# ---------------------------------------------------------------- -Uninstall
if ($Uninstall) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed '$TaskName'."
    } else {
        Write-Host "'$TaskName' is not installed."
    }
    Get-ReceiverProcesses | ForEach-Object {
        Write-Host "Stopping receiver process $($_.ProcessId)."
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

# ---------------------------------------------------------------- -Status
if ($Status) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host ("Task '{0}': {1} (last run {2}, result {3})" -f $TaskName, $task.State, $info.LastRunTime, $info.LastTaskResult)
    } else {
        Write-Host "Task '$TaskName': not installed"
    }
    $procs = @(Get-ReceiverProcesses)
    if ($procs.Count -gt 0) {
        Write-Host ("Receiver: running (pid {0})" -f (($procs | ForEach-Object { $_.ProcessId }) -join ", ")) -ForegroundColor Green
    } else {
        Write-Host "Receiver: not running" -ForegroundColor Yellow
    }
    if (Test-Path $LogFile) {
        Write-Host "--- last lines of $LogFile ---"
        Read-LogTail 15
    }
    exit 0
}

# ---------------------------------------------------------------- run (default)
$existing = @(Get-ReceiverProcesses)
if ($existing.Count -gt 0) {
    Write-Log ("a standby receiver is already running (pid {0}); not starting another" -f $existing[0].ProcessId)
    exit 0
}
if (-not (Test-Path $Python)) {
    Write-Log "Python environment not found at $Python. Run 'uv sync' in backend\ first."
    exit 1
}

$env:PYTHONUNBUFFERED = "1"
Set-Location $BackendDir
while ($true) {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
        Move-Item -Force $LogFile "$LogFile.1"
    }
    Write-Log "starting standby receiver ($Python -m dryer_backend.remote)"
    # stderr (where Python logs) is merged into the log file line by line
    $writer = Open-LogWriter
    try {
        & $Python -m dryer_backend.remote 2>&1 | ForEach-Object { $writer.WriteLine("$_") }
        $code = $LASTEXITCODE
    } finally {
        $writer.Dispose()
    }
    if ($code -eq 0) {
        Write-Log "receiver stopped normally"
        break
    }
    Write-Log "receiver exited with code $code; restarting in 10 s"
    Start-Sleep -Seconds 10
}
