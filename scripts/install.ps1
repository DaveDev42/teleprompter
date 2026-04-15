# Teleprompter CLI installer for Windows
# Usage:
#   irm https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.ps1 | iex
#   $env:VERSION = "v0.1.8"; irm ... | iex

$ErrorActionPreference = "Stop"

$Repo = "DaveDev42/teleprompter"
$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { "$env:LOCALAPPDATA\Programs\teleprompter" }
$BinName = "tp.exe"

# Detect architecture
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default {
    Write-Error "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
    exit 1
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
$tmpDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "tp-install-$([guid]::NewGuid())") -Force
$tmpBin = Join-Path $tmpDir $BinName
Invoke-WebRequest -Uri $url -OutFile $tmpBin -UseBasicParsing

# Verify checksum (best-effort: skip if checksums.txt missing on older releases)
$checksumUrl = "https://github.com/$Repo/releases/download/$version/checksums.txt"
try {
  $checksums = (Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing).Content
  $line = $checksums -split "`n" | Where-Object { $_ -match [regex]::Escape($assetName) } | Select-Object -First 1
  if ($line) {
    $expected = ($line -split "\s+")[0]
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tmpBin).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
      Write-Error "Checksum mismatch: expected $expected, got $actual"
      exit 1
    }
    Write-Host "Checksum verified."
  }
} catch {
  Write-Host "Checksum verification skipped (checksums.txt not available)."
}

# Install
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$target = Join-Path $InstallDir $BinName
Move-Item -Path $tmpBin -Destination $target -Force
Remove-Item -Path $tmpDir -Recurse -Force

Write-Host "Installed tp to $target"

# PATH advice
if (-not ($env:Path -split ";" | Where-Object { $_ -eq $InstallDir })) {
  Write-Host ""
  Write-Host "To use 'tp' from any shell, add this directory to PATH:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"`$env:Path;$InstallDir`", 'User')"
  Write-Host ""
  Write-Host "Or run: `"$target`" version"
}
