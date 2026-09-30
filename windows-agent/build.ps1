param(
  [ValidateSet("win-x64", "win-arm64")]
  [string]$Runtime = "win-x64",
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release",
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Dist = Join-Path $PSScriptRoot "dist\iPhone Data Sharing"
$Publish = Join-Path $PSScriptRoot "build\publish"
$Resources = Join-Path $Dist "resources"
$ShortcutSource = Join-Path $PSScriptRoot "resources\shortcuts"

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required to build iPhone Data Sharing for Windows."
  }
}

Require-Command "node"
Require-Command "npm"
Require-Command "dotnet"

$requiredShortcuts = @(
  "send-ja.shortcut","receive-ja.shortcut",
  "send-en.shortcut","receive-en.shortcut",
  "send-zh.shortcut","receive-zh.shortcut",
  "send-ko.shortcut","receive-ko.shortcut",
  "send-es.shortcut","receive-es.shortcut",
  "send-fr.shortcut","receive-fr.shortcut",
  "send-de.shortcut","receive-de.shortcut"
)
foreach ($name in $requiredShortcuts) {
  if (-not (Test-Path (Join-Path $ShortcutSource $name))) {
    throw "Missing signed shortcut template: $name`nRun windows-agent/prepare-shortcuts-mac.sh on macOS first."
  }
}

$ShortcutManifestPath = Join-Path $ShortcutSource "manifest.json"
if (-not (Test-Path $ShortcutManifestPath)) {
  throw "Missing shortcut manifest: $ShortcutManifestPath`nRun windows-agent/prepare-shortcuts-mac.sh on macOS first."
}
$ShortcutManifest = Get-Content $ShortcutManifestPath -Raw | ConvertFrom-Json
foreach ($name in $requiredShortcuts) {
  $entry = @($ShortcutManifest.files | Where-Object { $_.name -eq $name })
  if ($entry.Count -ne 1) {
    throw "Shortcut manifest must contain exactly one entry for: $name"
  }
  $file = Join-Path $ShortcutSource $name
  $actualSize = (Get-Item $file).Length
  $actualHash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSize -ne [long]$entry[0].size -or $actualHash -ne ([string]$entry[0].sha256).ToLowerInvariant()) {
    throw "Signed shortcut template failed integrity validation: $name`nRun windows-agent/prepare-shortcuts-mac.sh on macOS again."
  }
}

Push-Location $Root
try {
  if (Test-Path "server\package-lock.json") {
    npm --prefix server ci
  } else {
    npm --prefix server install
  }
  npm --prefix server run build

  if (Test-Path $Publish) { Remove-Item $Publish -Recurse -Force }
  dotnet publish windows-agent\IPhoneDataSharing.Windows.csproj `
    -c $Configuration `
    -r $Runtime `
    --self-contained true `
    -p:Version=$Version `
    -p:FileVersion="$Version.0" `
    -p:AssemblyVersion="$Version.0" `
    -p:PublishSingleFile=true `
    -p:PublishTrimmed=false `
    -o $Publish

  if (Test-Path $Dist) { Remove-Item $Dist -Recurse -Force }
  New-Item -ItemType Directory -Force $Dist | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $Resources "server\dist") | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $Resources "shortcuts") | Out-Null

  Copy-Item "$Publish\*" $Dist -Recurse -Force
  Copy-Item "server\dist\*" (Join-Path $Resources "server\dist") -Recurse -Force
  Copy-Item "server\package.json" (Join-Path $Resources "server\package.json") -Force
  Copy-Item "server\package-lock.json" (Join-Path $Resources "server\package-lock.json") -Force
  npm --prefix (Join-Path $Resources "server") ci --omit=dev
  Copy-Item "$ShortcutSource\*" (Join-Path $Resources "shortcuts") -Recurse -Force

  $NodeExe = (Get-Command node).Source
  Copy-Item $NodeExe (Join-Path $Resources "node.exe") -Force

  if (Test-Path "AppIcon.png") {
    Copy-Item "AppIcon.png" (Join-Path $Resources "AppIcon.png") -Force
  }

  $Zip = Join-Path $PSScriptRoot "dist\iPhone-Data-Sharing-Windows.zip"
  if (Test-Path $Zip) { Remove-Item $Zip -Force }
  Compress-Archive -Path "$Dist\*" -DestinationPath $Zip -CompressionLevel Optimal

  Write-Host ""
  Write-Host "Build complete:"
  Write-Host "  $Dist"
  Write-Host "  $Zip"
}
finally {
  Pop-Location
}
