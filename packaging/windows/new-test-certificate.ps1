param(
  [string]$Publisher = "CN=iPhone Data Sharing",
  [Parameter(Mandatory = $true)]
  [string]$Password
)

$ErrorActionPreference = "Stop"
$Output = Join-Path $PSScriptRoot "output"
New-Item -ItemType Directory -Force $Output | Out-Null
$securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
$certificate = New-SelfSignedCertificate `
  -Type Custom `
  -Subject $Publisher `
  -FriendlyName "iPhone Data Sharing MSIX Test Certificate" `
  -KeyUsage DigitalSignature `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")

$pfx = Join-Path $Output "iPhone-Data-Sharing-Test.pfx"
$cer = Join-Path $Output "iPhone-Data-Sharing-Test.cer"
Export-PfxCertificate -Cert $certificate -FilePath $pfx -Password $securePassword | Out-Null
Export-Certificate -Cert $certificate -FilePath $cer | Out-Null
Write-Host "Test certificate created:"
Write-Host "  PFX: $pfx"
Write-Host "  CER: $cer"
Write-Warning "For testing only. Install the CER into Trusted People on the Windows test machine. Never use this certificate for production distribution."
