# Packages the extension into a distributable zip, excluding dev-only files.
# Usage: powershell -File build-zip.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$manifest = Get-Content "$root\manifest.json" -Raw | ConvertFrom-Json
$name = ($manifest.name -replace '\s+', '-').ToLower()
$outZip = Join-Path $root "$name-$($manifest.version).zip"
$stage = Join-Path $env:TEMP "$name-build-stage"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

$excludeDirs = @('.git', '.agents', 'docs', 'landing_page', 'node_modules', '.vscode', '.claude')
$excludeFiles = @('*.zip', '*.md', 'build-zip.ps1', 'build-zip.sh')

robocopy $root $stage /E /XD $excludeDirs /XF $excludeFiles /NFL /NDL /NJH /NJS | Out-Null

if (Test-Path $outZip) { Remove-Item $outZip -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $outZip -Force

Remove-Item $stage -Recurse -Force

Write-Host "Created $outZip"
