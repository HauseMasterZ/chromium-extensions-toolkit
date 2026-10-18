# Setup script for CToolkit GPU Telemetry Native Messaging Host
param(
    [switch]$NewKey = $false
)

$ErrorActionPreference = 'Stop'

Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host " CToolkit Native Messaging Host Setup" -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

$hostBatPath = Join-Path $scriptDir "host.bat"
$jsonManifestPath = Join-Path $scriptDir "com.gpu.telemetry.json"
$extensionManifestPath = (Resolve-Path (Join-Path $scriptDir "..\manifest.json")).Path

if (-not (Test-Path $hostBatPath)) {
    Write-Error "host.bat not found at: $hostBatPath"
    exit 1
}

if (-not (Test-Path $extensionManifestPath)) {
    Write-Error "manifest.json not found at: $extensionManifestPath"
    exit 1
}

Write-Host "[1/3] Synchronizing Extension Key & Origin..." -ForegroundColor Yellow

$manifestRaw = Get-Content -Raw -Path $extensionManifestPath
$manifest = $manifestRaw | ConvertFrom-Json

$pubBase64 = $manifest.key
$needsNewKey = $NewKey -or (-not $pubBase64) -or ($pubBase64.Length -lt 100) -or ($pubBase64 -eq "GENERATE_ON_INSTALL")

if ($needsNewKey) {
    Write-Host "  Generating fresh 2048-bit RSA key pair..." -ForegroundColor Green
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider(2048)
    $p = $rsa.ExportParameters($false)

    # Standard ASN.1 SubjectPublicKeyInfo fixed header for 2048-bit RSA (33 bytes)
    $header = [byte[]]@(
        0x30, 0x82, 0x01, 0x22, 0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86,
        0xF7, 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x0F, 0x00,
        0x30, 0x82, 0x01, 0x0A, 0x02, 0x82, 0x01, 0x01, 0x00
    )
    $exponentTail = [byte[]]@(0x02, 0x03, 0x01, 0x00, 0x01)

    $der = New-Object byte[] 294
    [System.Buffer]::BlockCopy($header, 0, $der, 0, 33)
    [System.Buffer]::BlockCopy($p.Modulus, 0, $der, 33, 256)
    [System.Buffer]::BlockCopy($exponentTail, 0, $der, 289, 5)
    $pubBase64 = [Convert]::ToBase64String($der)
    $manifestRaw = [System.IO.File]::ReadAllText($extensionManifestPath)
    if ($manifestRaw -match '"key"\s*:\s*"[^"]*"') {
        $manifestRaw = $manifestRaw -replace '"key"\s*:\s*"[^"]*"', ('"key": "' + $pubBase64 + '"')
    } else {
        $manifestRaw = $manifestRaw -replace '{\r?\n', ("{`r`n  `"key`": `"" + $pubBase64 + "`",`r`n")
    }
    [System.IO.File]::WriteAllText($extensionManifestPath, $manifestRaw, [System.Text.Encoding]::UTF8)
    Write-Host "  Updated manifest.json with new public key." -ForegroundColor Green
} else {
    Write-Host "  Using existing key from manifest.json." -ForegroundColor Gray
    $der = [Convert]::FromBase64String($pubBase64)
}

# Derive 32-character Chrome extension ID from DER public key
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = $sha.ComputeHash($der)
$chars = @()
for ($i = 0; $i -lt 16; $i++) {
    $b = $hash[$i]
    $chars += [char]([int][char]'a' + ($b -shr 4))
    $chars += [char]([int][char]'a' + ($b -band 0x0F))
}
$extensionId = -join $chars

Write-Host "  Paired Extension ID: $extensionId" -ForegroundColor Cyan

# Write native messaging host JSON manifest
$nativeManifest = [ordered]@{
    name            = "com.gpu.telemetry"
    description     = "GPU Telemetry Native Messaging Host for Unified Toolkit"
    path            = $hostBatPath
    type            = "stdio"
    allowed_origins = @(
        "chrome-extension://$extensionId/"
    )
}

$nativeManifest | ConvertTo-Json -Depth 5 | Set-Content -Path $jsonManifestPath -Encoding utf8
Write-Host "  Written host manifest: $jsonManifestPath" -ForegroundColor Gray

Write-Host "[2/3] Registering Native Messaging Host in Windows Registry..." -ForegroundColor Yellow

$chromeRegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.gpu.telemetry"
$chromiumRegKey = "HKCU:\Software\Chromium\NativeMessagingHosts\com.gpu.telemetry"

try {
    if (-not (Test-Path $chromeRegKey)) { New-Item -Path $chromeRegKey -Force | Out-Null }
    Set-ItemProperty -Path $chromeRegKey -Name "(Default)" -Value $jsonManifestPath
    Write-Host "  Registered for Google Chrome." -ForegroundColor Green
} catch {
    Write-Warning "  Failed to register Chrome key: $_"
}

try {
    if (-not (Test-Path $chromiumRegKey)) { New-Item -Path $chromiumRegKey -Force | Out-Null }
    Set-ItemProperty -Path $chromiumRegKey -Name "(Default)" -Value $jsonManifestPath
    Write-Host "  Registered for Chromium." -ForegroundColor Green
} catch {
    Write-Warning "  Failed to register Chromium key: $_"
}

Write-Host ""
Write-Host "[3/3] Installation Complete!" -ForegroundColor Green
Write-Host "The Native Messaging Host is active and registered." -ForegroundColor Green
Write-Host ""
