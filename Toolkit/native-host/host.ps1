$ErrorActionPreference = 'Stop'
$stdout = [System.Console]::OpenStandardOutput()

# Detect P-core and E-core logical thread counts once at startup
$numPThreads = 12
$totalRamGB = 16.0
try {
    $cpuInfo = Get-CimInstance Win32_Processor | Select-Object -First 1
    $numCores = $cpuInfo.NumberOfCores
    $numThreads = $cpuInfo.NumberOfLogicalProcessors
    $numPCores = $numThreads - $numCores
    if ($numPCores -gt 0 -and $numPCores -lt $numCores) {
        $numPThreads = $numPCores * 2
    } else {
        $numPThreads = $numThreads
    }
} catch {}

try {
    $totalRamGB = [math]::Round(((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB), 1)
} catch {}

# Open persistent kernel handle to parent process for zero-overhead watchdog
$parentObj = $null
try {
    $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId
    if ($parentPid) {
        $parentObj = [System.Diagnostics.Process]::GetProcessById($parentPid)
    }
} catch {}

# Fallback state values
$cpuClock = 0
$cpuPower = 0.0
$cpuLimit = 100
$cpuUtil  = 0
$ramUsedGB = 0.0
$ramPct   = 0
$peClock  = "P: 0.0 GHz | E: 0.0 GHz"

try {
    while ($true) {
        # Instant watchdog check via native kernel handle (locks PID, zero process-table scanning)
        if (-not $parentObj -or $parentObj.HasExited) {
            exit 0
        }

        # 1. Query GPU, VRAM, GPU Load, and P-State
        $gpuRaw = & nvidia-smi --query-gpu=temperature.gpu,clocks.current.graphics,clocks.current.memory,power.draw,memory.used,memory.total,utilization.gpu,pstate,clocks_event_reasons.hw_power_brake_slowdown,clocks_event_reasons.hw_thermal_slowdown --format=csv,noheader,nounits 2>$null
        $gpuParts = if ($LASTEXITCODE -eq 0 -and $gpuRaw) { ($gpuRaw | Select-Object -First 1).Trim().Split(',') } else { @(0,0,0,0,0,0,0,'Unknown','Unknown','Unknown') }

        $vramUsedMB  = [double]$gpuParts[4].Trim()
        $vramTotalMB = [double]$gpuParts[5].Trim()
        $vramUsedGB  = [math]::Round($vramUsedMB / 1024, 1)
        $vramTotalGB = [math]::Round($vramTotalMB / 1024, 1)
        $vramPct     = if ($vramTotalMB -gt 0) { [math]::Round(($vramUsedMB / $vramTotalMB) * 100, 0) } else { 0 }

        # 2. Query CPU & Memory Counters in a single batch
        $counters = $null
        try {
            $counters = (Get-Counter -Counter '\Processor Information(_Total)\Actual Frequency',
                                              '\Energy Meter(RAPL_Package0_PKG)\Power',
                                              '\Processor Information(_Total)\% Performance Limit',
                                              '\Processor Information(_Total)\% Processor Utility',
                                              '\Processor Information(0,*)\Actual Frequency',
                                              '\Memory\Available MBytes' -MaxSamples 1).CounterSamples
        } catch {}

        if ($counters) {
            $maxP = 0.0
            $maxE = 0.0
            $availMB = 0.0

            # 3. High-speed single-pass counter extraction
            foreach ($s in $counters) {
                $inst = $s.InstanceName
                $path = $s.Path
                $val  = $s.CookedValue

                if ($inst -eq '_total') {
                    if ($path.IndexOf('actual frequency') -ge 0) { $cpuClock = [math]::Round($val, 0) }
                    elseif ($path.IndexOf('% processor utility') -ge 0) { $cpuUtil = [math]::Min(100, [math]::Round($val, 0)) }
                    elseif ($path.IndexOf('% performance limit') -ge 0) { $cpuLimit = [math]::Round($val, 0) }
                }
                elseif ($path.IndexOf('rapl_package0_pkg') -ge 0) {
                    $cpuPower = [math]::Round($val / 1000, 1)
                }
                elseif ($path.IndexOf('\memory\available') -ge 0) {
                    $availMB = $val
                }
                elseif ($inst.StartsWith('0,')) {
                    $sub = $inst.Substring(2)
                    if ($sub -ne '_total') {
                        $thId = [int]$sub
                        if ($thId -lt $numPThreads) {
                            if ($val -gt $maxP) { $maxP = $val }
                        } else {
                            if ($val -gt $maxE) { $maxE = $val }
                        }
                    }
                }
            }

            $ramUsedGB = [math]::Round($totalRamGB - ($availMB / 1024), 1)
            $ramPct    = if ($totalRamGB -gt 0) { [math]::Round(($ramUsedGB / $totalRamGB) * 100, 0) } else { 0 }
            $pGhzStr   = "{0:N1}" -f ($maxP / 1000)
            $eGhzStr   = "{0:N1}" -f ($maxE / 1000)
            $peClock   = if ($maxE -gt 0) { "P: $pGhzStr GHz | E: $eGhzStr GHz" } else { "P: $pGhzStr GHz" }
        }

        # 4. Construct Transposed Matrix Payload
        $payload = [PSCustomObject]@{
            timestamp = (Get-Date).ToString("HH:mm:ss")
            cpuClock  = $cpuClock
            cpuLoad   = $cpuUtil
            peClock   = $peClock
            cpuPower  = $cpuPower
            cpuLimit  = $cpuLimit
            ramUsed   = "$ramUsedGB / $totalRamGB GB ($ramPct%)"
            gpuTemp   = [int]$gpuParts[0].Trim()
            coreClock = [int]$gpuParts[1].Trim()
            memClock  = [int]$gpuParts[2].Trim()
            gpuPower  = [math]::Round([double]$gpuParts[3].Trim(), 1)
            vramUsed  = "$vramUsedGB / $vramTotalGB GB ($vramPct%)"
            gpuLoad   = [int]$gpuParts[6].Trim()
            pState    = $gpuParts[7].Trim()
            vrmBrake  = $gpuParts[8].Trim()
            hwThermal = $gpuParts[9].Trim()
        } | ConvertTo-Json -Compress

        # 5. Framed stdout output (32-bit little-endian prefix)
        $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $lengthPrefix = [System.BitConverter]::GetBytes([uint32]$jsonBytes.Length)
        $stdout.Write($lengthPrefix, 0, 4)
        $stdout.Write($jsonBytes, 0, $jsonBytes.Length)
        $stdout.Flush()

        Start-Sleep -Milliseconds 800
    }
}
catch {
    exit 0
}
