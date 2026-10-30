$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Install-WingetPackage([string]$Id) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget is required to install prerequisites automatically. Install App Installer from Microsoft Store, then run setup.cmd again."
  }
  Write-Host "Installing $Id ..."
  & winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget could not install $Id. Install it manually and rerun setup.cmd."
  }
  Refresh-Path
}

Write-Host ""
Write-Host "SmartCutter local setup" -ForegroundColor Cyan
Write-Host "This installs free local tools. WhisperX model files download on first run."
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Install-WingetPackage "OpenJS.NodeJS.LTS"
}
if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  Install-WingetPackage "Python.Python.3.11"
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Install-WingetPackage "Gyan.FFmpeg.Shared"
}

try {
  & py -3.11 --version
  if ($LASTEXITCODE -ne 0) { throw "Python 3.11 not found" }
} catch {
  Install-WingetPackage "Python.Python.3.11"
  & py -3.11 --version
  if ($LASTEXITCODE -ne 0) {
    throw "Python 3.11 was installed. Close and reopen PowerShell, then rerun setup.cmd."
  }
}

$nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required. Current version: $(node --version)"
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "Installing pnpm ..."
  & npm install --global pnpm@10
  if ($LASTEXITCODE -ne 0) { throw "Could not install pnpm." }
  Refresh-Path
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw "FFmpeg was installed but is not available in this terminal yet. Reopen PowerShell and run setup.cmd again."
}

$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
  Write-Host "Creating the local Python environment ..."
  & py -3.11 -m venv (Join-Path $Root ".venv")
  if ($LASTEXITCODE -ne 0) { throw "Could not create the Python environment." }
}

Write-Host "Updating Python package tools ..."
& $Python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Could not update pip." }

$GpuAvailable = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
if ($GpuAvailable) {
  Write-Host "NVIDIA GPU detected. Installing CUDA-enabled PyTorch ..."
  & $Python -m pip install torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
} else {
  Write-Host "No NVIDIA GPU detected. Installing CPU PyTorch; large-v3 will run more slowly."
  & $Python -m pip install torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu
}
if ($LASTEXITCODE -ne 0) { throw "PyTorch installation failed." }

Write-Host "Installing local WhisperX and API Worker dependencies ..."
& $Python -m pip install -r (Join-Path $Root "workers\local-whisperx\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "WhisperX installation failed." }

Write-Host "Installing SmartCutter workspace packages ..."
& pnpm install
if ($LASTEXITCODE -ne 0) { throw "Workspace dependency installation failed." }

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Run .\run.cmd to start SmartCutter in the terminal."
Write-Host "On first run, WhisperX large-v3 and the Arabic aligner download to your local model cache."
