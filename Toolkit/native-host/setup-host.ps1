# Setup script for CToolkit GPU Telemetry Native Messaging Host
param(
    [switch]$NewKey = $false,
    [switch]$RebuildCSharp = $false
)

$ErrorActionPreference = 'Stop'

Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host " CToolkit Native Messaging Host Setup" -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

$hostBatPath = Join-Path $scriptDir "host.bat"
$hostCsPath  = Join-Path $scriptDir "host.cs"
$hostExePath = Join-Path $scriptDir "host.exe"
$jsonManifestPath = Join-Path $scriptDir "com.gpu.telemetry.json"
$extensionManifestPath = (Resolve-Path (Join-Path $scriptDir "..\manifest.json")).Path

if (-not (Test-Path $hostExePath) -and -not (Test-Path $hostCsPath) -and -not (Test-Path $hostBatPath)) {
    Write-Error "Neither host.exe, host.cs, nor host.bat found in: $scriptDir"
    exit 1
}

$preserveNativeBinary = $false
if ((Test-Path $hostExePath) -and -not $RebuildCSharp) {
    try {
        [void][System.Reflection.AssemblyName]::GetAssemblyName($hostExePath)
    } catch [System.BadImageFormatException] {
        $preserveNativeBinary = $true
    } catch {}
}

if ($preserveNativeBinary) {
    Write-Host "[0/3] Preserving existing native C++ telemetry host: $hostExePath" -ForegroundColor Green
} elseif (Test-Path $hostCsPath) {
    $runtimeDir = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
    $cscPath = Join-Path $runtimeDir "csc.exe"
    if (-not (Test-Path $cscPath)) {
        $cscPath = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    }
    if (-not (Test-Path $cscPath)) {
        Write-Error "Built-in .NET C# compiler (csc.exe) not found at: $cscPath"
        exit 1
    }
    Write-Host "[0/3] Compiling Native C# Telemetry Host (x64)..." -ForegroundColor Yellow
    $compileOut = & $cscPath /nologo /optimize+ /platform:x64 /target:exe /r:System.dll /r:System.Core.dll /r:System.Management.dll /out:"$hostExePath" "$hostCsPath" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error ("Compilation of host.cs failed:`n" + ($compileOut -join "`n"))
        exit 1
    }
    Write-Host "  Built native host executable: $hostExePath" -ForegroundColor Green
}

$nativeHostPath = if (Test-Path $hostExePath) { $hostExePath } else { $hostBatPath }

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
    path            = $nativeHostPath
    type            = "stdio"
    allowed_origins = @(
        "chrome-extension://$extensionId/"
    )
}

[System.IO.File]::WriteAllText($jsonManifestPath, ($nativeManifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
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
