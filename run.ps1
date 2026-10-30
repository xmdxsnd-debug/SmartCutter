$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Test-Path (Join-Path $Root ".venv\Scripts\python.exe")) -or -not (Test-Path (Join-Path $Root "node_modules"))) {
  & (Join-Path $Root "setup.ps1")
  if ($LASTEXITCODE -ne 0) { throw "SmartCutter setup did not complete." }
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw "FFmpeg is not available. Run .\setup.cmd again."
}

$Python = Join-Path $Root ".venv\Scripts\python.exe"
$LocalRuntime = Join-Path $Root ".smartcutter-local"
New-Item -ItemType Directory -Force -Path $LocalRuntime | Out-Null

foreach ($port in @(8001, 8080)) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    throw "Port $port is already in use. Close the other process and run run.cmd again."
  }
}

$env:WHISPERX_URL = "http://127.0.0.1:8001"
$env:PORT = "8080"
$env:NODE_ENV = "development"
$env:HF_HOME = Join-Path $env:LOCALAPPDATA "SmartCutter\huggingface"

if (-not $env:WHISPERX_API_KEY) {
  $bytes = New-Object byte[] 32
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $random.GetBytes($bytes)
  $env:WHISPERX_API_KEY = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
  $random.Dispose()
}

Write-Host "Building the local API ..."
& pnpm --filter @workspace/api-server run build
if ($LASTEXITCODE -ne 0) { throw "The local API build failed." }

$WorkerOut = Join-Path $LocalRuntime "whisperx.log"
$WorkerErr = Join-Path $LocalRuntime "whisperx-error.log"
$ApiOut = Join-Path $LocalRuntime "api.log"
$ApiErr = Join-Path $LocalRuntime "api-error.log"
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$WorkerDirectory = Join-Path $Root "workers\local-whisperx"
$ApiEntry = Join-Path $Root "artifacts\api-server\dist\index.mjs"

$WorkerProcess = $null
$ApiProcess = $null
try {
  Write-Host "Starting the local WhisperX worker ..."
  $WorkerProcess = Start-Process `
    -FilePath $Python `
    -ArgumentList @("-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8001") `
    -WorkingDirectory $WorkerDirectory `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $WorkerOut `
    -RedirectStandardError $WorkerErr

  Write-Host "Starting the SmartCutter API ..."
  $ApiProcess = Start-Process `
    -FilePath $Node `
    -ArgumentList @("--enable-source-maps", "`"$ApiEntry`"") `
    -WorkingDirectory $Root `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $ApiOut `
    -RedirectStandardError $ApiErr

  $apiReady = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($ApiProcess.HasExited) { throw "SmartCutter API stopped. Check $ApiErr" }
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/healthz" -TimeoutSec 2
      $apiReady = $true
      break
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $apiReady) { throw "SmartCutter API did not start. Check $ApiErr" }

  Write-Host "Loading WhisperX large-v3 and forced-alignment models locally." -ForegroundColor Cyan
  Write-Host "The first run downloads model files; later runs use the local cache."
  $workerReady = $false
  $deadline = (Get-Date).AddHours(6)
  while ((Get-Date) -lt $deadline) {
    if ($WorkerProcess.HasExited) { throw "Local WhisperX worker stopped. Check $WorkerErr" }
    if ($ApiProcess.HasExited) { throw "SmartCutter API stopped. Check $ApiErr" }
    try {
      $status = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/smartcutter/status" -TimeoutSec 15
      if ($status.whisperXAvailable) {
        Write-Host "WhisperX is ready: $($status.alignmentMode)" -ForegroundColor Green
        $workerReady = $true
        break
      }
    } catch {
      Write-Host "Waiting for local models to load ..."
    }
    Start-Sleep -Seconds 8
  }
  if (-not $workerReady) { throw "WhisperX did not become ready within one hour. Check $WorkerErr" }

  Write-Host ""
  Write-Host "Starting SmartCutter console. Close this window to stop local services." -ForegroundColor Green
  & pnpm --filter @workspace/scripts run smartcutter
  if ($LASTEXITCODE -ne 0) { throw "SmartCutter console exited with an error." }
} finally {
  foreach ($process in @($ApiProcess, $WorkerProcess)) {
    if ($null -ne $process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}
