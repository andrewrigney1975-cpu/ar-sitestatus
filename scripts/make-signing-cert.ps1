# Creates a self-signed Authenticode code-signing certificate for the Windows installer and
# exports it to desktop/.signing/ (gitignored). The certificate is removed from the user's
# certificate store afterwards; only the .pfx file and its password remain.
#
# Windows SmartScreen will still warn on first run, because the certificate isn't from a
# trusted CA. To trust it on a machine you control, import desktop/.signing/site-status-codesign.cer
# into "Trusted Root Certification Authorities" and "Trusted Publishers" (certmgr.msc).
param([int]$Years = 5)

$ErrorActionPreference = 'Stop'
$outDir = Join-Path $PSScriptRoot '..\desktop\.signing'
New-Item -ItemType Directory -Force $outDir | Out-Null
$pfx = Join-Path $outDir 'site-status-codesign.pfx'
$cer = Join-Path $outDir 'site-status-codesign.cer'
$pwFile = Join-Path $outDir 'password.txt'

if (Test-Path $pfx) { Write-Host "Certificate already exists: $pfx"; exit 0 }

$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject 'CN=Site Status (self-signed), O=Andrew Rigney' `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddYears($Years)

$password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$secure = ConvertTo-SecureString $password -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Set-Content -Path $pwFile -Value $password -NoNewline -Encoding ascii
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"

Write-Host "Created $pfx (thumbprint $($cert.Thumbprint))"
Write-Host "Password saved to $pwFile. Keep both out of source control."
