param(
  [ValidatePattern('^\d+\.\d+\.\d+\.\d+$')]
  [string]$Version = "1.0.0.0",
  [ValidateSet("win-x64", "win-arm64")]
  [string]$Runtime = "win-x64",
  [string]$PackageName = "iPhoneDataSharing",
  [string]$Publisher = "CN=iPhone Data Sharing",
  [string]$PublisherDisplayName = "iPhone Data Sharing",
  [string]$CertificatePath,
  [string]$CertificatePassword,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Layout = Join-Path $PSScriptRoot "layout"
$Output = Join-Path $PSScriptRoot "output"
$AppDist = Join-Path $Root "windows-agent\dist\iPhone Data Sharing"
$Architecture = if ($Runtime -eq "win-arm64") { "arm64" } else { "x64" }
$AppVersion = ($Version -split '\.')[0..2] -join '.'

function Find-WindowsSdkTool([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  $candidate = Get-ChildItem -Path $kits -Filter $Name -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\(x64|arm64)\\' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $candidate) { throw "$Name was not found. Install the Windows 10/11 SDK." }
  return $candidate.FullName
}

if (-not $SkipBuild) {
  & (Join-Path $Root "windows-agent\build.ps1") -Runtime $Runtime -Configuration Release -Version $AppVersion
}
if (-not (Test-Path (Join-Path $AppDist "iPhone Data Sharing.exe"))) {
  throw "Windows application staging output is missing: $AppDist"
}

if (Test-Path $Layout) { Remove-Item $Layout -Recurse -Force }
New-Item -ItemType Directory -Force $Layout, $Output | Out-Null
Copy-Item "$AppDist\*" $Layout -Recurse -Force
Copy-Item (Join-Path $PSScriptRoot "assets") (Join-Path $Layout "Assets") -Recurse -Force

$manifest = Get-Content (Join-Path $PSScriptRoot "AppxManifest.xml.in") -Raw
$manifest = $manifest.Replace("__PACKAGE_NAME__", $PackageName)
$manifest = $manifest.Replace("__PUBLISHER__", $Publisher.Replace("&", "&amp;").Replace('"', "&quot;"))
$manifest = $manifest.Replace("__PUBLISHER_DISPLAY_NAME__", $PublisherDisplayName.Replace("&", "&amp;").Replace('"', "&quot;"))
$manifest = $manifest.Replace("__VERSION__", $Version)
$manifest = $manifest.Replace("__ARCHITECTURE__", $Architecture)
[System.IO.File]::WriteAllText((Join-Path $Layout "AppxManifest.xml"), $manifest, [System.Text.UTF8Encoding]::new($false))

$makeappx = Find-WindowsSdkTool "makeappx.exe"
$msix = Join-Path $Output "iPhone-Data-Sharing-$Version-$Architecture.msix"
if (Test-Path $msix) { Remove-Item $msix -Force }
& $makeappx pack /o /d $Layout /p $msix
if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed with exit code $LASTEXITCODE." }

if ($CertificatePath) {
  $signtool = Find-WindowsSdkTool "signtool.exe"
  $signArgs = @("sign", "/fd", "SHA256", "/f", (Resolve-Path $CertificatePath).Path)
  if ($CertificatePassword) { $signArgs += @("/p", $CertificatePassword) }
  $signArgs += $msix
  & $signtool @signArgs
  if ($LASTEXITCODE -ne 0) { throw "SignTool failed with exit code $LASTEXITCODE." }
  Write-Host "Signed MSIX: $msix"
} else {
  Write-Warning "Created an unsigned MSIX. Sign it with a certificate whose subject exactly matches '$Publisher' before installation."
  Write-Host "Unsigned MSIX: $msix"
}
