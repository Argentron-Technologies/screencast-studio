<#
  screencast-studio installer — Windows bootstrapper

      powershell -c "irm https://raw.githubusercontent.com/Argentron-Technologies/screencast-studio/main/install.ps1 | iex"

  This file deliberately does almost nothing: it checks for node and git,
  clones the repo, then hands over to install.mjs, which holds all the real
  logic and behaves identically on every platform.

  No admin rights, nothing installed but this repo, nothing touched outside
  your user profile. Re-run to update.

  Override the location:  $env:SCS_DIR = "D:\tools\scs"; irm ... | iex
#>

$ErrorActionPreference = 'Stop'

$Repo = 'https://github.com/Argentron-Technologies/screencast-studio.git'
$Dest = if ($env:SCS_DIR) { $env:SCS_DIR } else { Join-Path $env:LOCALAPPDATA 'screencast-studio' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "  [x]  Node.js 18+ required. Install it first:" -ForegroundColor Red
  Write-Host "         winget install --id OpenJS.NodeJS.LTS"
  exit 1
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "  [x]  git required. Install it first:" -ForegroundColor Red
  Write-Host "         winget install --id Git.Git"
  exit 1
}

if (Test-Path (Join-Path $Dest '.git')) {
  git -C $Dest fetch --quiet origin
  git -C $Dest reset --hard --quiet origin/main
} elseif (Test-Path $Dest) {
  Write-Host "  [x]  $Dest exists but is not a git clone. Move it aside, or set `$env:SCS_DIR." -ForegroundColor Red
  exit 1
} else {
  git clone --quiet --depth 1 $Repo $Dest
}

$env:SCS_DIR = $Dest
node (Join-Path $Dest 'install.mjs')
