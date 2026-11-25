$ErrorActionPreference = 'Stop'
$stdout = [System.Console]::OpenStandardOutput()


# Fast hardware baseline detection without slow WMI queries (0ms overhead)
$numThreads = [System.Environment]::ProcessorCount
$numPThreads = if ($numThreads -gt 16) { [int]($numThreads * 0.6) } elseif ($numThreads -gt 8) { [int]($numThreads * 0.75) } else { $numThreads }
$totalRamGB  = 16.0
$totalPageGB = 16.0

# Native C-API Performance Counters (PDH) initialize on background thread after Add-Type (~550ms)

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
    public static ManualResetEvent ReadyEvent = new ManualResetEvent(false);

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
            finally {
                ReadyEvent.Set();
            }
        });
        t.IsBackground = true;
        t.Name = "NvmlAsyncInit";
        t.Start();
    }
}

public class PdhHost {
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    public static extern int PdhOpenQuery(string szDataSource, IntPtr dwUserData, out IntPtr phQuery);

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    public static extern int PdhAddEnglishCounter(IntPtr hQuery, string szFullCounterPath, IntPtr dwUserData, out IntPtr phCounter);

    [DllImport("pdh.dll")]
    public static extern int PdhCollectQueryData(IntPtr hQuery);

    [DllImport("pdh.dll")]
    public static extern int PdhCloseQuery(IntPtr hQuery);

    [StructLayout(LayoutKind.Sequential)]
    public struct PDH_FMT_COUNTERVALUE {
        public uint CStatus;
        public double doubleValue;
    }

    [DllImport("pdh.dll")]
    public static extern int PdhGetFormattedCounterValue(IntPtr hCounter, uint dwFormat, IntPtr lpdwType, out PDH_FMT_COUNTERVALUE pValue);

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    public static extern int PdhExpandWildCardPath(string szDataSource, string szWildCardPath, IntPtr mszExpandedPathList, ref uint pcchPathListLength, uint dwFlags);

    public static volatile bool IsReady = false;
    public static ManualResetEvent ReadyEvent = new ManualResetEvent(false);
    private static readonly object PdhLock = new object();
    private static IntPtr Query = IntPtr.Zero;
    private static IntPtr cPkg = IntPtr.Zero;
    private static IntPtr cPp1 = IntPtr.Zero;
    private static IntPtr cPage = IntPtr.Zero;
    private static List<IntPtr> cGpuShared = new List<IntPtr>();

    public static void StartInitAsync() {
        Thread t = new Thread(() => {
            try {
                IntPtr q = IntPtr.Zero;
                if (PdhOpenQuery(null, IntPtr.Zero, out q) == 0) {
                    IntPtr hPkg = IntPtr.Zero, hPp1 = IntPtr.Zero, hPage = IntPtr.Zero;
                    if (PdhAddEnglishCounter(q, @"\Energy Meter(RAPL_Package0_PKG)\Power", IntPtr.Zero, out hPkg) != 0) hPkg = IntPtr.Zero;
                    if (PdhAddEnglishCounter(q, @"\Energy Meter(RAPL_Package0_PP1)\Power", IntPtr.Zero, out hPp1) != 0) hPp1 = IntPtr.Zero;
                    if (PdhAddEnglishCounter(q, @"\Paging File(_Total)\% Usage", IntPtr.Zero, out hPage) != 0) hPage = IntPtr.Zero;

                    var shList = new List<IntPtr>();
                    uint bufLen = 0;
                    PdhExpandWildCardPath(null, @"\GPU Adapter Memory(*)\Shared Usage", IntPtr.Zero, ref bufLen, 0);
                    if (bufLen > 0) {
                        IntPtr buf = Marshal.AllocHGlobal((int)(bufLen * 2));
                        try {
                            if (PdhExpandWildCardPath(null, @"\GPU Adapter Memory(*)\Shared Usage", buf, ref bufLen, 0) == 0) {
                                int offset = 0;
                                while (true) {
                                    string path = Marshal.PtrToStringUni(IntPtr.Add(buf, offset * 2));
                                    if (string.IsNullOrEmpty(path)) break;
                                    offset += path.Length + 1;
                                    IntPtr ch = IntPtr.Zero;
                                    if (PdhAddEnglishCounter(q, path, IntPtr.Zero, out ch) == 0) shList.Add(ch);
                                }
                            }
                        } finally {
                            Marshal.FreeHGlobal(buf);
                        }
                    }

                    PdhCollectQueryData(q);
                    Thread.Sleep(50);
                    PdhCollectQueryData(q);

                    lock (PdhLock) {
                        Query = q;
                        cPkg = hPkg;
                        cPp1 = hPp1;
                        cPage = hPage;
                        cGpuShared = shList;
                        IsReady = true;
                    }
                }
            } catch {}
            finally {
                ReadyEvent.Set();
            }
        });
        t.IsBackground = true;
        t.Name = "PdhAsyncInit";
        t.Start();
    }

    public static void Sample(out double pkgWatts, out double igpuWatts, out double pagePct, out double igpuSharedMB) {
        pkgWatts = 0.0;
        igpuWatts = 0.0;
        pagePct = 0.0;
        igpuSharedMB = 0.0;
        lock (PdhLock) {
            if (!IsReady || Query == IntPtr.Zero) return;
            try {
                PdhCollectQueryData(Query);
                PDH_FMT_COUNTERVALUE v;
                if (cPkg != IntPtr.Zero && PdhGetFormattedCounterValue(cPkg, 0x200u, IntPtr.Zero, out v) == 0 && v.CStatus == 0) {
                    pkgWatts = Math.Round(v.doubleValue / 1000.0, 1);
                }
                if (cPp1 != IntPtr.Zero && PdhGetFormattedCounterValue(cPp1, 0x200u, IntPtr.Zero, out v) == 0 && v.CStatus == 0) {
                    igpuWatts = Math.Round(v.doubleValue / 1000.0, 1);
                }
                if (cPage != IntPtr.Zero && PdhGetFormattedCounterValue(cPage, 0x200u, IntPtr.Zero, out v) == 0 && v.CStatus == 0) {
                    pagePct = Math.Round(v.doubleValue, 0);
                }
                double maxMb = 0.0;
                for (int i = 0; i < cGpuShared.Count; i++) {
                    if (PdhGetFormattedCounterValue(cGpuShared[i], 0x200u, IntPtr.Zero, out v) == 0 && v.CStatus == 0) {
                        double mb = Math.Round(v.doubleValue / (1024.0 * 1024.0), 0);
                        if (mb > maxMb) maxMb = mb;
                    }
                }
                igpuSharedMB = maxMb;
            } catch {}
        }
    }

    public static void Shutdown() {
        lock (PdhLock) {
            IsReady = false;
            if (Query != IntPtr.Zero) {
                try { PdhCloseQuery(Query); } catch {}
                Query = IntPtr.Zero;
            }
        }
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
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
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

    public static string GetMonitorPnpId(IntPtr hMonitor, out string gdiDevice, out int width, out int height) {
        gdiDevice = null;
        width = 0;
        height = 0;
        try {
            MONITORINFOEX mi = new MONITORINFOEX();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(hMonitor, ref mi)) {
                gdiDevice = mi.szDevice;
                width = mi.rcMonitor.right - mi.rcMonitor.left;
                height = mi.rcMonitor.bottom - mi.rcMonitor.top;
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

        try {
            DISPLAY_BRIGHTNESS b = new DISPLAY_BRIGHTNESS();
            int size = Marshal.SizeOf(b);
            IntPtr pOut = Marshal.AllocHGlobal(size);
            try {
                uint returned = 0;
                bool ok = DeviceIoControl(hLcd, 0x00230498, IntPtr.Zero, 0, pOut, (uint)size, out returned, IntPtr.Zero);
                if (ok) {
                    b = (DISPLAY_BRIGHTNESS)Marshal.PtrToStructure(pOut, typeof(DISPLAY_BRIGHTNESS));
                    cur = b.ucACBrightness;
                    return 0;
                } else {
                    return Marshal.GetLastWin32Error();
                }
            } finally {
                Marshal.FreeHGlobal(pOut);
            }
        } finally {
            CloseHandle(hLcd);
        }
    }

    public static bool SetLcdBrightness(byte val) {
        IntPtr hLcd = CreateFile("\\\\.\\LCD", 0x80000000 | 0x40000000, 1 | 2, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (hLcd == (IntPtr)(-1) || hLcd == IntPtr.Zero) return false;

        try {
            DISPLAY_BRIGHTNESS b = new DISPLAY_BRIGHTNESS();
            b.ucDisplayPolicy = 3;
            b.ucACBrightness = val;
            b.ucDCBrightness = val;

            int size = Marshal.SizeOf(b);
            IntPtr pIn = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(b, pIn, false);
                uint returned = 0;
                return DeviceIoControl(hLcd, 0x0023049C, pIn, (uint)size, IntPtr.Zero, 0, out returned, IntPtr.Zero);
            } finally {
                Marshal.FreeHGlobal(pIn);
            }
        } finally {
            CloseHandle(hLcd);
        }
    }

    public static int internalContrast = 50;
    public static int internalGainR = 50;
    public static int internalGainG = 50;
    public static int internalGainB = 50;

    public static void SetInternalDisplayCalibration(int contrast, int gainR, int gainG, int gainB) {
        if (contrast >= 0) internalContrast = Math.Max(0, Math.Min(100, contrast));
        if (gainR >= 0) internalGainR = Math.Max(0, Math.Min(100, gainR));
        if (gainG >= 0) internalGainG = Math.Max(0, Math.Min(100, gainG));
        if (gainB >= 0) internalGainB = Math.Max(0, Math.Min(100, gainB));

        string intGdi = null;
        lock (SyncLock) {
            for (int i = 0; i < CurrentMonitors.Count; i++) {
                if (CurrentMonitors[i].isInternal ||
                    (!string.IsNullOrEmpty(SavedInternalPnpId) && string.Equals(CurrentMonitors[i].id, SavedInternalPnpId, StringComparison.OrdinalIgnoreCase)) ||
                    (!string.IsNullOrEmpty(CurrentMonitors[i].gdiDevice) && CurrentMonitors[i].gdiDevice.IndexOf("DISPLAY1", StringComparison.OrdinalIgnoreCase) >= 0)) {
                    if (contrast >= 0) CurrentMonitors[i].contrast = internalContrast;
                    if (gainR >= 0) CurrentMonitors[i].gainR = internalGainR;
                    if (gainG >= 0) CurrentMonitors[i].gainG = internalGainG;
                    if (gainB >= 0) CurrentMonitors[i].gainB = internalGainB;
                }
            }
            for (int i = 0; i < BoundMonitors.Count; i++) {
                if (BoundMonitors[i].isInternal && !string.IsNullOrEmpty(BoundMonitors[i].gdiDevice)) {
                    intGdi = BoundMonitors[i].gdiDevice;
                    break;
                }
            }
        }

        UpdateInternalGpuRamp(intGdi);
    }

    public static bool UpdateInternalGpuRamp(string gdiDevice) {
        if (string.IsNullOrEmpty(gdiDevice)) {
            lock (SyncLock) {
                for (int i = 0; i < BoundMonitors.Count; i++) {
                    if (BoundMonitors[i].isInternal && !string.IsNullOrEmpty(BoundMonitors[i].gdiDevice)) {
                        gdiDevice = BoundMonitors[i].gdiDevice;
                        break;
                    }
                }
            }
            if (string.IsNullOrEmpty(gdiDevice)) gdiDevice = "\\\\.\\DISPLAY1";
        }

        IntPtr hdc = CreateDC(null, gdiDevice, null, IntPtr.Zero);
        if (hdc == IntPtr.Zero) return false;
        try {
            double bValSoft = 100.0;
            bool isSoftActive = false;
            lock (SyncLock) {
                for (int i = 0; i < BoundMonitors.Count; i++) {
                    if (BoundMonitors[i].isInternal) {
                        if (BoundMonitors[i].isSoftwareBrightnessActive) {
                            isSoftActive = true;
                            bValSoft = BoundMonitors[i].softwareBrightnessVal;
                        }
                        break;
                    }
                }
            }

            int clampedContrast = Math.Max(0, Math.Min(100, internalContrast));
            double k = 1.5 * (clampedContrast - 50.0) / 50.0;

            double attenBright = isSoftActive ? (0.52 + 0.48 * (bValSoft / 100.0)) : 1.0;
            double gammaBright = isSoftActive ? (1.0 + 0.4 * (100.0 - bValSoft) / 100.0) : 1.0;

            ushort[] ramp = new ushort[3 * 256];
            int[] gains = new int[] { internalGainR, internalGainG, internalGainB };

            for (int ch = 0; ch < 3; ch++) {
                int gVal = Math.Max(0, Math.Min(100, gains[ch]));
                double attenGain = (gVal <= 50) ? (0.65 + 0.35 * (gVal / 50.0)) : 1.0;
                double boostGain = (gVal > 50) ? (0.5 * (gVal - 50.0) / 50.0) : 0.0;
                double totalScale = Math.Max(0.505, attenGain * attenBright);
                int offset = ch * 256;

                for (int i = 0; i < 256; i++) {
                    double u = i / 255.0;
                    double g = u - 0.5;
                    double curveVal = 0.5 + g + k * g * (0.25 - g * g);
                    curveVal = Math.Max(0.0, Math.Min(1.0, curveVal));

                    if (boostGain > 0.0) {
                        curveVal = Math.Max(0.0, Math.Min(1.0, curveVal + boostGain * curveVal * (1.0 - curveVal)));
                    }
                    if (gammaBright != 1.0) {
                        curveVal = Math.Pow(curveVal, gammaBright);
                    }
                    curveVal *= totalScale;

                    ramp[offset + i] = (ushort)Math.Round(Math.Max(0.0, Math.Min(65535.0, curveVal * 65535.0)));
                }

                // Dual-pass strict monotonicity guard
                for (int i = 1; i < 256; i++) {
                    if (ramp[offset + i] <= ramp[offset + i - 1]) {
                        ramp[offset + i] = (ushort)Math.Min(65535, ramp[offset + i - 1] + 1);
                    }
                }
                for (int i = 254; i >= 0; i--) {
                    if (ramp[offset + i] >= ramp[offset + i + 1]) {
                        ramp[offset + i] = (ushort)Math.Max(0, ramp[offset + i + 1] - 1);
                    }
                }
            }

            return SetDeviceGammaRamp(hdc, ramp);
        } catch {
            return false;
        } finally {
            DeleteDC(hdc);
        }
    }

    public static bool ApplySoftwareBrightness(string gdiDevice, int brightness0to100) {
        if (string.IsNullOrEmpty(gdiDevice)) return false;
        bool isInternal = false;
        lock (SyncLock) {
            for (int i = 0; i < BoundMonitors.Count; i++) {
                if (string.Equals(BoundMonitors[i].gdiDevice, gdiDevice, StringComparison.OrdinalIgnoreCase)) {
                    if (BoundMonitors[i].isInternal) {
                        isInternal = true;
                        BoundMonitors[i].isSoftwareBrightnessActive = true;
                        BoundMonitors[i].softwareBrightnessVal = Math.Max(0, Math.Min(100, brightness0to100));
                    }
                    break;
                }
            }
        }
        if (isInternal) {
            return UpdateInternalGpuRamp(gdiDevice);
        }

        IntPtr hdc = CreateDC(null, gdiDevice, null, IntPtr.Zero);
        if (hdc == IntPtr.Zero) return false;
        try {
            double factor = Math.Max(0.505, 0.52 + 0.48 * (brightness0to100 / 100.0));
            double gamma = (brightness0to100 < 50) ? (1.0 + 0.4 * (50.0 - brightness0to100) / 50.0) : 1.0;
            ushort[] ramp = new ushort[3 * 256];
            for (int i = 0; i < 256; i++) {
                double u = i / 255.0;
                double val = Math.Pow(u, gamma) * factor;
                ushort s = (ushort)Math.Round(Math.Max(0.0, Math.Min(65535.0, val * 65535.0)));
                ramp[i] = s;
                ramp[i + 256] = s;
                ramp[i + 512] = s;
            }
            for (int ch = 0; ch < 3; ch++) {
                int offset = ch * 256;
                for (int i = 1; i < 256; i++) {
                    if (ramp[offset + i] <= ramp[offset + i - 1]) {
                        ramp[offset + i] = (ushort)Math.Min(65535, ramp[offset + i - 1] + 1);
                    }
                }
                for (int i = 254; i >= 0; i--) {
                    if (ramp[offset + i] >= ramp[offset + i + 1]) {
                        ramp[offset + i] = (ushort)Math.Max(0, ramp[offset + i + 1] - 1);
                    }
                }
            }
            return SetDeviceGammaRamp(hdc, ramp);
        } catch {
            return false;
        } finally {
            DeleteDC(hdc);
        }
    }

    public static bool ResetSoftwareGamma(string gdiDevice) {
        if (string.IsNullOrEmpty(gdiDevice)) return false;
        bool isInternal = false;
        lock (SyncLock) {
            for (int i = 0; i < BoundMonitors.Count; i++) {
                if (string.Equals(BoundMonitors[i].gdiDevice, gdiDevice, StringComparison.OrdinalIgnoreCase)) {
                    if (BoundMonitors[i].isInternal) {
                        isInternal = true;
                        BoundMonitors[i].isSoftwareBrightnessActive = false;
                        BoundMonitors[i].softwareBrightnessVal = 100;
                    }
                    break;
                }
            }
        }
        if (isInternal) {
            return UpdateInternalGpuRamp(gdiDevice);
        }

        IntPtr hdc = CreateDC(null, gdiDevice, null, IntPtr.Zero);
        if (hdc == IntPtr.Zero) return false;
        try {
            ushort[] ramp = new ushort[3 * 256];
            for (int i = 0; i < 256; i++) {
                ushort val = (ushort)Math.Round(i * 257.0);
                ramp[i] = val;
                ramp[i + 256] = val;
                ramp[i + 512] = val;
            }
            return SetDeviceGammaRamp(hdc, ramp);
        } catch {
            return false;
        } finally {
            DeleteDC(hdc);
        }
    }

    public class DisplayDeviceItem {
        public string id;
        public string pnpId;
        public string gdiDevice;
        public string name;
        public int windowsDisplayNumber;
        public int width;
        public int height;
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
        public int gameMode;
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
        public int width;
        public int height;
        public bool isInternal;
        public bool isSoftwareBrightnessActive;
        public int softwareBrightnessVal = 100;
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
        public int gamma = -1, darkB = -1, mprt = -1, strobing = -1, od = -1, fs = -1, gameMode = -1, ss = -1, bl = -1;
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
    public static readonly object ProbeLock = new object();

    public static string CacheFilePath = null;
    public static Dictionary<string, DisplayDeviceItem> EmpiricalCache = new Dictionary<string, DisplayDeviceItem>(StringComparer.OrdinalIgnoreCase);

    public static void SaveEmpiricalCache() {
        // Ephemeral runtime: persistent disk cache disabled
    }

    public static void LoadEmpiricalCache(string customJson = null) {
        // Ephemeral runtime: persistent disk cache disabled
    }

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

    public static void BindPhysicalMonitors(Dictionary<string, string> friendlyNames, bool signalWake = false) {
        if (friendlyNames != null && !object.ReferenceEquals(friendlyNames, SavedFriendlyNames)) {
            if (SavedFriendlyNames == null) SavedFriendlyNames = new Dictionary<string, string>();
            foreach (var kvp in friendlyNames) {
                SavedFriendlyNames[kvp.Key] = kvp.Value;
            }
        } else if (SavedFriendlyNames == null) {
            SavedFriendlyNames = new Dictionary<string, string>();
        }

        var activeGdiDevices = new List<string>();
        var monitorHandles = new List<IntPtr>();
        var monitorGdiDevs = new List<string>();
        var monitorPnpIds = new List<string>();
        var monitorWidths = new List<int>();
        var monitorHeights = new List<int>();

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (hMonitor, hdc, lprc, data) => {
            string gdiDev = null;
            int mWidth = 0, mHeight = 0;
            string pnpId = GetMonitorPnpId(hMonitor, out gdiDev, out mWidth, out mHeight);
            monitorHandles.Add(hMonitor);
            monitorGdiDevs.Add(gdiDev);
            monitorPnpIds.Add(pnpId);
            monitorWidths.Add(mWidth);
            monitorHeights.Add(mHeight);
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
        var allocatedSets = new List<PHYSICAL_MONITOR[]>();
        int ddcIndex = 0;
        try {
            ReleaseBoundMonitors();

            for (int mIdx = 0; mIdx < monitorHandles.Count; mIdx++) {
                IntPtr hMonitor = monitorHandles[mIdx];
                string gdiDev = monitorGdiDevs[mIdx];
                string pnpId = monitorPnpIds[mIdx];
                int mWidth = monitorWidths[mIdx];
                int mHeight = monitorHeights[mIdx];

                int winNum = (!string.IsNullOrEmpty(gdiDev) && activeGdiDevices.Contains(gdiDev))
                    ? (activeGdiDevices.IndexOf(gdiDev) + 1)
                    : (ddcIndex + 1);

                // Early internal panel identification (bypasses failing DDC bus transactions)
                bool isInternalMatch = (!string.IsNullOrEmpty(SavedInternalPnpId) && string.Equals(SavedInternalPnpId, pnpId, StringComparison.OrdinalIgnoreCase)) ||
                                       (!string.IsNullOrEmpty(gdiDev) && gdiDev.IndexOf("DISPLAY1", StringComparison.OrdinalIgnoreCase) >= 0);

                byte curLcd = 50;
                if (isInternalMatch && QueryLcdBrightness(out curLcd) == 0) {
                    if (string.IsNullOrEmpty(SavedInternalPnpId) && !string.IsNullOrEmpty(pnpId)) {
                        SavedInternalPnpId = pnpId;
                    }
                    string modelName = null;
                    if (!string.IsNullOrEmpty(pnpId)) {
                        if (SavedFriendlyNames.ContainsKey(pnpId)) {
                            modelName = SavedFriendlyNames[pnpId];
                        } else {
                            modelName = GetMonitorFriendlyNameFromEdid(pnpId);
                            if (!string.IsNullOrEmpty(modelName)) SavedFriendlyNames[pnpId] = modelName;
                        }
                    }
                    if (string.IsNullOrEmpty(modelName)) modelName = "Internal Display";

                    string canonicalId = !string.IsNullOrEmpty(pnpId) ? pnpId : (!string.IsNullOrEmpty(gdiDev) ? gdiDev : "internal");

                    var bound = new BoundPhysicalMonitor();
                    bound.id = canonicalId;
                    bound.hPhys = IntPtr.Zero; // Win32 invariant: internal panels use kernel IOCTL/WMI/DC
                    bound.count = 0;
                    bound.monitors = null;
                    bound.gdiDevice = gdiDev ?? "";
                    bound.pnpId = pnpId ?? "";
                    bound.name = modelName;
                    bound.windowsDisplayNumber = winNum;
                    bound.width = mWidth;
                    bound.height = mHeight;
                    bound.isInternal = true;
                    bound.isSoftwareBrightnessActive = false;
                    bound.initialBrightness = (int)curLcd;
                    boundList.Add(bound);
                    ddcIndex++;
                    continue;
                }

                uint count = 0;
                if (GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count) && count > 0) {
                    var physicalMonitors = new PHYSICAL_MONITOR[count];
                    if (GetPhysicalMonitorsFromHMONITOR(hMonitor, count, physicalMonitors)) {
                        allocatedSets.Add(physicalMonitors);
                        for (int i = 0; i < count; i++) {
                            IntPtr hPhys = physicalMonitors[i].hPhysicalMonitor;

                            string modelName = null;
                            if (!string.IsNullOrEmpty(pnpId)) {
                                if (SavedFriendlyNames.ContainsKey(pnpId)) {
                                    modelName = SavedFriendlyNames[pnpId];
                                } else {
                                    modelName = GetMonitorFriendlyNameFromEdid(pnpId);
                                    if (!string.IsNullOrEmpty(modelName)) SavedFriendlyNames[pnpId] = modelName;
                                }
                            }
                            if (string.IsNullOrEmpty(modelName)) {
                                modelName = "Monitor " + winNum;
                            }

                            string canonicalId = !string.IsNullOrEmpty(pnpId) ? pnpId : (!string.IsNullOrEmpty(gdiDev) ? gdiDev : ("mon_" + ddcIndex));

                            int initBright = -1;
                            for (int c = 0; c < CurrentMonitors.Count; c++) {
                                if (CurrentMonitors[c].id == canonicalId && CurrentMonitors[c].brightness >= 0) {
                                    initBright = CurrentMonitors[c].brightness;
                                    break;
                                }
                            }
                            if (initBright < 0 && EmpiricalCache.ContainsKey(canonicalId)) {
                                initBright = EmpiricalCache[canonicalId].brightness;
                            } else if (initBright < 0 && !string.IsNullOrEmpty(pnpId) && EmpiricalCache.ContainsKey(pnpId)) {
                                initBright = EmpiricalCache[pnpId].brightness;
                            }

                            var bound = new BoundPhysicalMonitor();
                            bound.id = canonicalId;
                            bound.hPhys = hPhys; // Win32 invariant: can legitimately be (IntPtr)0
                            bound.count = count;
                            bound.monitors = physicalMonitors;
                            bound.gdiDevice = gdiDev ?? "";
                            bound.pnpId = pnpId ?? "";
                            bound.name = modelName;
                            bound.windowsDisplayNumber = winNum;
                            bound.width = mWidth;
                            bound.height = mHeight;
                            bound.isInternal = false;
                            bound.isSoftwareBrightnessActive = false;
                            bound.initialBrightness = initBright;
                            boundList.Add(bound);
                            ddcIndex++;
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
                    string intModel = (SavedFriendlyNames != null && !string.IsNullOrEmpty(SavedInternalPnpId) && SavedFriendlyNames.ContainsKey(SavedInternalPnpId))
                        ? SavedFriendlyNames[SavedInternalPnpId] : "Internal Display";
                    string intGdi = (activeGdiDevices.Count > 0 && activeGdiDevices[0].IndexOf("DISPLAY1", StringComparison.OrdinalIgnoreCase) >= 0)
                        ? activeGdiDevices[0] : "\\\\.\\DISPLAY1";
                    int winNum = activeGdiDevices.Contains(intGdi) ? (activeGdiDevices.IndexOf(intGdi) + 1) : 1;
                    int intWidth = (activeGdiDevices.Count > 0 && monitorGdiDevs.Contains(intGdi))
                        ? monitorWidths[monitorGdiDevs.IndexOf(intGdi)] : GetSystemMetrics(0);
                    int intHeight = (activeGdiDevices.Count > 0 && monitorGdiDevs.Contains(intGdi))
                        ? monitorHeights[monitorGdiDevs.IndexOf(intGdi)] : GetSystemMetrics(1);

                    var bound = new BoundPhysicalMonitor();
                    bound.id = intPnp;
                    bound.hPhys = IntPtr.Zero;
                    bound.count = 0;
                    bound.monitors = null;
                    bound.gdiDevice = intGdi;
                    bound.pnpId = intPnp;
                    bound.name = intModel;
                    bound.windowsDisplayNumber = winNum;
                    bound.width = intWidth;
                    bound.height = intHeight;
                    bound.isInternal = true;
                    bound.isSoftwareBrightnessActive = false;
                    bound.initialBrightness = (int)curLcd;
                    boundList.Add(bound);
                }
            }

            boundList.Sort((a, b) => a.windowsDisplayNumber.CompareTo(b.windowsDisplayNumber));

            var initialDevList = new List<DisplayDeviceItem>();
            bool allHaveEmpiricalCache = (boundList.Count > 0);
            for (int i = 0; i < boundList.Count; i++) {
                var b = boundList[i];
                var item = new DisplayDeviceItem();
                item.id = b.id;
                item.pnpId = b.pnpId;
                item.gdiDevice = b.gdiDevice;
                item.name = b.name;
                item.windowsDisplayNumber = b.windowsDisplayNumber;
                item.width = b.width;
                item.height = b.height;
                item.isInternal = b.isInternal;

                DisplayDeviceItem cached = null;
                lock (SyncLock) {
                    if (!string.IsNullOrEmpty(b.id) && EmpiricalCache.ContainsKey(b.id)) cached = EmpiricalCache[b.id];
                    else if (!string.IsNullOrEmpty(b.pnpId) && EmpiricalCache.ContainsKey(b.pnpId)) cached = EmpiricalCache[b.pnpId];
                    else if (!string.IsNullOrEmpty(b.gdiDevice) && EmpiricalCache.ContainsKey(b.gdiDevice)) cached = EmpiricalCache[b.gdiDevice];
                }

                if (cached != null) {
                    item.brightness = (b.initialBrightness >= 0) ? b.initialBrightness : cached.brightness;
                    item.contrast = b.isInternal ? internalContrast : cached.contrast;
                    item.gainR = b.isInternal ? internalGainR : cached.gainR;
                    item.gainG = b.isInternal ? internalGainG : cached.gainG;
                    item.gainB = b.isInternal ? internalGainB : cached.gainB;
                    item.volume = cached.volume;
                    item.inputSource = cached.inputSource;
                    item.colorPreset = cached.colorPreset;
                    item.powerMode = cached.powerMode;
                    item.gamma = cached.gamma;
                    item.blackBoost = cached.blackBoost;
                    item.darkBoost = cached.darkBoost;
                    item.blackLevel = cached.blackLevel;
                    item.overdrive = cached.overdrive;
                    item.strobing = cached.strobing;
                    item.mprt = cached.mprt;
                    item.freeSync = cached.freeSync;
                    item.gameMode = cached.gameMode;
                    item.superSharpness = cached.superSharpness;
                    item.blueLight = cached.blueLight;
                } else {
                    allHaveEmpiricalCache = false;
                    item.brightness = b.isInternal ? b.initialBrightness : -1;
                    item.contrast = b.isInternal ? internalContrast : -1;
                    item.gainR = b.isInternal ? internalGainR : -1;
                    item.gainG = b.isInternal ? internalGainG : -1;
                    item.gainB = b.isInternal ? internalGainB : -1;
                    item.volume = -1;
                    item.inputSource = -1;
                    item.colorPreset = -1;
                    item.powerMode = -1;
                    item.gamma = -1;
                    item.blackBoost = -1;
                    item.darkBoost = -1;
                    item.blackLevel = -1;
                    item.overdrive = -1;
                    item.strobing = -1;
                    item.mprt = -1;
                    item.freeSync = -1;
                    item.gameMode = -1;
                    item.superSharpness = -1;
                    item.blueLight = -1;
                }
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
                        existing.width = initItem.width;
                        existing.height = initItem.height;
                        existing.gdiDevice = initItem.gdiDevice;
                        existing.name = initItem.name;
                        existing.isInternal = initItem.isInternal;
                        if (initItem.isInternal) {
                            existing.brightness = initItem.brightness;
                            existing.contrast = internalContrast;
                            existing.gainR = internalGainR;
                            existing.gainG = internalGainG;
                            existing.gainB = internalGainB;
                        } else if (existing.brightness < 0) {
                            existing.brightness = initItem.brightness;
                        }
                        mergedList.Add(existing);
                    } else {
                        mergedList.Add(initItem);
                    }
                }
                CurrentMonitors = mergedList;
                if (allHaveEmpiricalCache) {
                    HasProbed = true;
                }
                string intGdi = null;
                for (int i = 0; i < boundList.Count; i++) {
                    if (boundList[i].isInternal && !string.IsNullOrEmpty(boundList[i].gdiDevice)) {
                        intGdi = boundList[i].gdiDevice;
                        break;
                    }
                }
                if (!string.IsNullOrEmpty(intGdi)) {
                    UpdateInternalGpuRamp(intGdi);
                }
            }
            if (signalWake) {
                WakeSignal.Set();
            }
        } catch {
            var destroyed = new HashSet<PHYSICAL_MONITOR[]>();
            foreach (var set in allocatedSets) {
                if (set != null && !destroyed.Contains(set)) {
                    destroyed.Add(set);
                    try { DestroyPhysicalMonitors((uint)set.Length, set); } catch {}
                }
            }
            throw;
        }
    }

    public static void ReProbePhysicalMonitors() {
        lock (ProbeLock) {
            try {
                BindPhysicalMonitors(SavedFriendlyNames, false);
            } catch {}
        }
    }

    public static BoundPhysicalMonitor FindBoundMonitor(string monitorId, string pnpId = null, string gdiDevice = null, bool? isInternal = null) {
        lock (SyncLock) {
            if (isInternal.HasValue && isInternal.Value) {
                for (int i = 0; i < BoundMonitors.Count; i++) {
                    if (BoundMonitors[i].isInternal) return BoundMonitors[i];
                }
            }

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

                for (int i = 0; i < BoundMonitors.Count; i++) {
                    if (wantInternal && BoundMonitors[i].isInternal) return BoundMonitors[i];
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
            target = FindBoundMonitor(target.id, target.pnpId, target.gdiDevice, target.isInternal);
            if (target != null) {
                ok = SetVCPFeature(target.hPhys, vcpCode, val);
            }
        }
        return ok;
    }

    public static bool ApplyControl(string monitorId, string control, int val, string pnpId = null, string gdiDevice = null, bool? isInternal = null) {
        BoundPhysicalMonitor target = FindBoundMonitor(monitorId, pnpId, gdiDevice, isInternal);
        if (target == null) {
            ReProbePhysicalMonitors();
            target = FindBoundMonitor(monitorId, pnpId, gdiDevice, isInternal);
        }
        if (target == null && isInternal.HasValue && isInternal.Value) {
            lock (SyncLock) {
                for (int i = 0; i < BoundMonitors.Count; i++) {
                    if (BoundMonitors[i].isInternal) {
                        target = BoundMonitors[i];
                        break;
                    }
                }
            }
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
                        target.isSoftwareBrightnessActive = true;
                        target.softwareBrightnessVal = clamped0to100;
                        ok = UpdateInternalGpuRamp(gdi);
                    } else if (ok) {
                        target.isSoftwareBrightnessActive = false;
                        UpdateInternalGpuRamp(gdi);
                    }
                    if (ok) {
                        lock (SyncLock) {
                            for (int i = 0; i < CurrentMonitors.Count; i++) {
                                if (CurrentMonitors[i].id == targetId || CurrentMonitors[i].isInternal) {
                                    CurrentMonitors[i].brightness = clamped0to100;
                                    break;
                                }
                            }
                        }
                    }
                    return ok;

                case "contrast":
                    internalContrast = clamped0to100;
                    ok = UpdateInternalGpuRamp(gdi);
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == targetId || CurrentMonitors[i].isInternal) {
                                CurrentMonitors[i].contrast = clamped0to100;
                                break;
                            }
                        }
                    }
                    return ok;

                case "gain_r":
                case "gainr":
                    internalGainR = clamped0to100;
                    ok = UpdateInternalGpuRamp(gdi);
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == targetId || CurrentMonitors[i].isInternal) {
                                CurrentMonitors[i].gainR = clamped0to100;
                                break;
                            }
                        }
                    }
                    return ok;

                case "gain_g":
                case "gaing":
                    internalGainG = clamped0to100;
                    ok = UpdateInternalGpuRamp(gdi);
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == targetId || CurrentMonitors[i].isInternal) {
                                CurrentMonitors[i].gainG = clamped0to100;
                                break;
                            }
                        }
                    }
                    return ok;

                case "gain_b":
                case "gainb":
                    internalGainB = clamped0to100;
                    ok = UpdateInternalGpuRamp(gdi);
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == targetId || CurrentMonitors[i].isInternal) {
                                CurrentMonitors[i].gainB = clamped0to100;
                                break;
                            }
                        }
                    }
                    return ok;

                default:
                    return false;
            }
        }

        IntPtr hPhys = target.hPhys;

        switch (control.ToLowerInvariant()) {
            case "brightness":
                ok = SetMonitorBrightness(hPhys, (uint)clamped0to100) || SetVCPFeature(hPhys, 0x10, (uint)clamped0to100);
                if (!ok) {
                    ReProbePhysicalMonitors();
                    target = FindBoundMonitor(targetId, target.pnpId, gdi);
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
                    target = FindBoundMonitor(targetId, target.pnpId, gdi);
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
                    target = FindBoundMonitor(targetId, target.pnpId, gdi);
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
                    target = FindBoundMonitor(targetId, target.pnpId, gdi);
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
                    target = FindBoundMonitor(targetId, target.pnpId, gdi);
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
                    int rG = -1, gG = -1, bG = -1;
                    if (val == 11 || val == 12) {
                        uint pv, cur, mx;
                        IntPtr hp = target.hPhys;
                        if (GetVCPFeatureAndVCPFeatureReply(hp, 0x16, out pv, out cur, out mx)) rG = (int)cur;
                        if (GetVCPFeatureAndVCPFeatureReply(hp, 0x18, out pv, out cur, out mx)) gG = (int)cur;
                        if (GetVCPFeatureAndVCPFeatureReply(hp, 0x1A, out pv, out cur, out mx)) bG = (int)cur;
                    }
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) {
                                CurrentMonitors[i].colorPreset = val;
                                if (rG >= 0) CurrentMonitors[i].gainR = rG;
                                if (gG >= 0) CurrentMonitors[i].gainG = gG;
                                if (bG >= 0) CurrentMonitors[i].gainB = bG;
                                break;
                            }
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
                ok = WriteVcpWithRetry(ref target, 0xE8, (uint)val);
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
                ok = WriteVcpWithRetry(ref target, 0xE5, (uint)val);
                if (!ok) {
                    ok = WriteVcpWithRetry(ref target, 0xEF, (uint)val);
                }
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
                ok = WriteVcpWithRetry(ref target, 0xEA, (uint)val);
                if (!ok) {
                    ok = WriteVcpWithRetry(ref target, 0xE0, (uint)val);
                }
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].freeSync = val; break; }
                        }
                    }
                }
                return ok;

            case "gamemode":
                ok = WriteVcpWithRetry(ref target, 0xF9, (uint)val);
                if (ok && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].gameMode = val; break; }
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
        var extThreads = new List<Thread>();

        // Unified Parallel Empirical Probe (UI controls only: zero Stage 1/Stage 2 partial reveals)
        for (int i = 0; i < snapshot.Count; i++) {
            int idx = i;
            var bound = snapshot[idx];
            var u = new TelemetryUpdateItem();
            u.id = bound.id;
            u.isInternal = bound.isInternal;
            if (bound.isInternal && bound.initialBrightness >= 0) {
                u.curLcd = (byte)bound.initialBrightness;
            }
            updates[idx] = u;

            if (bound.isInternal) {
                Thread intT = new Thread(() => {
                    byte curLcd = u.curLcd > 0 ? u.curLcd : (byte)50;
                    if (QueryLcdBrightness(out curLcd) == 0) {
                        u.curLcd = curLcd;
                    }
                });
                intT.IsBackground = true;
                intT.Start();
                extThreads.Add(intT);
                continue;
            }

            Thread extT = new Thread(() => {
                IntPtr hPhys = bound.hPhys;
                uint pvct = 0, vCur = 0, vMax = 0, hlMin = 0, hlCur = 0, hlMax = 0;
                bool hasBright = false; uint brightCur = 0, brightMax = 0;
                bool hasContrast = false; uint contrastCur = 0, contrastMax = 0;
                bool hasPreset = false; uint presetCur = 0, presetMax = 0;
                bool hasPrev = false; uint prevCur = 0, prevMax = 0;

                // 1. Empirical Brightness (Direct VCP 0x10 first for minimal latency, HL fallback)
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x10, out pvct, out vCur, out vMax)) {
                    u.brightVal = (int)vCur;
                    hasBright = true; brightCur = vCur; brightMax = vMax;
                    hasPrev = true; prevCur = vCur; prevMax = vMax;
                } else if (GetMonitorBrightness(hPhys, out hlMin, out hlCur, out hlMax)) {
                    u.brightVal = (int)hlCur;
                    hasBright = true; brightCur = hlCur; brightMax = hlMax;
                    hasPrev = true; prevCur = hlCur; prevMax = hlMax;
                }

                // 2. Empirical Contrast (Direct VCP 0x12 first, HL fallback)
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x12, out pvct, out vCur, out vMax)) {
                    u.contrastVal = (int)vCur;
                    hasContrast = true; contrastCur = vCur; contrastMax = vMax;
                    hasPrev = true; prevCur = vCur; prevMax = vMax;
                } else if (GetMonitorContrast(hPhys, out hlMin, out hlCur, out hlMax)) {
                    u.contrastVal = (int)hlCur;
                    hasContrast = true; contrastCur = hlCur; contrastMax = hlMax;
                    hasPrev = true; prevCur = hlCur; prevMax = hlMax;
                }

                // 3. Empirical Color Preset (VCP 0x14)
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x14, out pvct, out vCur, out vMax)) {
                    u.preset = (int)vCur;
                    hasPreset = true; presetCur = vCur; presetMax = vMax;
                    hasPrev = true; prevCur = vCur; prevMax = vMax;
                }

                // 4. Empirical RGB Gains when User/Custom mode active (or preset unavailable)
                if (u.preset == 11 || u.preset == 12 || u.preset < 0) {
                    if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x16, out pvct, out vCur, out vMax)) {
                        u.rGain = (int)vCur;
                        hasPrev = true; prevCur = vCur; prevMax = vMax;
                    } else if (GetMonitorRedGreenOrBlueGain(hPhys, 0, out hlMin, out hlCur, out hlMax)) {
                        u.rGain = (int)hlCur;
                        hasPrev = true; prevCur = hlCur; prevMax = hlMax;
                    }

                    if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x18, out pvct, out vCur, out vMax)) {
                        u.gGain = (int)vCur;
                        hasPrev = true; prevCur = vCur; prevMax = vMax;
                    } else if (GetMonitorRedGreenOrBlueGain(hPhys, 1, out hlMin, out hlCur, out hlMax)) {
                        u.gGain = (int)hlCur;
                        hasPrev = true; prevCur = hlCur; prevMax = hlMax;
                    }

                    if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x1A, out pvct, out vCur, out vMax)) {
                        u.bGain = (int)vCur;
                        hasPrev = true; prevCur = vCur; prevMax = vMax;
                    } else if (GetMonitorRedGreenOrBlueGain(hPhys, 2, out hlMin, out hlCur, out hlMax)) {
                        u.bGain = (int)hlCur;
                        hasPrev = true; prevCur = hlCur; prevMax = hlMax;
                    }
                }

                // Helper to detect firmware leaving the prior DDC reply buffer untouched (e.g. ACR10B0)
                Func<byte, int> readVerifiedVcp = (code) => {
                    uint rPvct = 0, rCur = 0, rMax = 0;
                    if (!GetVCPFeatureAndVCPFeatureReply(hPhys, code, out rPvct, out rCur, out rMax)) {
                        return -1;
                    }
                    if (hasPrev && rCur == prevCur && rMax == prevMax) {
                        byte probeCode = 0;
                        if (hasContrast && !(prevCur == contrastCur && prevMax == contrastMax)) {
                            probeCode = 0x12;
                        } else if (hasBright && !(prevCur == brightCur && prevMax == brightMax)) {
                            probeCode = 0x10;
                        } else if (hasPreset && !(prevCur == presetCur && prevMax == presetMax)) {
                            probeCode = 0x14;
                        }
                        if (probeCode != 0) {
                            uint pPvct = 0, pCur = 0, pMax = 0;
                            if (GetVCPFeatureAndVCPFeatureReply(hPhys, probeCode, out pPvct, out pCur, out pMax)) {
                                uint vPvct = 0, v2Cur = 0, v2Max = 0;
                                if (!GetVCPFeatureAndVCPFeatureReply(hPhys, code, out vPvct, out v2Cur, out v2Max)) {
                                    prevCur = pCur; prevMax = pMax;
                                    return -1;
                                }
                                if (v2Cur == pCur && v2Max == pMax) {
                                    prevCur = pCur; prevMax = pMax;
                                    return -1;
                                }
                                rCur = v2Cur; rMax = v2Max;
                            }
                        }
                    }
                    hasPrev = true; prevCur = rCur; prevMax = rMax;
                    return (int)rCur;
                };

                // 5. UI Secondary Controls (Input Source, Overdrive, Strobing/VRB, FreeSync/VRR)
                int inputVal = readVerifiedVcp(0x60);
                if (inputVal >= 0) {
                    u.input = inputVal;
                }

                int odVal = readVerifiedVcp(0xE8);
                if (odVal >= 0) {
                    u.od = odVal;
                }

                int strVal = readVerifiedVcp(0xE5);
                if (strVal < 0) {
                    strVal = readVerifiedVcp(0xEF);
                }
                if (strVal >= 0) {
                    u.strobing = strVal;
                    u.mprt = strVal;
                }

                int fsVal = readVerifiedVcp(0xEA);
                if (fsVal >= 0) {
                    u.fs = fsVal;
                }
            });
            extT.IsBackground = true;
            extT.Start();
            extThreads.Add(extT);
        }

        for (int i = 0; i < extThreads.Count; i++) {
            try { extThreads[i].Join(); } catch {}
        }

        // Ensure PDH (RAPL/Page/iGPU) and NVML background initializers have settled before marking initial Frame ready
        try { PdhHost.ReadyEvent.WaitOne(); } catch {}
        try { NvmlHost.ReadyEvent.WaitOne(); } catch {}

        lock (SyncLock) {
            for (int i = 0; i < updates.Length; i++) {
                var u = updates[i];
                if (u == null || u.id == null) continue;
                for (int j = 0; j < CurrentMonitors.Count; j++) {
                    if (CurrentMonitors[j].id == u.id || (u.isInternal && CurrentMonitors[j].isInternal)) {
                        if (u.isInternal) {
                            CurrentMonitors[j].brightness = u.curLcd;
                            CurrentMonitors[j].contrast = internalContrast;
                            CurrentMonitors[j].gainR = internalGainR;
                            CurrentMonitors[j].gainG = internalGainG;
                            CurrentMonitors[j].gainB = internalGainB;
                        } else {
                            CurrentMonitors[j].brightness = u.brightVal;
                            CurrentMonitors[j].contrast = u.contrastVal;
                            CurrentMonitors[j].gainR = u.rGain;
                            CurrentMonitors[j].gainG = u.gGain;
                            CurrentMonitors[j].gainB = u.bGain;
                            CurrentMonitors[j].colorPreset = u.preset;
                            CurrentMonitors[j].inputSource = u.input;
                            CurrentMonitors[j].overdrive = u.od;
                            CurrentMonitors[j].strobing = u.strobing;
                            CurrentMonitors[j].mprt = u.mprt;
                            CurrentMonitors[j].freeSync = u.fs;
                        }
                        break;
                    }
                }
            }
            if (PendingProbeId > CompletedProbeId) {
                CompletedProbeId = PendingProbeId;
            }
            HasProbed = true;
            SaveEmpiricalCache();
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
                while (IsRunning) {
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
                            lock (ProbeLock) {
                                if (!IsRunning) break;
                                BindPhysicalMonitors(friendlyNames ?? SavedFriendlyNames, false);
                            }
                        }
                        if (!IsRunning) break;
                        ReadTelemetryFeatures(friendlyNames ?? SavedFriendlyNames);
                    } catch {}

                    lock (SyncLock) {
                        int highestPending = PendingProbeId;
                        if (highestPending > CompletedProbeId) {
                            CompletedProbeId = highestPending;
                        } else if (targetProbeId > CompletedProbeId) {
                            CompletedProbeId = targetProbeId;
                        }
                        HasProbed = true;
                        if (!ForceRebindPending || !IsRunning) {
                            ProbePending = false;
                            IsProbing = false;
                            break;
                        }
                    }
                }
            } finally {
                lock (SyncLock) {
                    IsProbing = false;
                    HasProbed = true;
                }
            }
        });
        probeThread.IsBackground = true;
        probeThread.Name = "EmpiricalMonitorProbeWorker";
        probeThread.Start();
    }

    public static void StartWorker(Dictionary<string, string> friendlyNames) {
        Thread thread = new Thread(() => {
            try {
                Stream stdin = Console.OpenStandardInput();
                byte[] lenBuf = new byte[4];
                bool isFirstPacket = true;
                while (IsRunning) {
                    int read = 0;
                    while (read < 4) {
                        int r = stdin.Read(lenBuf, read, 4 - read);
                        if (r <= 0) return;
                        read += r;
                    }
                    if (isFirstPacket && lenBuf[0] == 0xEF && lenBuf[1] == 0xBB && lenBuf[2] == 0xBF) {
                        lenBuf[0] = lenBuf[3];
                        read = 1;
                        while (read < 4) {
                            int r = stdin.Read(lenBuf, read, 4 - read);
                            if (r <= 0) return;
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
                        if (r <= 0) return;
                        read += r;
                    }
                    string json = Encoding.UTF8.GetString(jsonBuf);

                    string action = ExtractJsonString(json, "action");
                    if (action == "init_internal_display" || action == "set_internal_calibration") {
                        int c = ExtractJsonInt(json, "contrast", -1);
                        int r = ExtractJsonInt(json, "gainR", -1);
                        if (r < 0) r = ExtractJsonInt(json, "gain_r", -1);
                        int g = ExtractJsonInt(json, "gainG", -1);
                        if (g < 0) g = ExtractJsonInt(json, "gain_g", -1);
                        int b = ExtractJsonInt(json, "gainB", -1);
                        if (b < 0) b = ExtractJsonInt(json, "gain_b", -1);
                        SetInternalDisplayCalibration(c, r, g, b);
                    } else if (action == "set_panel_control") {
                        string monId = ExtractJsonString(json, "monitorId");
                        string pnpId = ExtractJsonString(json, "pnpId");
                        string gdiDev = ExtractJsonString(json, "gdiDevice");
                        string control = ExtractJsonString(json, "control");
                        int val = ExtractJsonInt(json, "value", 0);
                        bool isInt = ExtractJsonBool(json, "isInternal", false);
                        if (!string.IsNullOrEmpty(control)) {
                            if (ApplyControl(monId, control, val, pnpId, gdiDev, isInt)) {
                                SaveEmpiricalCache();
                            }
                        }
                    } else if (action == "set_brightness") {
                        string monId = ExtractJsonString(json, "monitorId");
                        string pnpId = ExtractJsonString(json, "pnpId");
                        string gdiDev = ExtractJsonString(json, "gdiDevice");
                        int val = ExtractJsonInt(json, "value", 50);
                        if (ApplyControl(monId, "brightness", val, pnpId, gdiDev)) {
                            SaveEmpiricalCache();
                        }
                    } else if (action == "init_cached_monitors") {
                        LoadEmpiricalCache(json);
                        lock (SyncLock) {
                            for (int i = 0; i < CurrentMonitors.Count; i++) {
                                var m = CurrentMonitors[i];
                                DisplayDeviceItem cached = null;
                                if (!string.IsNullOrEmpty(m.id) && EmpiricalCache.ContainsKey(m.id)) cached = EmpiricalCache[m.id];
                                else if (!string.IsNullOrEmpty(m.pnpId) && EmpiricalCache.ContainsKey(m.pnpId)) cached = EmpiricalCache[m.pnpId];
                                else if (!string.IsNullOrEmpty(m.gdiDevice) && EmpiricalCache.ContainsKey(m.gdiDevice)) cached = EmpiricalCache[m.gdiDevice];
                                if (cached != null) {
                                    if (cached.contrast >= 0 && !m.isInternal) m.contrast = cached.contrast;
                                    if (cached.gainR >= 0 && !m.isInternal) m.gainR = cached.gainR;
                                    if (cached.gainG >= 0 && !m.isInternal) m.gainG = cached.gainG;
                                    if (cached.gainB >= 0 && !m.isInternal) m.gainB = cached.gainB;
                                    if (cached.volume >= 0 || cached.volume == -1) m.volume = cached.volume;
                                    if (cached.inputSource >= 0) m.inputSource = cached.inputSource;
                                    if (cached.colorPreset >= 0) m.colorPreset = cached.colorPreset;
                                    if (cached.powerMode >= 0) m.powerMode = cached.powerMode;
                                    if (cached.gamma >= 0) m.gamma = cached.gamma;
                                    if (cached.blackBoost >= 0) m.blackBoost = cached.blackBoost;
                                    if (cached.darkBoost >= 0) m.darkBoost = cached.darkBoost;
                                    if (cached.blackLevel >= 0) m.blackLevel = cached.blackLevel;
                                    if (cached.overdrive >= 0) m.overdrive = cached.overdrive;
                                    if (cached.strobing >= 0) m.strobing = cached.strobing;
                                    if (cached.mprt >= 0) m.mprt = cached.mprt;
                                    if (cached.freeSync >= 0) m.freeSync = cached.freeSync;
                                    if (cached.gameMode >= 0) m.gameMode = cached.gameMode;
                                    if (cached.superSharpness >= 0) m.superSharpness = cached.superSharpness;
                                    if (cached.blueLight >= 0) m.blueLight = cached.blueLight;
                                }
                            }
                            if (CurrentMonitors.Count > 0) {
                                HasProbed = true;
                            }
                        }
                        WakeSignal.Set();
                    } else if (action == "wake" || action == "poll_now") {
                        WakeSignal.Set();
                    } else if (action == "probe_monitors" || action == "refresh_monitors" || action == "fetch_empirical") {
                        int c = ExtractJsonInt(json, "contrast", -1);
                        int r = ExtractJsonInt(json, "gainR", -1);
                        if (r < 0) r = ExtractJsonInt(json, "gain_r", -1);
                        int g = ExtractJsonInt(json, "gainG", -1);
                        if (g < 0) g = ExtractJsonInt(json, "gain_g", -1);
                        int b = ExtractJsonInt(json, "gainB", -1);
                        if (b < 0) b = ExtractJsonInt(json, "gain_b", -1);
                        if (c >= 0 || r >= 0 || g >= 0 || b >= 0) {
                            SetInternalDisplayCalibration(c, r, g, b);
                        }
                        int probeId = ExtractJsonInt(json, "probeId", 0);
                        bool isRefresh = (action == "refresh_monitors");
                        RequestEmpiricalProbe(probeId, isRefresh);
                    }
                }
            } catch {}
            finally {
                IsRunning = false;
                WakeSignal.Set();
            }
        });
        thread.IsBackground = true;
        thread.Name = "MonitorBackgroundWorker";
        thread.Start();

        RequestEmpiricalProbe(0, false, friendlyNames);
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

    public static bool ExtractJsonBool(string json, string key, bool defaultVal) {
        if (string.IsNullOrEmpty(json)) return defaultVal;
        string search = "\"" + key + "\"";
        int idx = json.IndexOf(search);
        if (idx < 0) return defaultVal;
        int colon = json.IndexOf(':', idx + search.Length);
        if (colon < 0) return defaultVal;
        int start = colon + 1;
        while (start < json.Length && (json[start] == ' ' || json[start] == '\t' || json[start] == '\r' || json[start] == '\n')) start++;
        if (start + 4 <= json.Length && json.Substring(start, 4).Equals("true", StringComparison.OrdinalIgnoreCase)) return true;
        if (start + 5 <= json.Length && json.Substring(start, 5).Equals("false", StringComparison.OrdinalIgnoreCase)) return false;
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
                    sb.Append("\"width\":").Append(m.width).Append(',');
                    sb.Append("\"height\":").Append(m.height).Append(',');
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
                    sb.Append("\"gameMode\":").Append(m.gameMode).Append(',');
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
            Add-Type -TypeDefinition $csharpDef -IgnoreWarnings -ErrorAction SilentlyContinue
        }
    }

    [MonitorController]::GetInstantCpuLoad() | Out-Null

    $hasNvmlDll = Test-Path "$env:SystemRoot\System32\nvml.dll"
    if ($hasNvmlDll) {
        [NvmlHost]::StartInitAsync()
    } else {
        [NvmlHost]::ReadyEvent.Set() | Out-Null
    }
    [PdhHost]::StartInitAsync()

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

    # Ephemeral runtime: persistent disk cache disabled

    [MonitorController]::StartWorker($friendlyNames)

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

    $nvmlUtil = $null
    $nvmlMem = $null

    $warmupTicks = 0
    $isGamingLoad = $false
    $loadStreak = 0
    $idleStreak = 0
    while ([MonitorController]::IsRunning) {
        # Instant watchdog check via native kernel handle (locks PID, zero process-table scanning)
        if ($parentObj -and $parentObj.HasExited) {
            [MonitorController]::IsRunning = $false
            break
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
                $hwThermalStr = if (($throttleMask -band 0x60) -ne 0) { "Active" } else { "Not Active" }
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

        # 3. Query native PDH counters (RAPL CPU/iGPU power, Paging %, GPU Shared Memory) in <1ms
        if ([PdhHost]::IsReady) {
            [double]$pkgW = 0.0
            [double]$pp1W = 0.0
            [double]$pPct = 0.0
            [double]$shMb = 0.0
            [PdhHost]::Sample([ref]$pkgW, [ref]$pp1W, [ref]$pPct, [ref]$shMb)
            if ($pkgW -gt 0.0) { $cpuPower = $pkgW }
            $igpuPower = $pp1W
            $pagePct = $pPct
            $pageUsedGB = [math]::Round(($pagePct / 100.0) * $totalPageGB, 1)
            if ($shMb -gt 0.0) { $igpuSharedMB = $shMb }
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

        # Dual-Threshold Hysteresis for Load Cadence
        # Gaming / heavy load: sustained GPU load (>= 20%), active GPU draw (>= 35W), or high CPU power (>= 45W)
        # Idle return: low GPU load (<= 5%), low GPU draw (<= 20W), and low CPU power (<= 25W)
        $instantLoad = ($gpuLoad -ge 20) -or ($rawGpuWatt -ge 35.0) -or ($cpuPower -ge 45.0)
        $instantIdle = ($gpuLoad -le 5) -and ($rawGpuWatt -le 20.0) -and ($cpuPower -le 25.0)

        if ($instantLoad) {
            $loadStreak++
            $idleStreak = 0
            if ($loadStreak -ge 2) {
                $isGamingLoad = $true
            }
        } elseif ($instantIdle) {
            $idleStreak++
            $loadStreak = 0
            if ($idleStreak -ge 3) {
                $isGamingLoad = $false
            }
        } else {
            # Hysteresis deadband: hold current state to prevent cadence hunting
            $loadStreak = 0
            $idleStreak = 0
        }

        # While initial unified empirical probe is running, wait cleanly on WakeSignal instead of spamming 200ms ticks.
        # Once probed, run 800ms under verified sustained load or 1800ms solid desktop idle cadence.
        $sleepInterval = if (-not [MonitorController]::HasProbed) { 1800 } elseif ($isGamingLoad) { 800 } else { 1800 }
        [MonitorController]::WakeSignal.WaitOne($sleepInterval) | Out-Null
    }
}
catch {
    exit 0
}
finally {
    [MonitorController]::IsRunning = $false
    try { [MonitorController]::ReleaseBoundMonitors() } catch {}
    try { [PdhHost]::Shutdown() } catch {}
    if ($parentObj) { try { $parentObj.Dispose() } catch {} }
    if ([NvmlHost]::IsReady) {
        try { [NvmlHost]::Shutdown() | Out-Null } catch {}
    }
}
