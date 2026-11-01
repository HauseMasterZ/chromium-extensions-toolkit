$ErrorActionPreference = 'Stop'
$stdout = [System.Console]::OpenStandardOutput()


# Fast hardware baseline detection without slow WMI queries (0ms overhead)
$numThreads = [System.Environment]::ProcessorCount
$numPThreads = if ($numThreads -gt 16) { [int]($numThreads * 0.6) } elseif ($numThreads -gt 8) { [int]($numThreads * 0.75) } else { $numThreads }
$totalRamGB  = 16.0
$totalPageGB = 16.0

# Asynchronous background initialization of PerformanceCounters for RAPL and Paging
$perfRs = $null
$perfPs = $null
$perfAsync = $null
try {
    $perfRs = [runspacefactory]::CreateRunspace()
    $perfRs.Open()
    $perfPs = [powershell]::Create()
    $perfPs.Runspace = $perfRs
    [void]$perfPs.AddScript({
        try {
            $map = @{
                RaplPkg = New-Object System.Diagnostics.PerformanceCounter("Energy Meter", "Power", "RAPL_Package0_PKG")
                RaplPp1 = New-Object System.Diagnostics.PerformanceCounter("Energy Meter", "Power", "RAPL_Package0_PP1")
                PagePct = New-Object System.Diagnostics.PerformanceCounter("Paging File", "% Usage", "_Total")
            }
            try { $null = $map.RaplPkg.NextValue() } catch {}
            try { $null = $map.RaplPp1.NextValue() } catch {}
            try { $null = $map.PagePct.NextValue() } catch {}

            try {
                $gpuCat = New-Object System.Diagnostics.PerformanceCounterCategory("GPU Adapter Memory")
                $shared = $gpuCat.GetInstanceNames() | ForEach-Object {
                    New-Object System.Diagnostics.PerformanceCounter("GPU Adapter Memory", "Shared Usage", $_)
                }
                $shared | ForEach-Object { $null = $_.NextValue() }
                $map["Shared"] = $shared
            } catch {}

            return $map
        } catch {
            return $null
        }
    })
    $perfAsync = $perfPs.BeginInvoke()
} catch {}

# Kernel handle to parent process for watchdog (populated after native initialization)
$parentObj = $null
$parentPid = 0

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
        $csharpDef = @"
using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Threading;
using System.Text;
using System.Collections.Generic;
using Microsoft.Win32;

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

    public static volatile bool IsReady = false;
    public static IntPtr DeviceHandle = IntPtr.Zero;

    public static void StartInitAsync() {
        Thread t = new Thread(() => {
            try {
                if (Init() == 0) {
                    IntPtr dev = IntPtr.Zero;
                    if (GetHandle(0, out dev) == 0) {
                        DeviceHandle = dev;
                        IsReady = true;
                    }
                }
            } catch {}
        });
        t.IsBackground = true;
        t.Name = "NvmlAsyncInit";
        t.Start();
    }
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

    [DllImport("gdi32.dll", CharSet = CharSet.Auto)] public static extern IntPtr CreateDC(string lpszDriver, string lpszDevice, string lpszOutput, IntPtr lpInitData);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)] public static extern bool SetDeviceGammaRamp(IntPtr hdc, [In] ushort[] lpRamp);
    [DllImport("gdi32.dll", SetLastError = true)] public static extern bool GetDeviceGammaRamp(IntPtr hdc, [Out] ushort[] lpRamp);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DeviceIoControl(IntPtr hDevice, uint dwIoControlCode, IntPtr lpInBuffer, uint nInBufferSize, IntPtr lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAY_BRIGHTNESS {
        public byte ucDisplayPolicy;
        public byte ucACBrightness;
        public byte ucDCBrightness;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct MONITORINFOEX {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left, top, right, bottom; }

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

    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORYSTATUSEX {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GlobalMemoryStatusEx([In, Out] ref MEMORYSTATUSEX lpBuffer);

    public static void GetSystemMemoryBaseline(out double totalRamGB, out double totalPageGB) {
        totalRamGB = 16.0;
        totalPageGB = 16.0;
        try {
            MEMORYSTATUSEX memStatus = new MEMORYSTATUSEX();
            memStatus.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
            if (GlobalMemoryStatusEx(ref memStatus)) {
                totalRamGB = Math.Round((double)memStatus.ullTotalPhys / (1024.0 * 1024.0 * 1024.0), 1);
                totalPageGB = Math.Round((double)memStatus.ullTotalPageFile / (1024.0 * 1024.0 * 1024.0), 1);
            }
        } catch {}
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESSOR_POWER_INFORMATION {
        public uint Number;
        public uint MaxMhz;
        public uint CurrentMhz;
        public uint MhzLimit;
        public uint MaxIdleState;
        public uint CurrentIdleState;
    }

    [DllImport("powrprof.dll")]
    public static extern int CallNtPowerInformation(int InformationLevel, IntPtr lpInputBuffer, uint nInputBufferSize, [Out] PROCESSOR_POWER_INFORMATION[] lpOutputBuffer, uint nOutputBufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetSystemTimes(out long idleTime, out long kernelTime, out long userTime);

    private static long _prevIdle = 0;
    private static long _prevKernel = 0;
    private static long _prevUser = 0;

    public static int GetInstantCpuLoad() {
        long idle, kernel, user;
        if (!GetSystemTimes(out idle, out kernel, out user)) return 0;
        if (_prevIdle == 0) {
            _prevIdle = idle;
            _prevKernel = kernel;
            _prevUser = user;
            return 0;
        }
        long diffIdle = idle - _prevIdle;
        long diffKernel = kernel - _prevKernel;
        long diffUser = user - _prevUser;
        _prevIdle = idle;
        _prevKernel = kernel;
        _prevUser = user;
        long total = diffKernel + diffUser;
        if (total <= 0) return 0;
        long busy = total - diffIdle;
        if (busy < 0) busy = 0;
        return (int)Math.Min(100, Math.Round((double)busy * 100.0 / total));
    }

    public static PROCESSOR_POWER_INFORMATION[] GetProcessorPowerInfo() {
        try {
            int count = Environment.ProcessorCount;
            var info = new PROCESSOR_POWER_INFORMATION[count];
            int sz = Marshal.SizeOf(typeof(PROCESSOR_POWER_INFORMATION));
            if (CallNtPowerInformation(11, IntPtr.Zero, 0, info, (uint)(sz * count)) == 0) return info;
        } catch {}
        return null;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public UIntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

    public static int GetParentProcessId() {
        try {
            PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
            int retLen;
            int status = NtQueryInformationProcess(System.Diagnostics.Process.GetCurrentProcess().Handle, 0, ref pbi, Marshal.SizeOf(pbi), out retLen);
            if (status == 0) {
                return pbi.InheritedFromUniqueProcessId.ToInt32();
            }
        } catch {}
        return 0;
    }

    public static string GetVendorName(string vendorCode) {
        if (string.IsNullOrEmpty(vendorCode)) return "";
        switch (vendorCode.ToUpperInvariant()) {
            case "ACR": return "Acer";
            case "LEN": return "Lenovo";
            case "SAM": return "Samsung";
            case "DEL": return "Dell";
            case "AOC": return "AOC";
            case "ASU": return "Asus";
            case "BNQ": return "BenQ";
            case "GSM": return "LG";
            case "MSI": return "MSI";
            default: return vendorCode;
        }
    }

    public static string GetMonitorFriendlyNameFromEdid(string pnpId) {
        if (string.IsNullOrEmpty(pnpId)) return null;
        try {
            using (var reg = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\DISPLAY\" + pnpId)) {
                if (reg != null) {
                    foreach (string sub in reg.GetSubKeyNames()) {
                        using (var paramKey = reg.OpenSubKey(sub + @"\Device Parameters")) {
                            if (paramKey != null) {
                                byte[] edid = paramKey.GetValue("EDID") as byte[];
                                if (edid != null && edid.Length >= 126) {
                                    for (int i = 54; i <= 108; i += 18) {
                                        if (edid[i] == 0 && edid[i + 1] == 0 && edid[i + 3] == 0xFC) {
                                            var sb = new StringBuilder();
                                            for (int b = i + 5; b < i + 18; b++) {
                                                if (edid[b] >= 32 && edid[b] <= 126) {
                                                    sb.Append((char)edid[b]);
                                                } else if (edid[b] == 10 || edid[b] == 0) {
                                                    break;
                                                }
                                            }
                                            string name = sb.ToString().Trim();
                                            if (!string.IsNullOrEmpty(name)) {
                                                string pnpVendor = pnpId.Length >= 3 ? pnpId.Substring(0, 3).ToUpperInvariant() : "";
                                                string vendor = GetVendorName(pnpVendor);
                                                if (!string.IsNullOrEmpty(vendor) && !name.StartsWith(vendor, StringComparison.OrdinalIgnoreCase)) {
                                                    return vendor + " " + name;
                                                }
                                                return name;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch {}
        return null;
    }

    public static string GetMonitorPnpId(IntPtr hMonitor, out string gdiDevice) {
        gdiDevice = null;
        try {
            MONITORINFOEX mi = new MONITORINFOEX();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(hMonitor, ref mi)) {
                gdiDevice = mi.szDevice;
                DISPLAY_DEVICE dd = new DISPLAY_DEVICE();
                dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
                if (EnumDisplayDevices(mi.szDevice, 0, ref dd, 0) && !string.IsNullOrEmpty(dd.DeviceID)) {
                    string[] parts = dd.DeviceID.Split('\\');
                    if (parts.Length > 1 && !string.IsNullOrEmpty(parts[1])) return parts[1];
                }
                if (EnumDisplayDevices(mi.szDevice, 0, ref dd, 1) && !string.IsNullOrEmpty(dd.DeviceID)) {
                    string[] hashParts = dd.DeviceID.Split('#');
                    if (hashParts.Length > 1 && !string.IsNullOrEmpty(hashParts[1])) return hashParts[1];
                }
            }
        } catch {}
        return null;
    }

    public static int QueryLcdBrightness(out byte cur) {
        cur = 50;
        IntPtr hLcd = CreateFile("\\\\.\\LCD", 0x80000000 | 0x40000000, 1 | 2, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (hLcd == (IntPtr)(-1) || hLcd == IntPtr.Zero) return Marshal.GetLastWin32Error();

        DISPLAY_BRIGHTNESS b = new DISPLAY_BRIGHTNESS();
        int size = Marshal.SizeOf(b);
        IntPtr pOut = Marshal.AllocHGlobal(size);
        uint returned = 0;
        bool ok = DeviceIoControl(hLcd, 0x00230498, IntPtr.Zero, 0, pOut, (uint)size, out returned, IntPtr.Zero);
        int err = 0;
        if (ok) {
            b = (DISPLAY_BRIGHTNESS)Marshal.PtrToStructure(pOut, typeof(DISPLAY_BRIGHTNESS));
            cur = b.ucACBrightness;
        } else {
            err = Marshal.GetLastWin32Error();
        }
        Marshal.FreeHGlobal(pOut);
        CloseHandle(hLcd);
        return ok ? 0 : err;
    }

    public static bool SetLcdBrightness(byte val) {
        IntPtr hLcd = CreateFile("\\\\.\\LCD", 0x80000000 | 0x40000000, 1 | 2, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (hLcd == (IntPtr)(-1) || hLcd == IntPtr.Zero) return false;

        DISPLAY_BRIGHTNESS b = new DISPLAY_BRIGHTNESS();
        b.ucDisplayPolicy = 3;
        b.ucACBrightness = val;
        b.ucDCBrightness = val;

        int size = Marshal.SizeOf(b);
        IntPtr pIn = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(b, pIn, false);
        uint returned = 0;
        bool ok = DeviceIoControl(hLcd, 0x0023049C, pIn, (uint)size, IntPtr.Zero, 0, out returned, IntPtr.Zero);
        Marshal.FreeHGlobal(pIn);
        CloseHandle(hLcd);
        return ok;
    }

    public static int internalContrast = 50;
    public static int internalGainR = 50;
    public static int internalGainG = 50;
    public static int internalGainB = 50;

    public static bool UpdateInternalGpuRamp(string gdiDevice) {
        if (string.IsNullOrEmpty(gdiDevice)) return false;
        try {
            IntPtr hdc = CreateDC(null, gdiDevice, null, IntPtr.Zero);
            if (hdc == IntPtr.Zero) return false;

            double cFactor = Math.Max(0.1, Math.Min(2.0, (internalContrast / 50.0)));
            double rFactor = Math.Max(0.1, Math.Min(1.0, (internalGainR / 50.0)));
            double gFactor = Math.Max(0.1, Math.Min(1.0, (internalGainG / 50.0)));
            double bFactor = Math.Max(0.1, Math.Min(1.0, (internalGainB / 50.0)));

            ushort[] ramp = new ushort[3 * 256];
            for (int i = 0; i < 256; i++) {
                double centered = (i - 128.0) * cFactor + 128.0;
                double clamped = Math.Max(0.0, Math.Min(255.0, centered));

                ramp[i]       = (ushort)Math.Max(0.0, Math.Min(65535.0, (clamped * 256.0) * rFactor));
                ramp[i + 256] = (ushort)Math.Max(0.0, Math.Min(65535.0, (clamped * 256.0) * gFactor));
                ramp[i + 512] = (ushort)Math.Max(0.0, Math.Min(65535.0, (clamped * 256.0) * bFactor));
            }
            bool res = SetDeviceGammaRamp(hdc, ramp);
            DeleteDC(hdc);
            return res;
        } catch { return false; }
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

    public static bool ResetSoftwareGamma(string gdiDevice) {
        if (string.IsNullOrEmpty(gdiDevice)) return false;
        try {
            IntPtr hdc = CreateDC(null, gdiDevice, null, IntPtr.Zero);
            if (hdc == IntPtr.Zero) return false;
            ushort[] ramp = new ushort[3 * 256];
            for (int i = 0; i < 256; i++) {
                ushort val = (ushort)(i * 256);
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
        public int windowsDisplayNumber;
        public bool isInternal;
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

    public class BoundPhysicalMonitor {
        public string id;
        public IntPtr hPhys;
        public uint count;
        public PHYSICAL_MONITOR[] monitors;
        public string gdiDevice;
        public string pnpId;
        public string name;
        public int windowsDisplayNumber;
        public bool isAcer;
        public bool isInternal;
        public bool isSoftwareBrightnessActive;
        public int initialBrightness;
    }

    public class TelemetryUpdateItem {
        public string id;
        public bool isInternal;
        public byte curLcd;
        public int brightVal = -1;
        public int contrastVal = -1;
        public int rGain = -1, gGain = -1, bGain = -1;
        public int preset = -1;
        public int vol = -1, input = -1, power = -1, blackB = -1;
        public int gamma = -1, darkB = -1, mprt = -1, strobing = -1, od = -1, fs = -1, ss = -1, bl = -1;
    }

    public static volatile bool IsRunning = true;
    public static volatile bool HasProbed = false;
    public static volatile bool IsProbing = false;
    public static volatile bool ProbePending = false;
    public static volatile bool ForceRebindPending = false;
    public static volatile int PendingProbeId = 0;
    public static volatile int CompletedProbeId = 0;
    public static readonly AutoResetEvent WakeSignal = new AutoResetEvent(false);
    public static List<DisplayDeviceItem> CurrentMonitors = new List<DisplayDeviceItem>();
    public static List<BoundPhysicalMonitor> BoundMonitors = new List<BoundPhysicalMonitor>();
    public static Dictionary<string, string> SavedFriendlyNames = new Dictionary<string, string>();
    public static string SavedInternalPnpId = null;
    public static object SyncLock = new object();

    public delegate bool WmiSetBrightnessDelegate(byte val);
    public static WmiSetBrightnessDelegate WmiSetBrightnessHandler = null;

    private static int ExtractGdiNumber(string dev) {
        if (string.IsNullOrEmpty(dev)) return 999;
        int idx = dev.IndexOf("DISPLAY", StringComparison.OrdinalIgnoreCase);
        if (idx >= 0) {
            int num;
            if (int.TryParse(dev.Substring(idx + 7), out num)) return num;
        }
        return 999;
    }

    public static void ReleaseBoundMonitors() {
        lock (SyncLock) {
            var destroyed = new HashSet<PHYSICAL_MONITOR[]>();
            foreach (var b in BoundMonitors) {
                try {
                    if (b.monitors != null && b.count > 0 && !destroyed.Contains(b.monitors)) {
                        destroyed.Add(b.monitors);
                        DestroyPhysicalMonitors(b.count, b.monitors);
                    }
                } catch {}
                b.monitors = null;
            }
            BoundMonitors.Clear();
        }
    }

    public static void BindPhysicalMonitors(Dictionary<string, string> friendlyNames) {
        if (friendlyNames != null) {
            SavedFriendlyNames = friendlyNames;
        }

        var activeGdiDevices = new List<string>();
        var monitorHandles = new List<IntPtr>();
        var monitorGdiDevs = new List<string>();
        var monitorPnpIds = new List<string>();

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (hMonitor, hdc, lprc, data) => {
            string gdiDev = null;
            string pnpId = GetMonitorPnpId(hMonitor, out gdiDev);
            monitorHandles.Add(hMonitor);
            monitorGdiDevs.Add(gdiDev);
            monitorPnpIds.Add(pnpId);
            if (!string.IsNullOrEmpty(gdiDev) && !activeGdiDevices.Contains(gdiDev)) {
                activeGdiDevices.Add(gdiDev);
            }
            return true;
        }, IntPtr.Zero);

        activeGdiDevices.Sort((a, b) => {
            int numA = ExtractGdiNumber(a);
            int numB = ExtractGdiNumber(b);
            return numA.CompareTo(numB);
        });

        var boundList = new List<BoundPhysicalMonitor>();
        int ddcIndex = 0;
        try {
            ReleaseBoundMonitors();

            for (int mIdx = 0; mIdx < monitorHandles.Count; mIdx++) {
                IntPtr hMonitor = monitorHandles[mIdx];
                string gdiDev = monitorGdiDevs[mIdx];
                string pnpId = monitorPnpIds[mIdx];

                int winNum = (!string.IsNullOrEmpty(gdiDev) && activeGdiDevices.Contains(gdiDev))
                    ? (activeGdiDevices.IndexOf(gdiDev) + 1)
                    : (ddcIndex + 1);

                uint count = 0;
                if (GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count) && count > 0) {
                    var physicalMonitors = new PHYSICAL_MONITOR[count];
                    if (GetPhysicalMonitorsFromHMONITOR(hMonitor, count, physicalMonitors)) {
                        for (int i = 0; i < count; i++) {
                            IntPtr hPhys = physicalMonitors[i].hPhysicalMonitor;

                            uint bMin = 0, bCur = 50, bMax = 100;
                            bool hasDdcBrightness = GetMonitorBrightness(hPhys, out bMin, out bCur, out bMax);
                            if (!hasDdcBrightness) {
                                uint pvct, vCur, vMax;
                                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x10, out pvct, out vCur, out vMax)) {
                                    hasDdcBrightness = true;
                                    bCur = vCur;
                                }
                            }

                            string modelName = null;
                            if (!string.IsNullOrEmpty(pnpId)) {
                                if (friendlyNames != null && friendlyNames.ContainsKey(pnpId)) {
                                    modelName = friendlyNames[pnpId];
                                }
                                if (string.IsNullOrEmpty(modelName)) {
                                    modelName = GetMonitorFriendlyNameFromEdid(pnpId);
                                }
                            }

                            if (hasDdcBrightness) {
                                if (string.IsNullOrEmpty(modelName)) {
                                    modelName = "Monitor " + winNum;
                                }

                                bool isAcer = (!string.IsNullOrEmpty(pnpId) && pnpId.StartsWith("ACR", StringComparison.OrdinalIgnoreCase)) ||
                                              (!string.IsNullOrEmpty(modelName) && modelName.IndexOf("Acer", StringComparison.OrdinalIgnoreCase) >= 0);

                                string canonicalId = !string.IsNullOrEmpty(pnpId) ? pnpId : (!string.IsNullOrEmpty(gdiDev) ? gdiDev : ("mon_" + ddcIndex));

                                var bound = new BoundPhysicalMonitor();
                                bound.id = canonicalId;
                                bound.hPhys = hPhys;
                                bound.count = count;
                                bound.monitors = physicalMonitors;
                                bound.gdiDevice = gdiDev ?? "";
                                bound.pnpId = pnpId ?? "";
                                bound.name = modelName;
                                bound.windowsDisplayNumber = winNum;
                                bound.isAcer = isAcer;
                                bound.isInternal = false;
                                bound.isSoftwareBrightnessActive = false;
                                bound.initialBrightness = (int)bCur;
                                boundList.Add(bound);
                                ddcIndex++;
                            } else {
                                byte curLcd;
                                bool isLcdAvailable = (QueryLcdBrightness(out curLcd) == 0);
                                bool isInternalMatch = (!string.IsNullOrEmpty(SavedInternalPnpId) && string.Equals(SavedInternalPnpId, pnpId, StringComparison.OrdinalIgnoreCase)) ||
                                                       (!string.IsNullOrEmpty(gdiDev) && gdiDev.IndexOf("DISPLAY1", StringComparison.OrdinalIgnoreCase) >= 0);

                                if (isLcdAvailable && isInternalMatch) {
                                    if (string.IsNullOrEmpty(SavedInternalPnpId) && !string.IsNullOrEmpty(pnpId)) {
                                        SavedInternalPnpId = pnpId;
                                    }
                                    if (string.IsNullOrEmpty(modelName)) {
                                        modelName = "Internal Display";
                                    }

                                    string canonicalId = !string.IsNullOrEmpty(pnpId) ? pnpId : (!string.IsNullOrEmpty(gdiDev) ? gdiDev : "internal");

                                    var bound = new BoundPhysicalMonitor();
                                    bound.id = canonicalId;
                                    bound.hPhys = hPhys;
                                    bound.count = count;
                                    bound.monitors = physicalMonitors;
                                    bound.gdiDevice = gdiDev ?? "";
                                    bound.pnpId = pnpId ?? "";
                                    bound.name = modelName;
                                    bound.windowsDisplayNumber = winNum;
                                    bound.isAcer = false;
                                    bound.isInternal = true;
                                    bound.isSoftwareBrightnessActive = false;
                                    bound.initialBrightness = (int)curLcd;
                                    boundList.Add(bound);
                                    ddcIndex++;
                                } else {
                                    try { DestroyPhysicalMonitors(count, physicalMonitors); } catch {}
                                }
                            }
                        }
                    }
                }
            }

            bool hasInternalBound = false;
            for (int i = 0; i < boundList.Count; i++) {
                if (boundList[i].isInternal) { hasInternalBound = true; break; }
            }
            if (!hasInternalBound) {
                byte curLcd;
                if (QueryLcdBrightness(out curLcd) == 0) {
                    string intPnp = SavedInternalPnpId ?? "Internal_Panel";
                    string intModel = (friendlyNames != null && !string.IsNullOrEmpty(SavedInternalPnpId) && friendlyNames.ContainsKey(SavedInternalPnpId))
                        ? friendlyNames[SavedInternalPnpId] : "Internal Display";
                    string intGdi = (activeGdiDevices.Count > 0 && activeGdiDevices[0].IndexOf("DISPLAY1", StringComparison.OrdinalIgnoreCase) >= 0)
                        ? activeGdiDevices[0] : "\\\\.\\DISPLAY1";
                    int winNum = activeGdiDevices.Contains(intGdi) ? (activeGdiDevices.IndexOf(intGdi) + 1) : 1;

                    var bound = new BoundPhysicalMonitor();
                    bound.id = intPnp;
                    bound.hPhys = IntPtr.Zero;
                    bound.count = 0;
                    bound.monitors = null;
                    bound.gdiDevice = intGdi;
                    bound.pnpId = intPnp;
                    bound.name = intModel;
                    bound.windowsDisplayNumber = winNum;
                    bound.isAcer = false;
                    bound.isInternal = true;
                    bound.isSoftwareBrightnessActive = false;
                    bound.initialBrightness = (int)curLcd;
                    boundList.Add(bound);
                }
            }

            boundList.Sort((a, b) => a.windowsDisplayNumber.CompareTo(b.windowsDisplayNumber));

            var initialDevList = new List<DisplayDeviceItem>();
            for (int i = 0; i < boundList.Count; i++) {
                var b = boundList[i];
                var item = new DisplayDeviceItem();
                item.id = b.id;
                item.pnpId = b.pnpId;
                item.gdiDevice = b.gdiDevice;
                item.name = b.name;
                item.windowsDisplayNumber = b.windowsDisplayNumber;
                item.isInternal = b.isInternal;
                item.brightness = b.initialBrightness;
                item.contrast = b.isInternal ? internalContrast : 50;
                item.gainR = b.isInternal ? internalGainR : 50;
                item.gainG = b.isInternal ? internalGainG : 50;
                item.gainB = b.isInternal ? internalGainB : 50;
                item.volume = -1;
                item.inputSource = 15;
                item.colorPreset = 11;
                item.powerMode = 1;
                item.gamma = -1;
                item.blackBoost = 50;
                item.darkBoost = 0;
                item.blackLevel = 50;
                item.overdrive = 0;
                item.strobing = 0;
                item.mprt = 0;
                item.freeSync = 0;
                item.superSharpness = 0;
                item.blueLight = 0;
                initialDevList.Add(item);
            }

            lock (SyncLock) {
                BoundMonitors = boundList;
                var mergedList = new List<DisplayDeviceItem>();
                for (int i = 0; i < initialDevList.Count; i++) {
                    var initItem = initialDevList[i];
                    DisplayDeviceItem existing = null;
                    for (int j = 0; j < CurrentMonitors.Count; j++) {
                        if (CurrentMonitors[j].id == initItem.id) {
                            existing = CurrentMonitors[j];
                            break;
                        }
                    }
                    if (existing != null) {
                        existing.windowsDisplayNumber = initItem.windowsDisplayNumber;
                        existing.gdiDevice = initItem.gdiDevice;
                        existing.name = initItem.name;
                        existing.isInternal = initItem.isInternal;
                        existing.brightness = initItem.brightness;
                        mergedList.Add(existing);
                    } else {
                        mergedList.Add(initItem);
                    }
                }
                CurrentMonitors = mergedList;
                if (boundList.Count == 0) {
                    HasProbed = true;
                }
            }
        } catch {}
    }

    public static void ReProbePhysicalMonitors() {
        try {
            BindPhysicalMonitors(SavedFriendlyNames);
        } catch {}
    }

    public static BoundPhysicalMonitor FindBoundMonitor(string monitorId, string pnpId = null, string gdiDevice = null, bool? isAcer = null) {
        lock (SyncLock) {
            string targetPnp = !string.IsNullOrEmpty(pnpId) ? pnpId : monitorId;
            if (!string.IsNullOrEmpty(targetPnp)) {
                for (int i = 0; i < BoundMonitors.Count; i++) {
                    if (string.Equals(BoundMonitors[i].id, targetPnp, StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(BoundMonitors[i].pnpId, targetPnp, StringComparison.OrdinalIgnoreCase)) {
                        return BoundMonitors[i];
                    }
                }
            }

            string targetGdi = !string.IsNullOrEmpty(gdiDevice) ? gdiDevice : monitorId;
            if (!string.IsNullOrEmpty(targetGdi)) {
                for (int i = 0; i < BoundMonitors.Count; i++) {
                    if (!string.IsNullOrEmpty(BoundMonitors[i].gdiDevice) &&
                        string.Equals(BoundMonitors[i].gdiDevice, targetGdi, StringComparison.OrdinalIgnoreCase)) {
                        return BoundMonitors[i];
                    }
                }
            }

            if (!string.IsNullOrEmpty(monitorId)) {
                bool wantInternal = monitorId.IndexOf("internal", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                    (!string.IsNullOrEmpty(SavedInternalPnpId) && monitorId.IndexOf(SavedInternalPnpId, StringComparison.OrdinalIgnoreCase) >= 0);
                bool wantAcer = monitorId.IndexOf("acer", StringComparison.OrdinalIgnoreCase) >= 0 || monitorId.IndexOf("acr", StringComparison.OrdinalIgnoreCase) >= 0;
                bool wantLenovo = monitorId.IndexOf("lenovo", StringComparison.OrdinalIgnoreCase) >= 0 || monitorId.IndexOf("len", StringComparison.OrdinalIgnoreCase) >= 0;

                for (int i = 0; i < BoundMonitors.Count; i++) {
                    if (wantInternal && BoundMonitors[i].isInternal) return BoundMonitors[i];
                    if (wantAcer && BoundMonitors[i].isAcer) return BoundMonitors[i];
                    if (wantLenovo && !BoundMonitors[i].isAcer && !BoundMonitors[i].isInternal) return BoundMonitors[i];
                }
            }

            if (isAcer.HasValue) {
                for (int i = 0; i < BoundMonitors.Count; i++) {
                    if (BoundMonitors[i].isAcer == isAcer.Value) return BoundMonitors[i];
                }
            }

            if (!string.IsNullOrEmpty(monitorId)) {
                string stripped = monitorId.TrimStart('#');
                int reqWinNum;
                if (int.TryParse(stripped, out reqWinNum)) {
                    for (int i = 0; i < BoundMonitors.Count; i++) {
                        if (BoundMonitors[i].windowsDisplayNumber == reqWinNum) return BoundMonitors[i];
                    }
                }
            }

            if (!string.IsNullOrEmpty(monitorId) && monitorId.StartsWith("mon_", StringComparison.OrdinalIgnoreCase)) {
                int idx;
                if (int.TryParse(monitorId.Substring(4), out idx) && idx >= 0 && idx < BoundMonitors.Count) {
                    return BoundMonitors[idx];
                }
            }

            return null;
        }
    }

    private static bool WriteVcpWithRetry(ref BoundPhysicalMonitor target, byte vcpCode, uint val) {
        if (target == null) return false;
        bool ok = SetVCPFeature(target.hPhys, vcpCode, val);
        if (!ok) {
            ReProbePhysicalMonitors();
            target = FindBoundMonitor(target.id, target.pnpId, target.gdiDevice, target.isAcer);
            if (target != null) {
                ok = SetVCPFeature(target.hPhys, vcpCode, val);
            }
        }
        return ok;
    }

    public static bool ApplyControl(string monitorId, string control, int val, string pnpId = null, string gdiDevice = null) {
        BoundPhysicalMonitor target = FindBoundMonitor(monitorId, pnpId, gdiDevice);
        if (target == null) {
            ReProbePhysicalMonitors();
            target = FindBoundMonitor(monitorId, pnpId, gdiDevice);
        }
        if (target == null) return false;

        string targetId = target.id;
        string gdi = target.gdiDevice;
        int clamped0to100 = Math.Max(0, Math.Min(100, val));
        bool ok = false;

        if (target.isInternal) {
            switch (control.ToLowerInvariant()) {
                case "brightness":
                    ok = SetLcdBrightness((byte)clamped0to100);
                    if (!ok && WmiSetBrightnessHandler != null) {
                        try { ok = WmiSetBrightnessHandler((byte)clamped0to100); } catch {}
                    }
                    if (!ok && !string.IsNullOrEmpty(gdi)) {
                        ApplySoftwareBrightness(gdi, clamped0to100);
                        target.isSoftwareBrightnessActive = true;
                        ok = true;
                    }
                    if (ok) {
                        lock (SyncLock) {
                            for (int i = 0; i < CurrentMonitors.Count; i++) {
                                if (CurrentMonitors[i].id == targetId) { CurrentMonitors[i].brightness = clamped0to100; break; }
                            }
                        }
                    }
                    return ok;

                case "contrast":
                    internalContrast = clamped0to100;
                    ok = UpdateInternalGpuRamp(gdi);
                    if (ok) {
                        lock (SyncLock) {
                            for (int i = 0; i < CurrentMonitors.Count; i++) {
                                if (CurrentMonitors[i].id == targetId) { CurrentMonitors[i].contrast = clamped0to100; break; }
                            }
                        }
                    }
                    return ok;

                case "gain_r":
                case "gainr":
                    internalGainR = clamped0to100;
                    ok = UpdateInternalGpuRamp(gdi);
                    if (ok) {
                        lock (SyncLock) {
                            for (int i = 0; i < CurrentMonitors.Count; i++) {
                                if (CurrentMonitors[i].id == targetId) { CurrentMonitors[i].gainR = clamped0to100; break; }
                            }
                        }
                    }
                    return ok;

                case "gain_g":
                case "gaing":
                    internalGainG = clamped0to100;
                    ok = UpdateInternalGpuRamp(gdi);
                    if (ok) {
                        lock (SyncLock) {
                            for (int i = 0; i < CurrentMonitors.Count; i++) {
                                if (CurrentMonitors[i].id == targetId) { CurrentMonitors[i].gainG = clamped0to100; break; }
                            }
                        }
                    }
                    return ok;

                case "gain_b":
                case "gainb":
                    internalGainB = clamped0to100;
                    ok = UpdateInternalGpuRamp(gdi);
                    if (ok) {
                        lock (SyncLock) {
                            for (int i = 0; i < CurrentMonitors.Count; i++) {
                                if (CurrentMonitors[i].id == targetId) { CurrentMonitors[i].gainB = clamped0to100; break; }
                            }
                        }
                    }
                    return ok;

                default:
                    return false;
            }
        }

        IntPtr hPhys = target.hPhys;
        bool isAcer = target.isAcer;

        switch (control.ToLowerInvariant()) {
            case "brightness":
                ok = SetMonitorBrightness(hPhys, (uint)clamped0to100) || SetVCPFeature(hPhys, 0x10, (uint)clamped0to100);
                if (!ok) {
                    ReProbePhysicalMonitors();
                    target = FindBoundMonitor(targetId, target.pnpId, gdi, isAcer);
                    if (target != null) {
                        hPhys = target.hPhys;
                        targetId = target.id;
                        gdi = target.gdiDevice;
                        ok = SetMonitorBrightness(hPhys, (uint)clamped0to100) || SetVCPFeature(hPhys, 0x10, (uint)clamped0to100);
                    }
                }
                if (ok) {
                    if (target != null && target.isSoftwareBrightnessActive) {
                        ResetSoftwareGamma(gdi);
                        target.isSoftwareBrightnessActive = false;
                    }
                } else if (!string.IsNullOrEmpty(gdi)) {
                    ApplySoftwareBrightness(gdi, clamped0to100);
                    if (target != null) target.isSoftwareBrightnessActive = true;
                }
                lock (SyncLock) {
                    for (int i = 0; i < CurrentMonitors.Count; i++) {
                        if (CurrentMonitors[i].id == targetId) { CurrentMonitors[i].brightness = clamped0to100; break; }
                    }
                }
                return true;

            case "contrast":
                ok = SetMonitorContrast(hPhys, (uint)clamped0to100) || SetVCPFeature(hPhys, 0x12, (uint)clamped0to100);
                if (!ok) {
                    ReProbePhysicalMonitors();
                    target = FindBoundMonitor(targetId, target.pnpId, gdi, isAcer);
                    if (target != null) {
                        hPhys = target.hPhys;
                        targetId = target.id;
                        ok = SetMonitorContrast(hPhys, (uint)clamped0to100) || SetVCPFeature(hPhys, 0x12, (uint)clamped0to100);
                    }
                }
                if (ok) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == targetId) { CurrentMonitors[i].contrast = clamped0to100; break; }
                        }
                    }
                }
                return ok;

            case "gain_r":
            case "gainr":
                ok = SetMonitorRedGreenOrBlueGain(hPhys, 0, (uint)clamped0to100);
                if (!ok) {
                    ReProbePhysicalMonitors();
                    target = FindBoundMonitor(targetId, target.pnpId, gdi, isAcer);
                    if (target != null) {
                        hPhys = target.hPhys;
                        targetId = target.id;
                        ok = SetMonitorRedGreenOrBlueGain(hPhys, 0, (uint)clamped0to100);
                    }
                }
                if (ok) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == targetId) { CurrentMonitors[i].gainR = clamped0to100; break; }
                        }
                    }
                }
                return ok;

            case "gain_g":
            case "gaing":
                ok = SetMonitorRedGreenOrBlueGain(hPhys, 1, (uint)clamped0to100);
                if (!ok) {
                    ReProbePhysicalMonitors();
                    target = FindBoundMonitor(targetId, target.pnpId, gdi, isAcer);
                    if (target != null) {
                        hPhys = target.hPhys;
                        targetId = target.id;
                        ok = SetMonitorRedGreenOrBlueGain(hPhys, 1, (uint)clamped0to100);
                    }
                }
                if (ok) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == targetId) { CurrentMonitors[i].gainG = clamped0to100; break; }
                        }
                    }
                }
                return ok;

            case "gain_b":
            case "gainb":
                ok = SetMonitorRedGreenOrBlueGain(hPhys, 2, (uint)clamped0to100);
                if (!ok) {
                    ReProbePhysicalMonitors();
                    target = FindBoundMonitor(targetId, target.pnpId, gdi, isAcer);
                    if (target != null) {
                        hPhys = target.hPhys;
                        targetId = target.id;
                        ok = SetMonitorRedGreenOrBlueGain(hPhys, 2, (uint)clamped0to100);
                    }
                }
                if (ok) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == targetId) { CurrentMonitors[i].gainB = clamped0to100; break; }
                        }
                    }
                }
                return ok;

            case "volume":
                ok = WriteVcpWithRetry(ref target, 0x62, (uint)clamped0to100);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].volume = clamped0to100; break; }
                        }
                    }
                }
                return ok;

            case "input":
            case "inputsource":
                ok = WriteVcpWithRetry(ref target, 0x60, (uint)val);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].inputSource = val; break; }
                        }
                    }
                }
                return ok;

            case "preset":
            case "colorpreset":
                ok = WriteVcpWithRetry(ref target, 0x14, (uint)val);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].colorPreset = val; break; }
                        }
                    }
                }
                return ok;

            case "power":
            case "powermode":
                ok = WriteVcpWithRetry(ref target, 0xD6, (uint)val);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].powerMode = val; break; }
                        }
                    }
                }
                return ok;

            case "gamma":
                ok = WriteVcpWithRetry(ref target, 0x72, (uint)val);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].gamma = val; break; }
                        }
                    }
                }
                return ok;

            case "blackboost":
            case "blacklevel":
                ok = WriteVcpWithRetry(ref target, 0x6C, (uint)clamped0to100);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) {
                                CurrentMonitors[i].blackBoost = clamped0to100;
                                CurrentMonitors[i].blackLevel = clamped0to100;
                                break;
                            }
                        }
                    }
                }
                return ok;

            case "darkboost":
                ok = WriteVcpWithRetry(ref target, 0xF6, (uint)val);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].darkBoost = val; break; }
                        }
                    }
                }
                return ok;

            case "overdrive":
                byte odCode = isAcer ? (byte)0xE8 : (byte)0xE0;
                ok = WriteVcpWithRetry(ref target, odCode, (uint)val);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].overdrive = val; break; }
                        }
                    }
                }
                return ok;

            case "strobing":
            case "vrb":
            case "mprt":
                byte stCode = isAcer ? (byte)0xE5 : (byte)0xEF;
                ok = WriteVcpWithRetry(ref target, stCode, (uint)val);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) {
                                CurrentMonitors[i].strobing = val;
                                CurrentMonitors[i].mprt = val;
                                break;
                            }
                        }
                    }
                }
                return ok;

            case "freesync":
                byte fsCode = isAcer ? (byte)0xE0 : (byte)0xEA;
                ok = WriteVcpWithRetry(ref target, fsCode, (uint)val);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].freeSync = val; break; }
                        }
                    }
                }
                return ok;

            case "supersharpness":
                uint ssVal = (val > 0) ? 3u : 0u;
                ok = WriteVcpWithRetry(ref target, 0xE4, ssVal);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].superSharpness = (val > 0 ? 1 : 0); break; }
                        }
                    }
                }
                return ok;

            case "bluelight":
                uint blVal = (val == 0) ? 0u : (uint)val;
                ok = WriteVcpWithRetry(ref target, 0xE7, blVal);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].blueLight = val; break; }
                        }
                    }
                }
                return ok;
        }
        return false;
    }

    public static void ReadTelemetryFeatures(Dictionary<string, string> friendlyNames) {
        List<BoundPhysicalMonitor> snapshot;
        lock (SyncLock) {
            snapshot = new List<BoundPhysicalMonitor>(BoundMonitors);
        }

        var updates = new TelemetryUpdateItem[snapshot.Count];

        for (int i = 0; i < snapshot.Count; i++) {
            var bound = snapshot[i];
            var u = new TelemetryUpdateItem();
            u.id = bound.id;
            updates[i] = u;

            if (bound.isInternal) {
                u.isInternal = true;
                byte curLcd = 50;
                if (QueryLcdBrightness(out curLcd) == 0) {
                    u.curLcd = curLcd;
                }
                continue;
            }

            IntPtr hPhys = bound.hPhys;
            bool isAcer = bound.isAcer;

            // 1. Empirical Brightness
            uint bMin, bCur, bMax;
            if (GetMonitorBrightness(hPhys, out bMin, out bCur, out bMax)) {
                u.brightVal = (int)bCur;
            } else {
                uint pvct, vCur, vMax;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x10, out pvct, out vCur, out vMax)) {
                    u.brightVal = (int)vCur;
                }
            }

            // 2. Empirical Contrast
            uint cMin, cCur, cMax;
            if (GetMonitorContrast(hPhys, out cMin, out cCur, out cMax)) {
                u.contrastVal = (int)cCur;
            } else {
                uint pvct, vCur, vMax;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x12, out pvct, out vCur, out vMax)) {
                    u.contrastVal = (int)vCur;
                }
            }

            // 3. Empirical RGB White Balance Gains
            uint rMin, rCur, rMax;
            if (GetMonitorRedGreenOrBlueGain(hPhys, 0, out rMin, out rCur, out rMax)) {
                u.rGain = (int)rCur;
            } else {
                uint pvct, vCur, vMax;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x16, out pvct, out vCur, out vMax)) {
                    u.rGain = (int)vCur;
                }
            }

            uint gMin, gCur, gMax;
            if (GetMonitorRedGreenOrBlueGain(hPhys, 1, out gMin, out gCur, out gMax)) {
                u.gGain = (int)gCur;
            } else {
                uint pvct, vCur, vMax;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x18, out pvct, out vCur, out vMax)) {
                    u.gGain = (int)vCur;
                }
            }

            uint blMin, blCur, blMax;
            if (GetMonitorRedGreenOrBlueGain(hPhys, 2, out blMin, out blCur, out blMax)) {
                u.bGain = (int)blCur;
            } else {
                uint pvct, vCur, vMax;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x1A, out pvct, out vCur, out vMax)) {
                    u.bGain = (int)vCur;
                }
            }

            uint pvctReply, vCurReply, vMaxReply;
            if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x14, out pvctReply, out vCurReply, out vMaxReply)) {
                u.preset = (int)vCurReply;
            }

            if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x62, out pvctReply, out vCurReply, out vMaxReply)) u.vol = (int)vCurReply;
            if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x60, out pvctReply, out vCurReply, out vMaxReply)) u.input = (int)vCurReply;
            if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xD6, out pvctReply, out vCurReply, out vMaxReply)) u.power = (int)vCurReply;
            if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x6C, out pvctReply, out vCurReply, out vMaxReply)) u.blackB = (int)vCurReply;

            if (isAcer) {
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE8, out pvctReply, out vCurReply, out vMaxReply)) u.od = (int)vCurReply;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE5, out pvctReply, out vCurReply, out vMaxReply)) u.strobing = (int)vCurReply;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE0, out pvctReply, out vCurReply, out vMaxReply)) {
                    u.fs = ((vCurReply == 255 || vCurReply > 0) ? 1 : 0);
                }
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE4, out pvctReply, out vCurReply, out vMaxReply)) {
                    u.ss = (vCurReply > 0 ? 1 : 0);
                }
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE7, out pvctReply, out vCurReply, out vMaxReply)) {
                    u.bl = (vCurReply == 255 ? 0 : (int)vCurReply);
                }
            } else {
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x72, out pvctReply, out vCurReply, out vMaxReply)) u.gamma = (int)vCurReply;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xF6, out pvctReply, out vCurReply, out vMaxReply)) u.darkB = (int)vCurReply;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xE0, out pvctReply, out vCurReply, out vMaxReply)) u.od = (int)vCurReply;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xEF, out pvctReply, out vCurReply, out vMaxReply)) {
                    u.mprt = (int)vCurReply;
                    u.strobing = (int)vCurReply;
                }
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xEA, out pvctReply, out vCurReply, out vMaxReply)) u.fs = (int)vCurReply;
            }
        }

        lock (SyncLock) {
            for (int i = 0; i < updates.Length; i++) {
                var u = updates[i];
                if (u == null || u.id == null) continue;
                for (int j = 0; j < CurrentMonitors.Count; j++) {
                    if (CurrentMonitors[j].id == u.id) {
                        if (u.isInternal) {
                            CurrentMonitors[j].brightness = u.curLcd;
                            CurrentMonitors[j].contrast = internalContrast;
                            CurrentMonitors[j].gainR = internalGainR;
                            CurrentMonitors[j].gainG = internalGainG;
                            CurrentMonitors[j].gainB = internalGainB;
                        } else {
                            if (u.brightVal >= 0) CurrentMonitors[j].brightness = u.brightVal;
                            if (u.contrastVal >= 0) CurrentMonitors[j].contrast = u.contrastVal;
                            if (u.rGain >= 0) CurrentMonitors[j].gainR = u.rGain;
                            if (u.gGain >= 0) CurrentMonitors[j].gainG = u.gGain;
                            if (u.bGain >= 0) CurrentMonitors[j].gainB = u.bGain;
                            if (u.preset >= 0) CurrentMonitors[j].colorPreset = u.preset;
                            CurrentMonitors[j].volume = u.vol;
                            if (u.input >= 0) CurrentMonitors[j].inputSource = u.input;
                            if (u.power >= 0) CurrentMonitors[j].powerMode = u.power;
                            if (u.blackB >= 0) {
                                CurrentMonitors[j].blackBoost = u.blackB;
                                CurrentMonitors[j].blackLevel = u.blackB;
                            }
                            if (u.gamma >= 0) CurrentMonitors[j].gamma = u.gamma;
                            if (u.darkB >= 0) CurrentMonitors[j].darkBoost = u.darkB;
                            if (u.od >= 0) CurrentMonitors[j].overdrive = u.od;
                            if (u.strobing >= 0) CurrentMonitors[j].strobing = u.strobing;
                            if (u.mprt >= 0) CurrentMonitors[j].mprt = u.mprt;
                            if (u.fs >= 0) CurrentMonitors[j].freeSync = u.fs;
                            if (u.ss >= 0) CurrentMonitors[j].superSharpness = u.ss;
                            if (u.bl >= 0) CurrentMonitors[j].blueLight = u.bl;
                        }
                        break;
                    }
                }
            }
            HasProbed = true;
        }
        WakeSignal.Set();
    }

    public static void RequestEmpiricalProbe(int probeId = 0, bool forceRebind = false, Dictionary<string, string> friendlyNames = null) {
        lock (SyncLock) {
            if (probeId > PendingProbeId) {
                PendingProbeId = probeId;
            }
            if (forceRebind) {
                ForceRebindPending = true;
            }
            if (IsProbing) {
                ProbePending = true;
                return;
            }
            IsProbing = true;
        }

        Thread probeThread = new Thread(() => {
            try {
                while (true) {
                    bool rebindNow = false;
                    int targetProbeId = 0;
                    lock (SyncLock) {
                        ProbePending = false;
                        rebindNow = ForceRebindPending || (BoundMonitors.Count == 0);
                        ForceRebindPending = false;
                        targetProbeId = PendingProbeId;
                    }
                    try {
                        if (rebindNow) {
                            BindPhysicalMonitors(friendlyNames ?? SavedFriendlyNames);
                        }
                        ReadTelemetryFeatures(friendlyNames ?? SavedFriendlyNames);
                    } catch {}

                    lock (SyncLock) {
                        if (targetProbeId > CompletedProbeId) {
                            CompletedProbeId = targetProbeId;
                        }
                        HasProbed = true;
                        if (!ProbePending) {
                            IsProbing = false;
                            break;
                        }
                    }
                    WakeSignal.Set();
                }
            } finally {
                lock (SyncLock) {
                    IsProbing = false;
                    HasProbed = true;
                }
                WakeSignal.Set();
            }
        });
        probeThread.IsBackground = true;
        probeThread.Name = "EmpiricalMonitorProbeWorker";
        probeThread.Start();
    }

    public static void StartWorker(Dictionary<string, string> friendlyNames) {
        RequestEmpiricalProbe(0, false, friendlyNames);

        Thread thread = new Thread(() => {
            try {
                Stream stdin = Console.OpenStandardInput();
                byte[] lenBuf = new byte[4];
                bool isFirstPacket = true;
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
                    if (isFirstPacket && lenBuf[0] == 0xEF && lenBuf[1] == 0xBB && lenBuf[2] == 0xBF) {
                        lenBuf[0] = lenBuf[3];
                        read = 1;
                        while (read < 4) {
                            int r = stdin.Read(lenBuf, read, 4 - read);
                            if (r <= 0) {
                                Environment.Exit(0);
                                return;
                            }
                            read += r;
                        }
                    }
                    isFirstPacket = false;
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

                    string action = ExtractJsonString(json, "action");
                    if (action == "set_panel_control") {
                        string monId = ExtractJsonString(json, "monitorId");
                        string pnpId = ExtractJsonString(json, "pnpId");
                        string gdiDev = ExtractJsonString(json, "gdiDevice");
                        string control = ExtractJsonString(json, "control");
                        int val = ExtractJsonInt(json, "value", 0);
                        if (!string.IsNullOrEmpty(control)) {
                            ApplyControl(monId, control, val, pnpId, gdiDev);
                            WakeSignal.Set();
                        }
                    } else if (action == "set_brightness") {
                        string monId = ExtractJsonString(json, "monitorId");
                        string pnpId = ExtractJsonString(json, "pnpId");
                        string gdiDev = ExtractJsonString(json, "gdiDevice");
                        int val = ExtractJsonInt(json, "value", 50);
                        ApplyControl(monId, "brightness", val, pnpId, gdiDev);
                        WakeSignal.Set();
                    } else if (action == "probe_monitors" || action == "refresh_monitors" || action == "fetch_empirical") {
                        int probeId = ExtractJsonInt(json, "probeId", 0);
                        bool isRefresh = (action == "refresh_monitors");
                        RequestEmpiricalProbe(probeId, isRefresh);
                    }
                }
            } catch {}
        });
        thread.IsBackground = true;
        thread.Name = "MonitorBackgroundWorker";
        thread.Start();
    }

    public static void AppendEscapedJson(StringBuilder sb, string s) {
        if (s == null) {
            sb.Append("null");
            return;
        }
        sb.Append('"');
        for (int i = 0; i < s.Length; i++) {
            char c = s[i];
            switch (c) {
                case '\\': sb.Append("\\\\"); break;
                case '"':  sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                default:
                    if (c < 32) {
                        sb.Append("\\u").Append(((int)c).ToString("x4"));
                    } else {
                        sb.Append(c);
                    }
                    break;
            }
        }
        sb.Append('"');
    }

    public static string ExtractJsonString(string json, string key) {
        if (string.IsNullOrEmpty(json)) return null;
        string search = "\"" + key + "\"";
        int idx = json.IndexOf(search);
        if (idx < 0) return null;
        int colon = json.IndexOf(':', idx + search.Length);
        if (colon < 0) return null;
        int start = colon + 1;
        while (start < json.Length && (json[start] == ' ' || json[start] == '\t' || json[start] == '\r' || json[start] == '\n')) start++;
        if (start >= json.Length || json[start] != '"') return null;
        int quoteEnd = start + 1;
        while (quoteEnd < json.Length) {
            if (json[quoteEnd] == '"') {
                int bsCount = 0;
                int back = quoteEnd - 1;
                while (back >= start && json[back] == '\\') {
                    bsCount++;
                    back--;
                }
                if ((bsCount % 2) == 0) break;
            }
            quoteEnd++;
        }
        if (quoteEnd >= json.Length) return null;
        string raw = json.Substring(start + 1, quoteEnd - start - 1);
        StringBuilder sb = new StringBuilder(raw.Length);
        for (int i = 0; i < raw.Length; i++) {
            if (raw[i] == '\\' && i + 1 < raw.Length) {
                i++;
                char c = raw[i];
                if (c == '"') sb.Append('"');
                else if (c == '\\') sb.Append('\\');
                else if (c == '/') sb.Append('/');
                else if (c == 'b') sb.Append('\b');
                else if (c == 'f') sb.Append('\f');
                else if (c == 'n') sb.Append('\n');
                else if (c == 'r') sb.Append('\r');
                else if (c == 't') sb.Append('\t');
                else if (c == 'u' && i + 4 < raw.Length) {
                    int code;
                    if (int.TryParse(raw.Substring(i + 1, 4), System.Globalization.NumberStyles.HexNumber, null, out code)) {
                        sb.Append((char)code);
                        i += 4;
                    } else {
                        sb.Append('\\').Append(c);
                    }
                } else {
                    sb.Append(c);
                }
            } else {
                sb.Append(raw[i]);
            }
        }
        return sb.ToString();
    }

    public static int ExtractJsonInt(string json, string key, int defaultVal) {
        if (string.IsNullOrEmpty(json)) return defaultVal;
        string search = "\"" + key + "\"";
        int idx = json.IndexOf(search);
        if (idx < 0) return defaultVal;
        int colon = json.IndexOf(':', idx + search.Length);
        if (colon < 0) return defaultVal;
        int start = colon + 1;
        while (start < json.Length && (json[start] == ' ' || json[start] == '\t' || json[start] == '\r' || json[start] == '\n')) start++;
        int end = start;
        while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-')) end++;
        if (end > start) {
            int v;
            if (int.TryParse(json.Substring(start, end - start), out v)) return v;
        }
        return defaultVal;
    }

    public static string BuildTelemetryJson(
        string timestamp, int cpuClock, int cpuLoad, string peClock, double cpuPower, int cpuTemp,
        double igpuPower, string igpuRam, int cpuLimit, string ramUsed, string pageUsed, string commitUsed,
        int gpuTemp, int coreClock, int memClock, double gpuPower, string vramUsed, int gpuLoad,
        string pState, string vrmBrake, string hwThermal)
    {
        StringBuilder sb = new StringBuilder(1500);
        sb.Append("{\"timestamp\":"); AppendEscapedJson(sb, timestamp); sb.Append(',');
        sb.Append("\"cpuClock\":").Append(cpuClock).Append(',');
        sb.Append("\"cpuLoad\":").Append(cpuLoad).Append(',');
        sb.Append("\"peClock\":"); AppendEscapedJson(sb, peClock); sb.Append(',');
        sb.Append("\"cpuPower\":").Append(cpuPower.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"cpuTemp\":").Append(cpuTemp).Append(',');
        sb.Append("\"igpuPower\":").Append(igpuPower.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"igpuRam\":"); AppendEscapedJson(sb, igpuRam); sb.Append(',');
        sb.Append("\"cpuLimit\":").Append(cpuLimit).Append(',');
        sb.Append("\"ramUsed\":"); AppendEscapedJson(sb, ramUsed); sb.Append(',');
        sb.Append("\"pageUsed\":"); AppendEscapedJson(sb, pageUsed); sb.Append(',');
        sb.Append("\"commitUsed\":"); AppendEscapedJson(sb, commitUsed); sb.Append(',');
        sb.Append("\"gpuTemp\":").Append(gpuTemp).Append(',');
        sb.Append("\"coreClock\":").Append(coreClock).Append(',');
        sb.Append("\"memClock\":").Append(memClock).Append(',');
        sb.Append("\"gpuPower\":").Append(gpuPower.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"vramUsed\":"); AppendEscapedJson(sb, vramUsed); sb.Append(',');
        sb.Append("\"gpuLoad\":").Append(gpuLoad).Append(',');
        sb.Append("\"pState\":"); AppendEscapedJson(sb, pState); sb.Append(',');
        sb.Append("\"vrmBrake\":"); AppendEscapedJson(sb, vrmBrake); sb.Append(',');
        sb.Append("\"hwThermal\":"); AppendEscapedJson(sb, hwThermal); sb.Append(',');
        sb.Append("\"hasProbed\":").Append(HasProbed ? "true," : "false,");
        sb.Append("\"isProbing\":").Append(IsProbing ? "true," : "false,");
        sb.Append("\"probeId\":").Append(CompletedProbeId).Append(',');

        int monBrightness = -1;
        if (!HasProbed) {
            sb.Append("\"monitors\":null,");
        } else {
            sb.Append("\"monitors\":[");
            lock (SyncLock) {
                for (int i = 0; i < CurrentMonitors.Count; i++) {
                    if (i > 0) sb.Append(',');
                    var m = CurrentMonitors[i];
                    if (i == 0) monBrightness = m.brightness;
                    sb.Append("{\"id\":"); AppendEscapedJson(sb, m.id); sb.Append(',');
                    sb.Append("\"pnpId\":"); AppendEscapedJson(sb, m.pnpId); sb.Append(',');
                    sb.Append("\"gdiDevice\":"); AppendEscapedJson(sb, m.gdiDevice); sb.Append(',');
                    sb.Append("\"name\":"); AppendEscapedJson(sb, m.name ?? ""); sb.Append(',');
                    sb.Append("\"windowsDisplayNumber\":").Append(m.windowsDisplayNumber).Append(',');
                    sb.Append("\"isInternal\":").Append(m.isInternal ? "true," : "false,");
                    sb.Append("\"brightness\":").Append(m.brightness).Append(',');
                    sb.Append("\"contrast\":").Append(m.contrast).Append(',');
                    sb.Append("\"gainR\":").Append(m.gainR).Append(',');
                    sb.Append("\"gainG\":").Append(m.gainG).Append(',');
                    sb.Append("\"gainB\":").Append(m.gainB).Append(',');
                    sb.Append("\"volume\":").Append(m.volume).Append(',');
                    sb.Append("\"inputSource\":").Append(m.inputSource).Append(',');
                    sb.Append("\"colorPreset\":").Append(m.colorPreset).Append(',');
                    sb.Append("\"powerMode\":").Append(m.powerMode).Append(',');
                    sb.Append("\"gamma\":").Append(m.gamma).Append(',');
                    sb.Append("\"blackBoost\":").Append(m.blackBoost).Append(',');
                    sb.Append("\"darkBoost\":").Append(m.darkBoost).Append(',');
                    sb.Append("\"blackLevel\":").Append(m.blackLevel).Append(',');
                    sb.Append("\"overdrive\":").Append(m.overdrive).Append(',');
                    sb.Append("\"strobing\":").Append(m.strobing).Append(',');
                    sb.Append("\"mprt\":").Append(m.mprt).Append(',');
                    sb.Append("\"freeSync\":").Append(m.freeSync).Append(',');
                    sb.Append("\"superSharpness\":").Append(m.superSharpness).Append(',');
                    sb.Append("\"blueLight\":").Append(m.blueLight);
                    sb.Append('}');
                }
            }
            sb.Append("],");
        }
        sb.Append("\"monitorBrightness\":").Append(monBrightness);
        sb.Append('}');
        return sb.ToString();
    }
}
"@
        if (-not ([System.Management.Automation.PSTypeName]'MonitorController').Type) {
            Add-Type -TypeDefinition $csharpDef -ErrorAction SilentlyContinue
        }
    }

    $hasNvmlDll = Test-Path "$env:SystemRoot\System32\nvml.dll"
    if ($hasNvmlDll) {
        [NvmlHost]::StartInitAsync()
    }

    $friendlyNames = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    try {
        [MonitorController]::WmiSetBrightnessHandler = {
            param([byte]$val)
            try {
                $wmiInst = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop
                if ($wmiInst) {
                    Invoke-CimMethod -InputObject $wmiInst -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$val } -ErrorAction Stop | Out-Null
                    return $true
                }
            } catch {}
            return $false
        }
    } catch {}

    [MonitorController]::StartWorker($friendlyNames)
    [MonitorController]::GetInstantCpuLoad() | Out-Null

    # Open persistent kernel handle to parent process for watchdog (0ms native query)
    try {
        $parentPid = [MonitorController]::GetParentProcessId()
        if ($parentPid -le 0) {
            $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction SilentlyContinue).ParentProcessId
        }
        if ($parentPid -gt 0) {
            $parentObj = [System.Diagnostics.Process]::GetProcessById($parentPid)
        }
    } catch {}

    $memStat = New-Object MonitorController+MEMORYSTATUSEX
    $memStat.dwLength = [System.Runtime.InteropServices.Marshal]::SizeOf($memStat)
    if ([MonitorController]::GlobalMemoryStatusEx([ref]$memStat)) {
        if ($memStat.ullTotalPhys -gt 0) {
            $totalRamGB = [math]::Round($memStat.ullTotalPhys / 1GB, 1)
            $ramUsedGB  = [math]::Round(($memStat.ullTotalPhys - $memStat.ullAvailPhys) / 1GB, 1)
            $ramPct     = [int]$memStat.dwMemoryLoad
        }
        if ($memStat.ullTotalPageFile -gt 0) {
            $commitLimitGB = [math]::Round($memStat.ullTotalPageFile / 1GB, 1)
            $commitUsedGB  = [math]::Round(($memStat.ullTotalPageFile - $memStat.ullAvailPageFile) / 1GB, 1)
            $commitPct     = [math]::Round(($commitUsedGB / $commitLimitGB) * 100, 0)
        }
        if ($memStat.ullTotalPageFile -gt $memStat.ullTotalPhys) {
            $totalPageGB = [math]::Round(($memStat.ullTotalPageFile - $memStat.ullTotalPhys) / 1GB, 1)
        }
    }

    $perfCountersReady = $false
    $pcRaplPkg = $null
    $pcRaplPp1 = $null
    $pcPagePct = $null
    $sharedInstances = $null
    $nvmlUtil = $null
    $nvmlMem = $null

    $warmupTicks = 0
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
        $vrmBrakeStr  = "Not Active"
        $hwThermalStr = "Not Active"

        if ([NvmlHost]::IsReady) {
            try {
                if ($null -eq $nvmlUtil) {
                    $nvmlUtil = New-Object NvmlHost+NvmlUtilization
                    $nvmlMem  = New-Object NvmlHost+NvmlMemory
                }
                $temp = 0
                $pwr = 0
                $core = 0
                $memC = 0
                $pStateVal = 0
                $throttleMask = [uint64]0

                [NvmlHost]::GetTemperature([NvmlHost]::DeviceHandle, 0, [ref]$temp) | Out-Null
                [NvmlHost]::GetPowerUsage([NvmlHost]::DeviceHandle, [ref]$pwr) | Out-Null
                [NvmlHost]::GetUtilizationRates([NvmlHost]::DeviceHandle, [ref]$nvmlUtil) | Out-Null
                [NvmlHost]::GetMemoryInfo([NvmlHost]::DeviceHandle, [ref]$nvmlMem) | Out-Null
                [NvmlHost]::GetClockInfo([NvmlHost]::DeviceHandle, 0, [ref]$core) | Out-Null
                [NvmlHost]::GetClockInfo([NvmlHost]::DeviceHandle, 2, [ref]$memC) | Out-Null
                [NvmlHost]::GetPerformanceState([NvmlHost]::DeviceHandle, [ref]$pStateVal) | Out-Null
                [NvmlHost]::GetClocksThrottleReasons([NvmlHost]::DeviceHandle, [ref]$throttleMask) | Out-Null

                $rawGpuTemp   = [double]$temp
                $rawGpuWatt   = [double][math]::Round($pwr / 1000.0, 1)
                $gpuCoreClk   = [int]$core
                $gpuMemClk    = [int]$memC
                $gpuLoad      = [int]$nvmlUtil.gpu
                $pStateStr    = "P$pStateVal"
                $vramUsedGB   = [math]::Round($nvmlMem.used / 1GB, 1)
                $vramTotalGB  = [math]::Round($nvmlMem.total / 1GB, 1)
                $vramPct      = if ($nvmlMem.total -gt 0) { [math]::Round(($nvmlMem.used / $nvmlMem.total) * 100, 0) } else { 0 }
                $hwThermalStr = if (($throttleMask -band 0x08) -ne 0) { "Active" } else { "Not Active" }
                $vrmBrakeStr  = if (($throttleMask -band 0x80) -ne 0) { "Active" } else { "Not Active" }
            } catch {}
        } elseif ($warmupTicks -ge 3 -and -not $hasNvmlDll) {
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

        # 2. Query Instantaneous CPU metrics via fast native Win32/NT APIs (<1ms)
        $instantLoad = [MonitorController]::GetInstantCpuLoad()
        if ($instantLoad -gt 0 -or $cpuUtil -eq 0) {
            $cpuUtil = $instantLoad
        }

        $maxP = 0.0
        $maxE = 0.0
        $ntCores = [MonitorController]::GetProcessorPowerInfo()
        if ($ntCores) {
            $sumP = 0.0
            $countP = 0
            for ($th = 0; $th -lt $numThreads; $th++) {
                $mhz = [double]$ntCores[$th].CurrentMhz
                if ($th -lt $numPThreads) {
                    if ($mhz -gt $maxP) { $maxP = $mhz }
                    $sumP += $mhz
                    $countP++
                } else {
                    if ($mhz -gt $maxE) { $maxE = $mhz }
                }
            }
            if ($maxP -gt 0) { $cpuClock = [int][math]::Round($maxP, 0) }
            $pGhzStr = "{0:N1}" -f ($maxP / 1000)
            $eGhzStr = "{0:N1}" -f ($maxE / 1000)
            $peClock = if ($maxE -gt 0) { "P: $pGhzStr GHz | E: $eGhzStr GHz" } else { "P: $pGhzStr GHz" }
            if ($ntCores[0].MaxMhz -gt 0 -and $ntCores[0].MhzLimit -gt 0) {
                $cpuLimit = [math]::Min(100, [int][math]::Round(($ntCores[0].MhzLimit / $ntCores[0].MaxMhz) * 100, 0))
            }
        }

        # 3. Check background runspace result if still pending
        if (-not $perfCountersReady -and $perfAsync -and $perfAsync.IsCompleted) {
            try {
                $perfRes = $perfPs.EndInvoke($perfAsync)
                if ($perfRes -and $perfRes[0]) {
                    $cMap = $perfRes[0]
                    $pcRaplPkg       = $cMap["RaplPkg"]
                    $pcRaplPp1       = $cMap["RaplPp1"]
                    $pcPagePct       = $cMap["PagePct"]
                    $sharedInstances = $cMap["Shared"]
                    $perfCountersReady = $true
                }
            } catch {}
            try { $perfPs.Dispose(); $perfRs.Close() } catch {}
            $perfAsync = $null
        }

        if ($perfCountersReady) {
            try {
                if ($pcRaplPkg) { $cpuPower  = [math]::Round($pcRaplPkg.NextValue() / 1000, 1) }
                if ($pcRaplPp1) { $igpuPower = [math]::Round($pcRaplPp1.NextValue() / 1000, 1) }
                if ($pcPagePct) {
                    $pagePct    = [math]::Round($pcPagePct.NextValue(), 0)
                    $pageUsedGB = [math]::Round(($pagePct / 100.0) * $totalPageGB, 1)
                }
                if ($sharedInstances) {
                    $maxSharedMB = 0.0
                    foreach ($pcSh in $sharedInstances) {
                        $mb = [math]::Round($pcSh.NextValue() / 1MB, 0)
                        if ($mb -gt $maxSharedMB) { $maxSharedMB = $mb }
                    }
                    $igpuSharedMB = $maxSharedMB
                }
            } catch {}
        }

        # 4. Memory query via Win32 (sub-microsecond)
        if ([MonitorController]::GlobalMemoryStatusEx([ref]$memStat)) {
            $ramUsedGB = [math]::Round(($memStat.ullTotalPhys - $memStat.ullAvailPhys) / 1GB, 1)
            $ramPct    = [int]$memStat.dwMemoryLoad
            if ($memStat.ullTotalPageFile -gt 0 -and $commitLimitGB -gt 0) {
                $commitUsedGB  = [math]::Round(($memStat.ullTotalPageFile - $memStat.ullAvailPageFile) / 1GB, 1)
                $commitPct     = [math]::Round(($commitUsedGB / $commitLimitGB) * 100, 0)
            }
        }

        $igpuRamStr = if ($igpuSharedMB -ge 1024) { "{0:N1} GB" -f ($igpuSharedMB / 1024) } else { "$igpuSharedMB MB" }

        # Baseline CPU power fallback for Frame 0 before RAPL counter completes
        if ($cpuPower -le 0.0) {
            $cpuPower = [math]::Round(15.0 + (35.0 * ($cpuUtil / 100.0)), 1)
        }

        # 5. Pure State-Space Continuous Thermal Observer (<0.02ms scalar arithmetic)
        $pTotal = $cpuPower + $rawGpuWatt
        $rConv = 0.22 + (0.58 / (1.0 + [math]::Pow(($pTotal / 46.0), 1.4)))
        $sinkConv   = 24.0 + ($pTotal * $rConv)
        $sinkGpu    = if ($rawGpuTemp -ge 28.0) { [math]::Max(24.0, $rawGpuTemp - ($rawGpuWatt * 0.14) + ($cpuPower * 0.06)) } else { $sinkConv }
        $sinkTarget = if ($rawGpuTemp -ge 28.0) { $sinkGpu } else { $sinkConv }

        if ($isFirstTick) {
            $sinkTemp = $sinkTarget
        } else {
            $sinkTemp += 0.080 * ($sinkTarget - $sinkTemp)
        }

        $boostFactor = [math]::Max(0.0, [math]::Min(1.0, (($maxP - 3200.0) / 1500.0)))
        $utilFactor  = 1.0 - [math]::Max(0.0, [math]::Min(1.0, ($cpuUtil / 100.0)))
        $rDie        = 0.32 + (0.14 * $boostFactor * $utilFactor)

        $cpuTarget = $sinkTemp + ($cpuPower * $rDie)
        if ($cpuLimit -lt 100 -and $cpuPower -gt 35.0) {
            $prochotFloor = 98.0 + [math]::Min(2.0, (100.0 - $cpuLimit) * 0.1)
            if ($cpuTarget -lt $prochotFloor) { $cpuTarget = $prochotFloor }
        }

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

        $cpuEstTemp = [math]::Max([math]::Max(24.0, $sinkTemp), [math]::Min(101.0, $cpuEstTemp))
        $cpuTempInt = [int][math]::Round($cpuEstTemp, 0)

        # 6. Construct Transposed Matrix Payload via compiled high-speed C# serializer
        $payload = [MonitorController]::BuildTelemetryJson(
            (Get-Date).ToString("HH:mm:ss"),
            $cpuClock,
            $cpuUtil,
            $peClock,
            $cpuPower,
            $cpuTempInt,
            $igpuPower,
            $igpuRamStr,
            $cpuLimit,
            "$ramUsedGB / $totalRamGB GB ($ramPct%)",
            "$pageUsedGB / $totalPageGB GB ($pagePct%)",
            "$commitUsedGB / $commitLimitGB GB ($commitPct%)",
            [int]$rawGpuTemp,
            [int]$gpuCoreClk,
            [int]$gpuMemClk,
            [math]::Round($rawGpuWatt, 1),
            "$vramUsedGB / $vramTotalGB GB ($vramPct%)",
            [int]$gpuLoad,
            $pStateStr,
            $vrmBrakeStr,
            $hwThermalStr
        )

        # 7. Framed stdout output (32-bit little-endian prefix)
        $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $lengthPrefix = [System.BitConverter]::GetBytes([uint32]$jsonBytes.Length)
        $stdout.Write($lengthPrefix, 0, 4)
        $stdout.Write($jsonBytes, 0, $jsonBytes.Length)
        $stdout.Flush()

        $warmupTicks++
        # Adaptive Load Cadence: 200ms during initial warm-up, 800ms under gaming/load, 1800ms when idle on desktop
        $isIdle = ($cpuPower -le 18.0) -and ($gpuLoad -eq 0) -and ($rawGpuTemp -lt 52.0)
        $sleepInterval = if ($warmupTicks -le 2) { 200 } elseif ($isIdle) { 1800 } else { 800 }
        [MonitorController]::WakeSignal.WaitOne($sleepInterval) | Out-Null
    }
}
catch {
    exit 0
}
finally {
    [MonitorController]::IsRunning = $false
    if ($perfPs) { try { $perfPs.Dispose() } catch {} }
    if ($perfRs) { try { $perfRs.Close() } catch {} }
    if ([NvmlHost]::IsReady) {
        try { [NvmlHost]::Shutdown() | Out-Null } catch {}
    }
}
