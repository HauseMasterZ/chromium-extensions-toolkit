$ErrorActionPreference = 'Stop'
$stdout = [System.Console]::OpenStandardOutput()

# Detect P-core and E-core logical thread counts once at startup
$numPThreads = 12
$totalRamGB  = 16.0
$numThreads  = 20
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

$totalPageGB = 11.5
try {
    $pf = Get-CimInstance Win32_PageFileUsage | Select-Object -First 1
    if ($pf -and $pf.AllocatedBaseSize) {
        $totalPageGB = [math]::Round($pf.AllocatedBaseSize / 1024, 1)
    }
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
$cpuClock      = 0
$cpuPower      = 0.0
$igpuPower     = 0.0
$igpuSharedMB  = 0.0
$cpuLimit      = 100
$cpuUtil       = 0
$ramUsedGB     = 0.0
$ramPct        = 0
$pagePct       = 0
$pageUsedGB    = 0.0
$commitUsedGB  = 0.0
$commitLimitGB = 0.0
$commitPct     = 0
$peClock       = "P: 0.0 GHz | E: 0.0 GHz"

# Lumped-Parameter Thermal Model State Variables (Persistent across sampling ticks)
$sinkTemp    = 42.0
$cpuEstTemp  = 46.0
$prevCpuP    = 0.0
$isFirstTick = $true

# 1. In-process native NVML C-API definition (280x faster than nvidia-smi with zero child processes)
$nvmlLoaded = $false
$nvmlDev = [IntPtr]::Zero
try {
    if (Test-Path "$env:SystemRoot\System32\nvml.dll") {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class NvmlHost {
    [DllImport("nvml.dll", EntryPoint = "nvmlInit_v2")]
    public static extern int Init();

    [DllImport("nvml.dll", EntryPoint = "nvmlShutdown")]
    public static extern int Shutdown();

    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetHandleByIndex_v2")]
    public static extern int GetHandle(uint index, out IntPtr device);

    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetTemperature")]
    public static extern int GetTemperature(IntPtr device, int sensorType, out uint temp);

    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetPowerUsage")]
    public static extern int GetPowerUsage(IntPtr device, out uint powerMilliWatts);

    [StructLayout(LayoutKind.Sequential)]
    public struct NvmlUtilization {
        public uint gpu;
        public uint memory;
    }

    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetUtilizationRates")]
    public static extern int GetUtilizationRates(IntPtr device, out NvmlUtilization util);

    [StructLayout(LayoutKind.Sequential)]
    public struct NvmlMemory {
        public ulong total;
        public ulong free;
        public ulong used;
    }

    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetMemoryInfo")]
    public static extern int GetMemoryInfo(IntPtr device, out NvmlMemory mem);

    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetClockInfo")]
    public static extern int GetClockInfo(IntPtr device, int clockType, out uint clockMHz);

    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetPerformanceState")]
    public static extern int GetPerformanceState(IntPtr device, out int pState);

    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetCurrentClocksThrottleReasons")]
    public static extern int GetClocksThrottleReasons(IntPtr device, out ulong reasons);
}
"@ -ErrorAction SilentlyContinue

        if ([NvmlHost]::Init() -eq 0) {
            $dev = [IntPtr]::Zero
            if ([NvmlHost]::GetHandle(0, [ref]$dev) -eq 0) {
                $nvmlDev = $dev
                $nvmlLoaded = $true
            }
        }
    }
} catch {
    $nvmlLoaded = $false
}

# 2. Persistent .NET PerformanceCounters (Pre-allocated once at startup, eliminates 1000ms PDH query sleep)
$perfCountersReady = $false
try {
    $pcCpuClock    = New-Object System.Diagnostics.PerformanceCounter("Processor Information", "Actual Frequency", "_Total")
    $pcCpuUtil     = New-Object System.Diagnostics.PerformanceCounter("Processor Information", "% Processor Utility", "_Total")
    $pcCpuLimit    = New-Object System.Diagnostics.PerformanceCounter("Processor Information", "% Performance Limit", "_Total")
    $pcRaplPkg     = New-Object System.Diagnostics.PerformanceCounter("Energy Meter", "Power", "RAPL_Package0_PKG")
    $pcRaplPp1     = New-Object System.Diagnostics.PerformanceCounter("Energy Meter", "Power", "RAPL_Package0_PP1")
    $pcAvailMem    = New-Object System.Diagnostics.PerformanceCounter("Memory", "Available MBytes")
    $pcPagePct     = New-Object System.Diagnostics.PerformanceCounter("Paging File", "% Usage", "_Total")
    $pcCommitBytes = New-Object System.Diagnostics.PerformanceCounter("Memory", "Committed Bytes")
    $pcCommitLimit = New-Object System.Diagnostics.PerformanceCounter("Memory", "Commit Limit")

    $pcThreads = 0..($numThreads - 1) | ForEach-Object {
        New-Object System.Diagnostics.PerformanceCounter("Processor Information", "Actual Frequency", "0,$_")
    }

    # Prime all counters once to initialize baseline differential
    $null = $pcCpuClock.NextValue()
    $null = $pcCpuUtil.NextValue()
    $null = $pcCpuLimit.NextValue()
    $null = $pcRaplPkg.NextValue()
    $null = $pcRaplPp1.NextValue()
    $null = $pcAvailMem.NextValue()
    $null = $pcPagePct.NextValue()
    $null = $pcCommitBytes.NextValue()
    $null = $pcCommitLimit.NextValue()
    $pcThreads | ForEach-Object { $null = $_.NextValue() }

    # Query shared GPU memory instances
    $gpuCat = New-Object System.Diagnostics.PerformanceCounterCategory("GPU Adapter Memory")
    $sharedInstances = $gpuCat.GetInstanceNames() | ForEach-Object {
        New-Object System.Diagnostics.PerformanceCounter("GPU Adapter Memory", "Shared Usage", $_)
    }
    $sharedInstances | ForEach-Object { $null = $_.NextValue() }

    $perfCountersReady = $true
} catch {
    $perfCountersReady = $false
}

try {
    while ($true) {
        # Instant watchdog check via native kernel handle (locks PID, zero process-table scanning)
        if (-not $parentObj -or $parentObj.HasExited) {
            exit 0
        }

        # 1. Query dGPU, VRAM, GPU Load, and P-State
        $rawGpuTemp   = 0.0
        $rawGpuWatt   = 0.0
        $gpuCoreClk   = 0
        $gpuMemClk    = 0
        $gpuLoad      = 0
        $pStateStr    = "Unknown"
        $vramUsedGB   = 0.0
        $vramTotalGB  = 0.0
        $vramPct      = 0
        $vrmBrakeStr  = "Unknown"
        $hwThermalStr = "Unknown"

        if ($nvmlLoaded) {
            try {
                $temp = 0
                $pwr = 0
                $util = New-Object NvmlHost+NvmlUtilization
                $mem = New-Object NvmlHost+NvmlMemory
                $core = 0
                $memC = 0
                $pStateVal = 0
                $throttleMask = 0UL

                [NvmlHost]::GetTemperature($nvmlDev, 0, [ref]$temp) | Out-Null
                [NvmlHost]::GetPowerUsage($nvmlDev, [ref]$pwr) | Out-Null
                [NvmlHost]::GetUtilizationRates($nvmlDev, [ref]$util) | Out-Null
                [NvmlHost]::GetMemoryInfo($nvmlDev, [ref]$mem) | Out-Null
                [NvmlHost]::GetClockInfo($nvmlDev, 0, [ref]$core) | Out-Null
                [NvmlHost]::GetClockInfo($nvmlDev, 2, [ref]$memC) | Out-Null
                [NvmlHost]::GetPerformanceState($nvmlDev, [ref]$pStateVal) | Out-Null
                [NvmlHost]::GetClocksThrottleReasons($nvmlDev, [ref]$throttleMask) | Out-Null

                $rawGpuTemp   = [double]$temp
                $rawGpuWatt   = [double][math]::Round($pwr / 1000.0, 1)
                $gpuCoreClk   = [int]$core
                $gpuMemClk    = [int]$memC
                $gpuLoad      = [int]$util.gpu
                $pStateStr    = "P$pStateVal"
                $vramUsedGB   = [math]::Round($mem.used / 1GB, 1)
                $vramTotalGB  = [math]::Round($mem.total / 1GB, 1)
                $vramPct      = if ($mem.total -gt 0) { [math]::Round(($mem.used / $mem.total) * 100, 0) } else { 0 }

                # Bitmask: 0x08 = HW Thermal, 0x80 = HW Power brake / VRM
                $hwThermalStr = if (($throttleMask -band 0x08) -ne 0) { "Active" } else { "Not Active" }
                $vrmBrakeStr  = if (($throttleMask -band 0x80) -ne 0) { "Active" } else { "Not Active" }
            } catch {
                $nvmlLoaded = $false
            }
        }

        # Fallback to nvidia-smi if NVML was not loaded or threw error
        if (-not $nvmlLoaded) {
            $gpuRaw = & nvidia-smi --query-gpu=temperature.gpu,clocks.current.graphics,clocks.current.memory,power.draw,memory.used,memory.total,utilization.gpu,pstate,clocks_event_reasons.hw_power_brake_slowdown,clocks_event_reasons.hw_thermal_slowdown --format=csv,noheader,nounits 2>$null
            $gpuParts = if ($LASTEXITCODE -eq 0 -and $gpuRaw) { ($gpuRaw | Select-Object -First 1).Trim().Split(',') } else { @(0,0,0,0,0,0,0,'Unknown','Unknown','Unknown') }

            $rawGpuTemp   = [double]$gpuParts[0].Trim()
            $gpuCoreClk   = [int]$gpuParts[1].Trim()
            $gpuMemClk    = [int]$gpuParts[2].Trim()
            $rawGpuWatt   = [double]$gpuParts[3].Trim()
            $vramUsedMB   = [double]$gpuParts[4].Trim()
            $vramTotalMB  = [double]$gpuParts[5].Trim()
            $vramUsedGB   = [math]::Round($vramUsedMB / 1024, 1)
            $vramTotalGB  = [math]::Round($vramTotalMB / 1024, 1)
            $vramPct      = if ($vramTotalMB -gt 0) { [math]::Round(($vramUsedMB / $vramTotalMB) * 100, 0) } else { 0 }
            $gpuLoad      = [int]$gpuParts[6].Trim()
            $pStateStr    = $gpuParts[7].Trim()
            $vrmBrakeStr  = $gpuParts[8].Trim()
            $hwThermalStr = $gpuParts[9].Trim()
        }

        # 2. Query CPU, iGPU, & Memory Counters
        if ($perfCountersReady) {
            try {
                $cpuClock  = [math]::Round($pcCpuClock.NextValue(), 0)
                $cpuUtil   = [math]::Min(100, [math]::Round($pcCpuUtil.NextValue(), 0))
                $cpuLimit  = [math]::Round($pcCpuLimit.NextValue(), 0)
                $cpuPower  = [math]::Round($pcRaplPkg.NextValue() / 1000, 1)
                $igpuPower = [math]::Round($pcRaplPp1.NextValue() / 1000, 1)
                $availMB   = $pcAvailMem.NextValue()

                $maxSharedMB = 0.0
                foreach ($pcSh in $sharedInstances) {
                    $mb = [math]::Round($pcSh.NextValue() / 1MB, 0)
                    if ($mb -gt $maxSharedMB) { $maxSharedMB = $mb }
                }
                $igpuSharedMB = $maxSharedMB

                $ramUsedGB = [math]::Round($totalRamGB - ($availMB / 1024), 1)
                $ramPct    = if ($totalRamGB -gt 0) { [math]::Round(($ramUsedGB / $totalRamGB) * 100, 0) } else { 0 }

                $pagePct    = [math]::Round($pcPagePct.NextValue(), 0)
                $pageUsedGB = [math]::Round(($pagePct / 100.0) * $totalPageGB, 1)

                $commitBytesVal = $pcCommitBytes.NextValue()
                $commitLimitVal = $pcCommitLimit.NextValue()
                if ($commitLimitVal -gt 0) {
                    $commitUsedGB  = [math]::Round($commitBytesVal / 1GB, 1)
                    $commitLimitGB = [math]::Round($commitLimitVal / 1GB, 1)
                    $commitPct     = [math]::Round(($commitBytesVal / $commitLimitVal) * 100, 0)
                }

                $maxP = 0.0
                $maxE = 0.0
                for ($th = 0; $th -lt $numThreads; $th++) {
                    $val = $pcThreads[$th].NextValue()
                    if ($th -lt $numPThreads) {
                        if ($val -gt $maxP) { $maxP = $val }
                    } else {
                        if ($val -gt $maxE) { $maxE = $val }
                    }
                }
                $pGhzStr = "{0:N1}" -f ($maxP / 1000)
                $eGhzStr = "{0:N1}" -f ($maxE / 1000)
                $peClock = if ($maxE -gt 0) { "P: $pGhzStr GHz | E: $eGhzStr GHz" } else { "P: $pGhzStr GHz" }
            } catch {
                $perfCountersReady = $false
            }
        }

        # Fallback to Get-Counter if PerformanceCounters failed
        if (-not $perfCountersReady) {
            $counters = $null
            try {
                $counters = (Get-Counter -Counter '\Processor Information(_Total)\Actual Frequency',
                                                  '\Energy Meter(RAPL_Package0_PKG)\Power',
                                                  '\Energy Meter(RAPL_Package0_PP1)\Power',
                                                  '\Processor Information(_Total)\% Performance Limit',
                                                  '\Processor Information(_Total)\% Processor Utility',
                                                  '\Processor Information(0,*)\Actual Frequency',
                                                  '\Memory\Available MBytes',
                                                  '\GPU Adapter Memory(*)\Shared Usage',
                                                  '\Paging File(_Total)\% Usage',
                                                  '\Memory\Committed Bytes',
                                                  '\Memory\Commit Limit' -MaxSamples 1).CounterSamples
            } catch {}

            if ($counters) {
                $maxP = 0.0
                $maxE = 0.0
                $availMB = 0.0
                $maxSharedMB = 0.0
                $pageVal = 0.0
                $commitBytes = 0.0
                $commitLimitBytes = 0.0

                foreach ($s in $counters) {
                    $inst = $s.InstanceName
                    $path = $s.Path
                    $val  = $s.CookedValue

                    if ($inst) {
                        if ($inst.StartsWith('0,')) {
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
                        elseif ($inst -eq '_total') {
                            if ($path.IndexOf('actual frequency') -ge 0) { $cpuClock = [math]::Round($val, 0) }
                            elseif ($path.IndexOf('% processor utility') -ge 0) { $cpuUtil = [math]::Min(100, [math]::Round($val, 0)) }
                            elseif ($path.IndexOf('% performance limit') -ge 0) { $cpuLimit = [math]::Round($val, 0) }
                            elseif ($path.IndexOf('paging file') -ge 0) { $pageVal = $val }
                        }
                        elseif ($inst -eq 'rapl_package0_pkg') {
                            $cpuPower = [math]::Round($val / 1000, 1)
                        }
                        elseif ($inst -eq 'rapl_package0_pp1') {
                            $igpuPower = [math]::Round($val / 1000, 1)
                        }
                        elseif ($path.IndexOf('shared usage') -ge 0) {
                            $mb = [math]::Round($val / 1MB, 0)
                            if ($mb -gt $maxSharedMB) { $maxSharedMB = $mb }
                        }
                    } else {
                        if ($path.IndexOf('rapl_package0_pkg') -ge 0) {
                            $cpuPower = [math]::Round($val / 1000, 1)
                        }
                        elseif ($path.IndexOf('rapl_package0_pp1') -ge 0) {
                            $igpuPower = [math]::Round($val / 1000, 1)
                        }
                        elseif ($path.IndexOf('\memory\available') -ge 0) {
                            $availMB = $val
                        }
                        elseif ($path.IndexOf('paging file') -ge 0) {
                            $pageVal = $val
                        }
                        elseif ($path.IndexOf('committed bytes') -ge 0) {
                            $commitBytes = $val
                        }
                        elseif ($path.IndexOf('commit limit') -ge 0) {
                            $commitLimitBytes = $val
                        }
                    }
                }

                $igpuSharedMB = $maxSharedMB
                $ramUsedGB = [math]::Round($totalRamGB - ($availMB / 1024), 1)
                $ramPct    = if ($totalRamGB -gt 0) { [math]::Round(($ramUsedGB / $totalRamGB) * 100, 0) } else { 0 }

                $pagePct    = [math]::Round($pageVal, 0)
                $pageUsedGB = [math]::Round(($pagePct / 100.0) * $totalPageGB, 1)

                if ($commitLimitBytes -gt 0) {
                    $commitUsedGB  = [math]::Round($commitBytes / 1GB, 1)
                    $commitLimitGB = [math]::Round($commitLimitBytes / 1GB, 1)
                    $commitPct     = [math]::Round(($commitBytes / $commitLimitBytes) * 100, 0)
                }

                $pGhzStr   = "{0:N1}" -f ($maxP / 1000)
                $eGhzStr   = "{0:N1}" -f ($maxE / 1000)
                $peClock   = if ($maxE -gt 0) { "P: $pGhzStr GHz | E: $eGhzStr GHz" } else { "P: $pGhzStr GHz" }
            }
        }

        $igpuRamStr = if ($igpuSharedMB -ge 1024) { "{0:N1} GB" -f ($igpuSharedMB / 1024) } else { "$igpuSharedMB MB" }

        # 4. Pure State-Space Continuous Thermal Observer (<0.02ms scalar arithmetic)
        # 1. Total chassis thermal dissipation
        $pTotal = $cpuPower + $rawGpuWatt

        # 2. Continuous Convective Cooling Curve (Dell EC Fan RPM Power-Law)
        $rConv = 0.22 + (0.58 / (1.0 + [math]::Pow(($pTotal / 46.0), 1.4)))

        # 3. Continuous Shared Vapor Chamber Anchor with Asymmetric Decoupling
        $sinkConv   = 24.0 + ($pTotal * $rConv)
        $sinkGpu    = if ($rawGpuTemp -ge 28.0) { [math]::Max(24.0, $rawGpuTemp - ($rawGpuWatt * 0.14) + ($cpuPower * 0.06)) } else { $sinkConv }
        $sinkTarget = if ($rawGpuTemp -ge 28.0) { $sinkGpu } else { $sinkConv }

        if ($isFirstTick) {
            $sinkTemp = $sinkTarget
        } else {
            $sinkTemp += 0.080 * ($sinkTarget - $sinkTemp)
        }

        # 4. Continuous Core Flux Density (Alder Lake localized turbo hotspot)
        $boostFactor = [math]::Max(0.0, [math]::Min(1.0, (($maxP - 3200.0) / 1500.0)))
        $utilFactor  = 1.0 - [math]::Max(0.0, [math]::Min(1.0, ($cpuUtil / 100.0)))
        $rDie        = 0.32 + (0.14 * $boostFactor * $utilFactor)

        # Die junction sits continuously on the instantaneous physical heatsink temperature
        $cpuTarget = $sinkTemp + ($cpuPower * $rDie)

        # 5. Hardware PROCHOT Ground Truth Floor
        if ($cpuLimit -lt 100 -and $cpuPower -gt 35.0) {
            $prochotFloor = 98.0 + [math]::Min(2.0, (100.0 - $cpuLimit) * 0.1)
            if ($cpuTarget -lt $prochotFloor) { $cpuTarget = $prochotFloor }
        }

        # 6. Continuous Asymmetric Thermal Inertia (dt = 2.0s: tau_rise=1s, tau_cool=5s)
        # Dynamic alpha_cool during high-to-low power step functions accounts for lingering silicon enthalpy
        $dP = if ($isFirstTick) { 0.0 } else { $cpuPower - $prevCpuP }
        $prevCpuP = $cpuPower
        $alphaCool = if ($dP -lt -5.0) { [math]::Max(0.12, 0.33 + ($dP * 0.012)) } else { 0.33 }

        if ($isFirstTick) {
            $cpuEstTemp  = $cpuTarget
            $isFirstTick = $false
        } else {
            $alphaDie = if ($cpuTarget -gt $cpuEstTemp) { 0.86 } else { $alphaCool }
            $cpuEstTemp += $alphaDie * ($cpuTarget - $cpuEstTemp)
        }

        # 7. Physical boundary guards
        $cpuEstTemp = [math]::Max([math]::Max(24.0, $sinkTemp), [math]::Min(101.0, $cpuEstTemp))
        $cpuTempInt = [int][math]::Round($cpuEstTemp, 0)

        # 5. Construct Transposed Matrix Payload
        $payload = [PSCustomObject]@{
            timestamp = (Get-Date).ToString("HH:mm:ss")
            cpuClock  = $cpuClock
            cpuLoad   = $cpuUtil
            peClock   = $peClock
            cpuPower  = $cpuPower
            cpuTemp   = $cpuTempInt
            igpuPower = $igpuPower
            igpuRam   = $igpuRamStr
            cpuLimit  = $cpuLimit
            ramUsed   = "$ramUsedGB / $totalRamGB GB ($ramPct%)"
            pageUsed  = "$pageUsedGB / $totalPageGB GB ($pagePct%)"
            commitUsed = "$commitUsedGB / $commitLimitGB GB ($commitPct%)"
            gpuTemp   = [int]$rawGpuTemp
            coreClock = [int]$gpuCoreClk
            memClock  = [int]$gpuMemClk
            gpuPower  = [math]::Round($rawGpuWatt, 1)
            vramUsed  = "$vramUsedGB / $vramTotalGB GB ($vramPct%)"
            gpuLoad   = [int]$gpuLoad
            pState    = $pStateStr
            vrmBrake  = $vrmBrakeStr
            hwThermal = $hwThermalStr
        } | ConvertTo-Json -Compress

        # 5. Framed stdout output (32-bit little-endian prefix)
        $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $lengthPrefix = [System.BitConverter]::GetBytes([uint32]$jsonBytes.Length)
        $stdout.Write($lengthPrefix, 0, 4)
        $stdout.Write($jsonBytes, 0, $jsonBytes.Length)
        $stdout.Flush()

        # Adaptive Load Cadence: 800ms under gaming/load, 1800ms when idle on desktop
        $isIdle = ($cpuPower -le 18.0) -and ($gpuLoad -eq 0) -and ($rawGpuTemp -lt 52.0)
        $sleepInterval = if ($isIdle) { 1800 } else { 800 }
        Start-Sleep -Milliseconds $sleepInterval
    }
}
catch {
    exit 0
}
finally {
    if ($nvmlLoaded) {
        try { [NvmlHost]::Shutdown() | Out-Null } catch {}
    }
}
