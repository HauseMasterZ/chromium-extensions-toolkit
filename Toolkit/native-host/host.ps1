$ErrorActionPreference = 'Stop'
$stdout = [System.Console]::OpenStandardOutput()

# Fast hardware baseline detection without slow WMI queries (0ms overhead)
$numThreads = [System.Environment]::ProcessorCount
$numPThreads = if ($numThreads -gt 16) { [int]($numThreads * 0.6) } elseif ($numThreads -gt 8) { [int]($numThreads * 0.75) } else { $numThreads }
$totalRamGB  = 16.0
$totalPageGB = 16.0

# Open persistent kernel handle to parent process for watchdog
$parentObj = $null
try {
    $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction SilentlyContinue).ParentProcessId
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

# Lumped-Parameter Thermal Model State Variables
$sinkTemp    = 42.0
$cpuEstTemp  = 46.0
$prevCpuP    = 0.0
$isFirstTick = $true

# 1. Consolidated In-Process Native C-API (NVML + Universal Panel-Agnostic DDC/CI)
$nvmlLoaded = $false
$nvmlDev = [IntPtr]::Zero

try {
    if (-not ([System.Management.Automation.PSTypeName]'MonitorController').Type) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Threading;
using System.Text;
using System.Collections.Generic;

public class NvmlHost {
    [DllImport("nvml.dll", EntryPoint = "nvmlInit_v2")] public static extern int Init();
    [DllImport("nvml.dll", EntryPoint = "nvmlShutdown")] public static extern int Shutdown();
    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetHandleByIndex_v2")] public static extern int GetHandle(uint index, out IntPtr device);
    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetTemperature")] public static extern int GetTemperature(IntPtr device, int sensorType, out uint temp);
    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetPowerUsage")] public static extern int GetPowerUsage(IntPtr device, out uint powerMilliWatts);

    [StructLayout(LayoutKind.Sequential)]
    public struct NvmlUtilization { public uint gpu; public uint memory; }
    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetUtilizationRates")] public static extern int GetUtilizationRates(IntPtr device, out NvmlUtilization util);

    [StructLayout(LayoutKind.Sequential)]
    public struct NvmlMemory { public ulong total; public ulong free; public ulong used; }
    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetMemoryInfo")] public static extern int GetMemoryInfo(IntPtr device, out NvmlMemory mem);

    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetClockInfo")] public static extern int GetClockInfo(IntPtr device, int clockType, out uint clockMHz);
    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetPerformanceState")] public static extern int GetPerformanceState(IntPtr device, out int pState);
    [DllImport("nvml.dll", EntryPoint = "nvmlDeviceGetCurrentClocksThrottleReasons")] public static extern int GetClocksThrottleReasons(IntPtr device, out ulong reasons);
}

public class MonitorController {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PHYSICAL_MONITOR {
        public IntPtr hPhysicalMonitor;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szPhysicalMonitorDescription;
    }

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, IntPtr lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);
    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);
    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint size, [In, Out] PHYSICAL_MONITOR[] arr);
    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool DestroyPhysicalMonitors(uint size, [In] PHYSICAL_MONITOR[] arr);

    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetMonitorBrightness(IntPtr hMonitor, out uint min, out uint cur, out uint max);
    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool SetMonitorBrightness(IntPtr hMonitor, uint val);

    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetMonitorContrast(IntPtr hMonitor, out uint min, out uint cur, out uint max);
    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool SetMonitorContrast(IntPtr hMonitor, uint val);

    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetMonitorRedGreenOrBlueGain(IntPtr hMonitor, int gainType, out uint min, out uint cur, out uint max);
    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool SetMonitorRedGreenOrBlueGain(IntPtr hMonitor, int gainType, uint val);

    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr hMonitor, byte code, out uint pvct, out uint cur, out uint max);
    [DllImport("dxva2.dll", SetLastError = true)] public static extern bool SetVCPFeature(IntPtr hMonitor, byte code, uint val);

    [DllImport("gdi32.dll")] public static extern IntPtr CreateDC(string lpszDriver, string lpszDevice, string lpszOutput, IntPtr lpInitData);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)] public static extern bool SetDeviceGammaRamp(IntPtr hdc, [In] ushort[] lpRamp);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)] public static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public class MEMORYSTATUSEX {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
        public MEMORYSTATUSEX() { this.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX)); }
    }

    public static void GetSystemMemoryBaseline(out double totalRamGB, out double totalPageGB) {
        totalRamGB = 16.0;
        totalPageGB = 16.0;
        try {
            MEMORYSTATUSEX stat = new MEMORYSTATUSEX();
            if (GlobalMemoryStatusEx(stat)) {
                if (stat.ullTotalPhys > 0) {
                    totalRamGB = Math.Round((double)stat.ullTotalPhys / (1024.0 * 1024.0 * 1024.0), 1);
                }
                if (stat.ullTotalPageFile > stat.ullTotalPhys) {
                    totalPageGB = Math.Round((double)(stat.ullTotalPageFile - stat.ullTotalPhys) / (1024.0 * 1024.0 * 1024.0), 1);
                }
            }
        } catch {}
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct MONITORINFOEX {
        public int cbSize;
        public int rcMonitor_left, rcMonitor_top, rcMonitor_right, rcMonitor_bottom;
        public int rcWork_left, rcWork_top, rcWork_right, rcWork_bottom;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct DISPLAY_DEVICE {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceKey;
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);

    public static string GetMonitorPnpId(IntPtr hMonitor, out string gdiDevice) {
        gdiDevice = null;
        try {
            MONITORINFOEX mi = new MONITORINFOEX();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(hMonitor, ref mi)) {
                gdiDevice = mi.szDevice;
                DISPLAY_DEVICE dd = new DISPLAY_DEVICE();
                dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
                if (EnumDisplayDevices(mi.szDevice, 0, ref dd, 0)) {
                    string[] parts = dd.DeviceID.Split('\\');
                    if (parts.Length > 1) return parts[1];
                }
            }
        } catch {}
        return null;
    }

    public static bool ApplySoftwareBrightness(string gdiDevice, int brightness0to100) {
        if (string.IsNullOrEmpty(gdiDevice)) return false;
        try {
            IntPtr hdc = CreateDC(null, gdiDevice, null, IntPtr.Zero);
            if (hdc == IntPtr.Zero) return false;
            double factor = Math.Max(0.02, Math.Min(1.0, brightness0to100 / 100.0));
            ushort[] ramp = new ushort[3 * 256];
            for (int i = 0; i < 256; i++) {
                ushort val = (ushort)Math.Round(Math.Min(65535.0, (i * 256.0) * factor));
                ramp[i] = val;
                ramp[i + 256] = val;
                ramp[i + 512] = val;
            }
            bool res = SetDeviceGammaRamp(hdc, ramp);
            DeleteDC(hdc);
            return res;
        } catch {
            return false;
        }
    }

    public class DisplayDeviceItem {
        public string id;
        public string pnpId;
        public string gdiDevice;
        public string name;
        public int brightness;
        public int contrast;
        public int gainR;
        public int gainG;
        public int gainB;
        public int volume;
        public int inputSource;
        public int colorPreset;
        public int powerMode;
        public int gamma;
        public int blackBoost;
        public int darkBoost;
        public int blackLevel;
        public int overdrive;
        public int strobing;
        public int mprt;
        public int freeSync;
        public int superSharpness;
        public int blueLight;
    }

    public static volatile bool IsRunning = true;
    public static volatile bool HasProbed = false;
    public static List<DisplayDeviceItem> CurrentMonitors = new List<DisplayDeviceItem>();
    public static object SyncLock = new object();

    public static void ProbeAllMonitors(Dictionary<string, string> friendlyNames) {
        var list = new List<DisplayDeviceItem>();
        int ddcIndex = 0;
        try {
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (hMonitor, hdc, lprc, data) => {
                uint count = 0;
                if (GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count) && count > 0) {
                    var physicalMonitors = new PHYSICAL_MONITOR[count];
                    if (GetPhysicalMonitorsFromHMONITOR(hMonitor, count, physicalMonitors)) {
                        for (int i = 0; i < count; i++) {
                            IntPtr hPhys = physicalMonitors[i].hPhysicalMonitor;
                            uint bMin, bCur, bMax;
                            if (GetMonitorBrightness(hPhys, out bMin, out bCur, out bMax)) {
                                var item = new DisplayDeviceItem();
                                item.id = "mon_" + ddcIndex;
                                item.brightness = (int)bCur;

                                string gdiDev = null;
                                string pnpId = GetMonitorPnpId(hMonitor, out gdiDev);
                                string modelName = null;
                                if (!string.IsNullOrEmpty(pnpId) && friendlyNames != null && friendlyNames.ContainsKey(pnpId)) {
                                    modelName = friendlyNames[pnpId];
                                }
                                if (string.IsNullOrEmpty(modelName)) {
                                    modelName = "Monitor " + (ddcIndex + 1);
                                }
                                item.pnpId = pnpId ?? "";
                                item.gdiDevice = gdiDev ?? "";
                                item.name = modelName;

                                uint cMin, cCur, cMax;
                                item.contrast = GetMonitorContrast(hPhys, out cMin, out cCur, out cMax) ? (int)cCur : 50;

                                uint rMin, rCur, rMax, gMin, gCur, gMax, blMin, blCur, blMax;
                                item.gainR = GetMonitorRedGreenOrBlueGain(hPhys, 0, out rMin, out rCur, out rMax) ? (int)rCur : 50;
                                item.gainG = GetMonitorRedGreenOrBlueGain(hPhys, 1, out gMin, out gCur, out gMax) ? (int)gCur : 50;
                                item.gainB = GetMonitorRedGreenOrBlueGain(hPhys, 2, out blMin, out blCur, out blMax) ? (int)blCur : 50;

                                uint pvct, vCur, vMax;
                                item.volume = GetVCPFeatureAndVCPFeatureReply(hPhys, 0x62, out pvct, out vCur, out vMax) ? (int)vCur : -1;
                                item.inputSource = GetVCPFeatureAndVCPFeatureReply(hPhys, 0x60, out pvct, out vCur, out vMax) ? (int)vCur : 15;
                                item.colorPreset = GetVCPFeatureAndVCPFeatureReply(hPhys, 0x14, out pvct, out vCur, out vMax) ? (int)vCur : 11;
                                item.powerMode = GetVCPFeatureAndVCPFeatureReply(hPhys, 0xD6, out pvct, out vCur, out vMax) ? (int)vCur : 1;

                                item.blackBoost = GetVCPFeatureAndVCPFeatureReply(hPhys, 0x6C, out pvct, out vCur, out vMax) ? (int)vCur : 50;
                                item.blackLevel = item.blackBoost;

                                bool isAcer = (!string.IsNullOrEmpty(item.pnpId) && item.pnpId.StartsWith("ACR", StringComparison.OrdinalIgnoreCase)) ||
                                              (!string.IsNullOrEmpty(item.name) && item.name.IndexOf("Acer", StringComparison.OrdinalIgnoreCase) >= 0);

                                if (isAcer) {
                                    item.gamma = -1;
                                    item.darkBoost = 0;
                                    item.mprt = 0;
                                    item.overdrive = GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE8, out pvct, out vCur, out vMax) ? (int)vCur : 0;
                                    item.strobing = GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE5, out pvct, out vCur, out vMax) ? (int)vCur : 0;
                                    item.freeSync = GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE0, out pvct, out vCur, out vMax) ? ((vCur == 255 || vCur > 0) ? 1 : 0) : 0;
                                    item.superSharpness = GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE4, out pvct, out vCur, out vMax) ? (vCur > 0 ? 1 : 0) : 0;
                                    item.blueLight = GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE7, out pvct, out vCur, out vMax) ? (vCur == 255 ? 0 : (int)vCur) : 0;
                                } else {
                                    item.gamma = GetVCPFeatureAndVCPFeatureReply(hPhys, 0x72, out pvct, out vCur, out vMax) ? (int)vCur : -1;
                                    item.darkBoost = GetVCPFeatureAndVCPFeatureReply(hPhys, 0xF6, out pvct, out vCur, out vMax) ? (int)vCur : 0;
                                    item.overdrive = GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE0, out pvct, out vCur, out vMax) ? (int)vCur : 0;
                                    item.mprt = GetVCPFeatureAndVCPFeatureReply(hPhys, 0xEF, out pvct, out vCur, out vMax) ? (int)vCur : 0;
                                    item.strobing = item.mprt;
                                    item.freeSync = GetVCPFeatureAndVCPFeatureReply(hPhys, 0xEA, out pvct, out vCur, out vMax) ? (int)vCur : 0;
                                    item.superSharpness = 0;
                                    item.blueLight = 0;
                                }

                                list.Add(item);
                                ddcIndex++;
                            }
                        }
                        DestroyPhysicalMonitors(count, physicalMonitors);
                    }
                }
                return true;
            }, IntPtr.Zero);

            lock (SyncLock) {
                CurrentMonitors = list;
                HasProbed = true;
            }
        } catch {}
    }

    public static bool ApplyControl(string monitorId, string control, int val) {
        bool updated = false;
        try {
            int targetIndex = -1;
            DisplayDeviceItem targetMon = null;
            lock (SyncLock) {
                for (int i = 0; i < CurrentMonitors.Count; i++) {
                    if (CurrentMonitors[i].id == monitorId) {
                        targetIndex = i;
                        targetMon = CurrentMonitors[i];
                        break;
                    }
                }
            }
            if (targetIndex < 0 || targetMon == null) return false;

            bool isAcer = (!string.IsNullOrEmpty(targetMon.pnpId) && targetMon.pnpId.StartsWith("ACR", StringComparison.OrdinalIgnoreCase)) ||
                          (!string.IsNullOrEmpty(targetMon.name) && targetMon.name.IndexOf("Acer", StringComparison.OrdinalIgnoreCase) >= 0);

            int currentDdcIdx = 0;
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (hMonitor, hdc, lprc, data) => {
                uint count = 0;
                if (GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count) && count > 0) {
                    var physicalMonitors = new PHYSICAL_MONITOR[count];
                    if (GetPhysicalMonitorsFromHMONITOR(hMonitor, count, physicalMonitors)) {
                        for (int i = 0; i < count; i++) {
                            IntPtr hPhys = physicalMonitors[i].hPhysicalMonitor;
                            uint bMin, bCur, bMax;
                            if (GetMonitorBrightness(hPhys, out bMin, out bCur, out bMax)) {
                                if (currentDdcIdx == targetIndex) {
                                    int clamped0to100 = Math.Max(0, Math.Min(100, val));
                                    switch (control.ToLowerInvariant()) {
                                        case "brightness":
                                            bool hwOk = SetMonitorBrightness(hPhys, (uint)clamped0to100) || SetVCPFeature(hPhys, 0x10, (uint)clamped0to100);
                                            uint checkMin, checkCur, checkMax;
                                            bool readBackOk = GetMonitorBrightness(hPhys, out checkMin, out checkCur, out checkMax);
                                            if (!readBackOk || checkCur != (uint)clamped0to100) {
                                                // Hardware backlight is locked by monitor firmware (e.g. DCR enabled in OSD)
                                                // Fallback to seamless GDI gamma LUT dimming
                                                ApplySoftwareBrightness(targetMon.gdiDevice, clamped0to100);
                                            } else {
                                                // Hardware backlight succeeded directly, keep gamma ramp clean and linear at 100%
                                                ApplySoftwareBrightness(targetMon.gdiDevice, 100);
                                            }
                                            lock (SyncLock) { CurrentMonitors[targetIndex].brightness = clamped0to100; }
                                            updated = true;
                                            break;
                                        case "contrast":
                                            if (SetMonitorContrast(hPhys, (uint)clamped0to100) || SetVCPFeature(hPhys, 0x12, (uint)clamped0to100)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].contrast = clamped0to100; }
                                                updated = true;
                                            }
                                            break;
                                        case "gain_r":
                                        case "gainr":
                                            if (SetMonitorRedGreenOrBlueGain(hPhys, 0, (uint)clamped0to100)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].gainR = clamped0to100; }
                                                updated = true;
                                            }
                                            break;
                                        case "gain_g":
                                        case "gaing":
                                            if (SetMonitorRedGreenOrBlueGain(hPhys, 1, (uint)clamped0to100)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].gainG = clamped0to100; }
                                                updated = true;
                                            }
                                            break;
                                        case "gain_b":
                                        case "gainb":
                                            if (SetMonitorRedGreenOrBlueGain(hPhys, 2, (uint)clamped0to100)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].gainB = clamped0to100; }
                                                updated = true;
                                            }
                                            break;
                                        case "volume":
                                            if (SetVCPFeature(hPhys, 0x62, (uint)clamped0to100)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].volume = clamped0to100; }
                                                updated = true;
                                            }
                                            break;
                                        case "input":
                                        case "inputsource":
                                            if (SetVCPFeature(hPhys, 0x60, (uint)val)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].inputSource = val; }
                                                updated = true;
                                            }
                                            break;
                                        case "preset":
                                        case "colorpreset":
                                            if (SetVCPFeature(hPhys, 0x14, (uint)val)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].colorPreset = val; }
                                                updated = true;
                                            }
                                            break;
                                        case "power":
                                        case "powermode":
                                            if (SetVCPFeature(hPhys, 0xD6, (uint)val)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].powerMode = val; }
                                                updated = true;
                                            }
                                            break;
                                        case "gamma":
                                            if (SetVCPFeature(hPhys, 0x72, (uint)val)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].gamma = val; }
                                                updated = true;
                                            }
                                            break;
                                        case "blackboost":
                                        case "blacklevel":
                                            if (SetVCPFeature(hPhys, 0x6C, (uint)clamped0to100)) {
                                                lock (SyncLock) {
                                                    CurrentMonitors[targetIndex].blackBoost = clamped0to100;
                                                    CurrentMonitors[targetIndex].blackLevel = clamped0to100;
                                                }
                                                updated = true;
                                            }
                                            break;
                                        case "darkboost":
                                            if (SetVCPFeature(hPhys, 0xF6, (uint)val)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].darkBoost = val; }
                                                updated = true;
                                            }
                                            break;
                                        case "overdrive":
                                            byte odCode = isAcer ? (byte)0xE8 : (byte)0xE0;
                                            if (SetVCPFeature(hPhys, odCode, (uint)val)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].overdrive = val; }
                                                updated = true;
                                            }
                                            break;
                                        case "strobing":
                                        case "vrb":
                                            byte stCode = isAcer ? (byte)0xE5 : (byte)0xEF;
                                            if (SetVCPFeature(hPhys, stCode, (uint)val)) {
                                                lock (SyncLock) {
                                                    CurrentMonitors[targetIndex].strobing = val;
                                                    CurrentMonitors[targetIndex].mprt = val;
                                                }
                                                updated = true;
                                            }
                                            break;
                                        case "mprt":
                                            byte mprtCode = isAcer ? (byte)0xE5 : (byte)0xEF;
                                            if (SetVCPFeature(hPhys, mprtCode, (uint)val)) {
                                                lock (SyncLock) {
                                                    CurrentMonitors[targetIndex].mprt = val;
                                                    CurrentMonitors[targetIndex].strobing = val;
                                                }
                                                updated = true;
                                            }
                                            break;
                                        case "freesync":
                                            byte fsCode = isAcer ? (byte)0xE0 : (byte)0xEA;
                                            if (SetVCPFeature(hPhys, fsCode, (uint)val)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].freeSync = val; }
                                                updated = true;
                                            }
                                            break;
                                        case "supersharpness":
                                            uint ssVal = (val > 0) ? 3u : 0u;
                                            if (SetVCPFeature(hPhys, 0xE4, ssVal)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].superSharpness = (val > 0 ? 1 : 0); }
                                                updated = true;
                                            }
                                            break;
                                        case "bluelight":
                                            uint blVal = (val == 0) ? 0u : (uint)val;
                                            if (SetVCPFeature(hPhys, 0xE7, blVal)) {
                                                lock (SyncLock) { CurrentMonitors[targetIndex].blueLight = val; }
                                                updated = true;
                                            }
                                            break;
                                    }
                                    DestroyPhysicalMonitors(count, physicalMonitors);
                                    return false;
                                }
                                currentDdcIdx++;
                            }
                        }
                        DestroyPhysicalMonitors(count, physicalMonitors);
                    }
                }
                return true;
            }, IntPtr.Zero);
        } catch {}
        return updated;
    }

    public static void StartWorker(Dictionary<string, string> friendlyNames) {
        Thread thread = new Thread(() => {
            ProbeAllMonitors(friendlyNames);

            try {
                Stream stdin = Console.OpenStandardInput();
                byte[] lenBuf = new byte[4];
                while (IsRunning) {
                    int read = 0;
                    while (read < 4) {
                        int r = stdin.Read(lenBuf, read, 4 - read);
                        if (r <= 0) {
                            Environment.Exit(0);
                            return;
                        }
                        read += r;
                    }
                    int len = BitConverter.ToInt32(lenBuf, 0);
                    if (len <= 0 || len > 1024 * 1024) continue;

                    byte[] jsonBuf = new byte[len];
                    read = 0;
                    while (read < len) {
                        int r = stdin.Read(jsonBuf, read, len - read);
                        if (r <= 0) {
                            Environment.Exit(0);
                            return;
                        }
                        read += r;
                    }
                    string json = Encoding.UTF8.GetString(jsonBuf);

                    if (json.Contains("\"set_panel_control\"")) {
                        string monId = ExtractJsonString(json, "monitorId");
                        string control = ExtractJsonString(json, "control");
                        int val = ExtractJsonInt(json, "value", 0);
                        if (!string.IsNullOrEmpty(monId) && !string.IsNullOrEmpty(control)) {
                            ApplyControl(monId, control, val);
                        }
                    } else if (json.Contains("\"set_brightness\"")) {
                        int val = ExtractJsonInt(json, "value", 50);
                        ApplyControl("mon_0", "brightness", val);
                    }
                }
            } catch {}
        });
        thread.IsBackground = true;
        thread.Name = "MonitorBackgroundWorker";
        thread.Start();
    }

    private static string ExtractJsonString(string json, string key) {
        string search = "\"" + key + "\"";
        int idx = json.IndexOf(search);
        if (idx < 0) return null;
        int colon = json.IndexOf(':', idx + search.Length);
        if (colon < 0) return null;
        int quoteStart = json.IndexOf('"', colon + 1);
        if (quoteStart < 0) return null;
        int quoteEnd = json.IndexOf('"', quoteStart + 1);
        if (quoteEnd < 0) return null;
        return json.Substring(quoteStart + 1, quoteEnd - quoteStart - 1);
    }

    private static int ExtractJsonInt(string json, string key, int defaultVal) {
        string search = "\"" + key + "\"";
        int idx = json.IndexOf(search);
        if (idx < 0) return defaultVal;
        int colon = json.IndexOf(':', idx + search.Length);
        if (colon < 0) return defaultVal;
        int start = colon + 1;
        while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;
        int end = start;
        while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-')) end++;
        if (end > start) {
            int v;
            if (int.TryParse(json.Substring(start, end - start), out v)) return v;
        }
        return defaultVal;
    }
}
"@ -ErrorAction SilentlyContinue
    }

    if (Test-Path "$env:SystemRoot\System32\nvml.dll") {
        if ([NvmlHost]::Init() -eq 0) {
            $dev = [IntPtr]::Zero
            if ([NvmlHost]::GetHandle(0, [ref]$dev) -eq 0) {
                $nvmlDev = $dev
                $nvmlLoaded = $true
            }
        }
    }

    $friendlyNames = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    try {
        Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
            $mName = ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join ""
            if (-not $mName) {
                $mName = ($_.ProductCodeID | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join ""
            }
            $inst = $_.InstanceName.Split("\")[1]
            if ($mName -and $inst) {
                $pnpVendor = if ($inst.Length -ge 3) { $inst.Substring(0, 3) } else { "" }
                $vendorName = switch ($pnpVendor) {
                    "ACR" { "Acer" }
                    "LEN" { "Lenovo" }
                    "SAM" { "Samsung" }
                    "DEL" { "Dell" }
                    "AOC" { "AOC" }
                    "ASU" { "Asus" }
                    "BNQ" { "BenQ" }
                    "GSM" { "LG" }
                    "MSI" { "MSI" }
                    default { $pnpVendor }
                }
                $fullDisplay = if ($vendorName -and -not $mName.StartsWith($vendorName)) { "$vendorName $mName" } else { $mName }
                if (-not $friendlyNames.ContainsKey($inst)) {
                    $friendlyNames.Add($inst, $fullDisplay)
                }
            }
        }
    } catch {}

    [MonitorController]::StartWorker($friendlyNames)
    $ramOut = 16.0
    $pageOut = 16.0
    [MonitorController]::GetSystemMemoryBaseline([ref]$ramOut, [ref]$pageOut)
    if ($ramOut -gt 0) { $totalRamGB = $ramOut }
    if ($pageOut -gt 0) { $totalPageGB = $pageOut }
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
        if ($parentObj -and $parentObj.HasExited) {
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
            hasProbed = [MonitorController]::HasProbed
            monitors  = if ([MonitorController]::HasProbed) { [MonitorController]::CurrentMonitors } else { $null }
            monitorBrightness = if ([MonitorController]::CurrentMonitors.Count -gt 0) { [MonitorController]::CurrentMonitors[0].brightness } else { -1 }
        } | ConvertTo-Json -Compress -Depth 3

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
    [MonitorController]::IsRunning = $false
    if ($nvmlLoaded) {
        try { [NvmlHost]::Shutdown() | Out-Null } catch {}
    }
}
