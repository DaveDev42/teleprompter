# Teleprompter CLI installer for Windows
# Usage:
#   irm https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.ps1 | iex
#   $env:VERSION = "v0.1.8"; irm ... | iex

param(
  [switch]$NoCompletions
)

$ErrorActionPreference = "Stop"

$Repo = "DaveDev42/teleprompter"
$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { "$env:LOCALAPPDATA\Programs\teleprompter" }
$BinName = "tp.exe"

# Detect architecture. PROCESSOR_ARCHITEW6432 is set when the current PowerShell
# process is running under WOW64 on an arm64/x64 native host; prefer it so an
# x64-emulated shell on arm64 Windows still installs the arm64 binary.
$archRaw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($archRaw) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default {
    # Write-Error terminates under $ErrorActionPreference='Stop'
    Write-Error "Unsupported architecture: $archRaw"
  }
}

$assetName = "tp-windows_${arch}.exe"

# Determine version
$version = $env:VERSION
if (-not $version) {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
  $version = $release.tag_name
}

Write-Host "Installing tp $version (windows/$arch) to $InstallDir..."

# Download
$url = "https://github.com/$Repo/releases/download/$version/$assetName"
$tmpDirPath = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP "tp-install-$([guid]::NewGuid())") -Force).FullName
$tmpBin = Join-Path $tmpDirPath $BinName

try {
  Invoke-WebRequest -Uri $url -OutFile $tmpBin -UseBasicParsing

  # Verify checksum (best-effort: skip if checksums.txt missing on older releases)
  $checksumUrl = "https://github.com/$Repo/releases/download/$version/checksums.txt"
  $checksumOk = $true
  try {
    $checksums = (Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing).Content
    $line = $checksums -split "`n" | Where-Object { $_ -match [regex]::Escape($assetName) } | Select-Object -First 1
    if ($line) {
      $expected = (($line -split "\s+")[0]).Trim()
      $actual = (Get-FileHash -Algorithm SHA256 -Path $tmpBin).Hash.ToLower()
      if ($actual -ne $expected.ToLower()) {
        $checksumOk = $false
        Write-Host "Checksum mismatch: expected $expected, got $actual"
      } else {
        Write-Host "Checksum verified."
      }
    }
  } catch {
    Write-Host "Checksum verification skipped (checksums.txt not available)."
  }

  if (-not $checksumOk) {
    throw "Checksum verification failed"
  }

  # Install
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $target = Join-Path $InstallDir $BinName
  Move-Item -Path $tmpBin -Destination $target -Force

  Write-Host "Installed tp to $target"
} finally {
  if ($tmpDirPath -and (Test-Path $tmpDirPath)) {
    Remove-Item -Path $tmpDirPath -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# PATH advice
if (-not ($env:Path -split ";" | Where-Object { $_ -ieq $InstallDir })) {
  Write-Host ""
  Write-Host "To use 'tp' from any shell, add this directory to PATH:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"`$env:Path;$InstallDir`", 'User')"
  Write-Host ""
  Write-Host "Or run: `"$target`" version"
}

# Install shell completions (idempotent, failure is non-fatal)
if (-not $NoCompletions) {
  try {
    $profileDir = Split-Path -Parent $PROFILE.CurrentUserAllHosts
    & $target completions install powershell --profile-dir "$profileDir"
  } catch {
    Write-Host ""
    Write-Host "Note: shell completions were not installed automatically."
    Write-Host "Run '$target completions install powershell' manually to enable them."
  }
}
