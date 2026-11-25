using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

public static class NvmlHost {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr LoadLibrary(string lpFileName);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

    public delegate int NvmlInitDelegate();
    public delegate int NvmlShutdownDelegate();
    public delegate int NvmlDeviceGetHandleByIndexDelegate(uint index, out IntPtr device);
    public delegate int NvmlDeviceGetTemperatureDelegate(IntPtr device, uint sensorType, out uint temp);
    public delegate int NvmlDeviceGetPowerUsageDelegate(IntPtr device, out uint power);
    public delegate int NvmlDeviceGetUtilizationRatesDelegate(IntPtr device, out NvmlUtilization utilization);
    public delegate int NvmlDeviceGetMemoryInfoDelegate(IntPtr device, out NvmlMemory memory);
    public delegate int NvmlDeviceGetClockInfoDelegate(IntPtr device, uint clockType, out uint clock);
    public delegate int NvmlDeviceGetPerformanceStateDelegate(IntPtr device, out uint pState);
    public delegate int NvmlDeviceGetCurrentClocksThrottleReasonsDelegate(IntPtr device, out ulong clocksThrottleReasons);

    [StructLayout(LayoutKind.Sequential)]
    public struct NvmlUtilization {
        public uint gpu;
        public uint memory;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NvmlMemory {
        public ulong total;
        public ulong free;
        public ulong used;
    }

    public static NvmlInitDelegate Init;
    public static NvmlShutdownDelegate Shutdown;
    public static NvmlDeviceGetHandleByIndexDelegate GetHandleByIndex;
    public static NvmlDeviceGetTemperatureDelegate GetTemperature;
    public static NvmlDeviceGetPowerUsageDelegate GetPowerUsage;
    public static NvmlDeviceGetUtilizationRatesDelegate GetUtilizationRates;
    public static NvmlDeviceGetMemoryInfoDelegate GetMemoryInfo;
    public static NvmlDeviceGetClockInfoDelegate GetClockInfo;
    public static NvmlDeviceGetPerformanceStateDelegate GetPerformanceState;
    public static NvmlDeviceGetCurrentClocksThrottleReasonsDelegate GetClocksThrottleReasons;

    public static volatile bool IsReady = false;
    public static IntPtr DeviceHandle = IntPtr.Zero;
    public static readonly ManualResetEvent ReadyEvent = new ManualResetEvent(false);

    public static void StartInitAsync() {
        Thread t = new Thread(() => {
            try {
                IntPtr hMod = LoadLibrary("nvml.dll");
                if (hMod != IntPtr.Zero) {
                    IntPtr pInit = GetProcAddress(hMod, "nvmlInit_v2");
                    if (pInit == IntPtr.Zero) pInit = GetProcAddress(hMod, "nvmlInit");
                    if (pInit != IntPtr.Zero) {
                        Init = (NvmlInitDelegate)Marshal.GetDelegateForFunctionPointer(pInit, typeof(NvmlInitDelegate));
                        Shutdown = (NvmlShutdownDelegate)Marshal.GetDelegateForFunctionPointer(GetProcAddress(hMod, "nvmlShutdown"), typeof(NvmlShutdownDelegate));
                        IntPtr pHandle = GetProcAddress(hMod, "nvmlDeviceGetHandleByIndex_v2");
                        if (pHandle == IntPtr.Zero) pHandle = GetProcAddress(hMod, "nvmlDeviceGetHandleByIndex");
                        GetHandleByIndex = (NvmlDeviceGetHandleByIndexDelegate)Marshal.GetDelegateForFunctionPointer(pHandle, typeof(NvmlDeviceGetHandleByIndexDelegate));
                        GetTemperature = (NvmlDeviceGetTemperatureDelegate)Marshal.GetDelegateForFunctionPointer(GetProcAddress(hMod, "nvmlDeviceGetTemperature"), typeof(NvmlDeviceGetTemperatureDelegate));
                        GetPowerUsage = (NvmlDeviceGetPowerUsageDelegate)Marshal.GetDelegateForFunctionPointer(GetProcAddress(hMod, "nvmlDeviceGetPowerUsage"), typeof(NvmlDeviceGetPowerUsageDelegate));
                        GetUtilizationRates = (NvmlDeviceGetUtilizationRatesDelegate)Marshal.GetDelegateForFunctionPointer(GetProcAddress(hMod, "nvmlDeviceGetUtilizationRates"), typeof(NvmlDeviceGetUtilizationRatesDelegate));
                        GetMemoryInfo = (NvmlDeviceGetMemoryInfoDelegate)Marshal.GetDelegateForFunctionPointer(GetProcAddress(hMod, "nvmlDeviceGetMemoryInfo"), typeof(NvmlDeviceGetMemoryInfoDelegate));
                        GetClockInfo = (NvmlDeviceGetClockInfoDelegate)Marshal.GetDelegateForFunctionPointer(GetProcAddress(hMod, "nvmlDeviceGetClockInfo"), typeof(NvmlDeviceGetClockInfoDelegate));
                        GetPerformanceState = (NvmlDeviceGetPerformanceStateDelegate)Marshal.GetDelegateForFunctionPointer(GetProcAddress(hMod, "nvmlDeviceGetPerformanceState"), typeof(NvmlDeviceGetPerformanceStateDelegate));
                        IntPtr pThrottle = GetProcAddress(hMod, "nvmlDeviceGetCurrentClocksThrottleReasons");
                        if (pThrottle != IntPtr.Zero) {
                            GetClocksThrottleReasons = (NvmlDeviceGetCurrentClocksThrottleReasonsDelegate)Marshal.GetDelegateForFunctionPointer(pThrottle, typeof(NvmlDeviceGetCurrentClocksThrottleReasonsDelegate));
                        }
                        if (Init != null && Init() == 0 && GetHandleByIndex != null && GetHandleByIndex(0, out DeviceHandle) == 0) {
                            IsReady = true;
                        }
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

public static class EmiHost {
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SetupDiGetClassDevs(ref Guid ClassGuid, IntPtr Enumerator, IntPtr hwndParent, uint Flags);

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetupDiEnumDeviceInterfaces(IntPtr DeviceInfoSet, IntPtr DeviceInfoData, ref Guid InterfaceClassGuid, uint MemberIndex, ref SP_DEVICE_INTERFACE_DATA DeviceInterfaceData);

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr DeviceInfoSet, ref SP_DEVICE_INTERFACE_DATA DeviceInterfaceData, IntPtr DeviceInterfaceDetailData, uint DeviceInterfaceDetailDataSize, out uint RequiredSize, IntPtr DeviceInfoData);

    [DllImport("setupapi.dll")]
    public static extern bool SetupDiDestroyDeviceInfoList(IntPtr DeviceInfoSet);

    [StructLayout(LayoutKind.Sequential)]
    public struct SP_DEVICE_INTERFACE_DATA {
        public uint cbSize;
        public Guid InterfaceClassGuid;
        public uint Flags;
        public IntPtr Reserved;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DeviceIoControl(IntPtr hDevice, uint dwIoControlCode, IntPtr lpInBuffer, uint nInBufferSize, IntPtr lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);

    private const uint IOCTL_EMI_GET_VERSION = 0x224000u;
    private const uint IOCTL_EMI_GET_METADATA_SIZE = 0x224004u;
    private const uint IOCTL_EMI_GET_METADATA = 0x224008u;
    private const uint IOCTL_EMI_GET_MEASUREMENT = 0x22400Cu;
    private const double PICOWATT_HOURS_PER_100NS_TO_WATTS = 0.036;

    public static volatile bool IsReady = false;
    public static readonly ManualResetEvent ReadyEvent = new ManualResetEvent(false);
    private static readonly object EmiLock = new object();
    private static IntPtr DeviceHandle = (IntPtr)(-1);
    private static IntPtr MeasBuffer = IntPtr.Zero;
    private static int ChannelCount = 0;
    private static int PkgChannel = -1;
    private static int Pp1Channel = -1;
    private static ulong PrevPkgEnergy = 0;
    private static ulong PrevPkgTime = 0;
    private static ulong PrevPp1Energy = 0;
    private static ulong PrevPp1Time = 0;

    public static void StartInitAsync() {
        Thread t = new Thread(() => {
            IntPtr devInfo = (IntPtr)(-1);
            try {
                Guid emiGuid = new Guid("45BD8344-7ED6-49CF-A440-C276C933B053");
                devInfo = SetupDiGetClassDevs(ref emiGuid, IntPtr.Zero, IntPtr.Zero, 0x12);
                if (devInfo != IntPtr.Zero && devInfo != (IntPtr)(-1)) {
                    SP_DEVICE_INTERFACE_DATA did = new SP_DEVICE_INTERFACE_DATA();
                    did.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA));
                    for (uint idx = 0; SetupDiEnumDeviceInterfaces(devInfo, IntPtr.Zero, ref emiGuid, idx, ref did); idx++) {
                        uint req = 0;
                        SetupDiGetDeviceInterfaceDetail(devInfo, ref did, IntPtr.Zero, 0, out req, IntPtr.Zero);
                        if (req == 0) continue;
                        IntPtr detBuf = Marshal.AllocHGlobal((int)req);
                        string devPath = null;
                        try {
                            Marshal.WriteInt32(detBuf, IntPtr.Size == 8 ? 8 : 6);
                            if (SetupDiGetDeviceInterfaceDetail(devInfo, ref did, detBuf, req, out req, IntPtr.Zero)) {
                                devPath = Marshal.PtrToStringUni(IntPtr.Add(detBuf, 4));
                            }
                        } finally {
                            Marshal.FreeHGlobal(detBuf);
                        }
                        if (string.IsNullOrEmpty(devPath)) continue;

                        IntPtr hEmi = CreateFile(devPath, 0x80000000u, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
                        if (hEmi == (IntPtr)(-1)) continue;

                        bool accepted = false;
                        IntPtr vBuf = Marshal.AllocHGlobal(64);
                        try {
                            uint bRet = 0;
                            if (DeviceIoControl(hEmi, IOCTL_EMI_GET_VERSION, IntPtr.Zero, 0, vBuf, 64, out bRet, IntPtr.Zero) && bRet >= 2) {
                                int ver = Marshal.ReadInt16(vBuf, 0);
                                if (ver == 2 && DeviceIoControl(hEmi, IOCTL_EMI_GET_METADATA_SIZE, IntPtr.Zero, 0, vBuf, 64, out bRet, IntPtr.Zero) && bRet >= 4) {
                                    int mSize = Marshal.ReadInt32(vBuf, 0);
                                    if (mSize >= 68) {
                                        IntPtr mBuf = Marshal.AllocHGlobal(mSize);
                                        try {
                                            if (DeviceIoControl(hEmi, IOCTL_EMI_GET_METADATA, IntPtr.Zero, 0, mBuf, (uint)mSize, out bRet, IntPtr.Zero) && bRet >= 68) {
                                                int chCount = (ushort)Marshal.ReadInt16(mBuf, 66);
                                                int pkgIdx = -1, pp1Idx = -1;
                                                int off = 68;
                                                for (int i = 0; i < chCount && off + 6 <= (int)bRet; i++) {
                                                    int unit = Marshal.ReadInt32(mBuf, off);
                                                    int nSize = (ushort)Marshal.ReadInt16(mBuf, off + 4);
                                                    if (off + 6 + nSize <= (int)bRet && nSize > 0 && unit == 0) {
                                                        string chName = Marshal.PtrToStringUni(IntPtr.Add(mBuf, off + 6), nSize / 2).TrimEnd('\0');
                                                        if (chName == "RAPL_Package0_PKG") pkgIdx = i;
                                                        else if (chName == "RAPL_Package0_PP1") pp1Idx = i;
                                                    }
                                                    off += 6 + nSize;
                                                }
                                                if (pkgIdx >= 0 || pp1Idx >= 0) {
                                                    IntPtr mData = Marshal.AllocHGlobal(chCount * 16);
                                                    uint measBytes = 0;
                                                    if (DeviceIoControl(hEmi, IOCTL_EMI_GET_MEASUREMENT, IntPtr.Zero, 0, mData, (uint)(chCount * 16), out measBytes, IntPtr.Zero) && measBytes >= (uint)(chCount * 16)) {
                                                        lock (EmiLock) {
                                                            DeviceHandle = hEmi;
                                                            ChannelCount = chCount;
                                                            PkgChannel = pkgIdx;
                                                            Pp1Channel = pp1Idx;
                                                            MeasBuffer = mData;
                                                            if (pkgIdx >= 0) {
                                                                PrevPkgEnergy = (ulong)Marshal.ReadInt64(mData, pkgIdx * 16);
                                                                PrevPkgTime = (ulong)Marshal.ReadInt64(mData, pkgIdx * 16 + 8);
                                                            }
                                                            if (pp1Idx >= 0) {
                                                                PrevPp1Energy = (ulong)Marshal.ReadInt64(mData, pp1Idx * 16);
                                                                PrevPp1Time = (ulong)Marshal.ReadInt64(mData, pp1Idx * 16 + 8);
                                                            }
                                                            IsReady = true;
                                                        }
                                                        accepted = true;
                                                        break;
                                                    } else {
                                                        Marshal.FreeHGlobal(mData);
                                                    }
                                                }
                                            }
                                        } finally {
                                            Marshal.FreeHGlobal(mBuf);
                                        }
                                    }
                                }
                            }
                        } finally {
                            Marshal.FreeHGlobal(vBuf);
                            if (!accepted) CloseHandle(hEmi);
                        }
                    }
                }
            } catch {}
            finally {
                if (devInfo != IntPtr.Zero && devInfo != (IntPtr)(-1)) {
                    try { SetupDiDestroyDeviceInfoList(devInfo); } catch {}
                }
                ReadyEvent.Set();
            }
        });
        t.IsBackground = true;
        t.Name = "EmiAsyncInit";
        t.Start();
    }

    public static bool Sample(out double pkgWatts, out double igpuWatts) {
        pkgWatts = 0.0;
        igpuWatts = 0.0;
        lock (EmiLock) {
            if (!IsReady || DeviceHandle == (IntPtr)(-1) || MeasBuffer == IntPtr.Zero) return false;
            try {
                uint bytesRet = 0;
                uint bufSz = (uint)(ChannelCount * 16);
                if (!DeviceIoControl(DeviceHandle, IOCTL_EMI_GET_MEASUREMENT, IntPtr.Zero, 0, MeasBuffer, bufSz, out bytesRet, IntPtr.Zero) || bytesRet < bufSz) {
                    return false;
                }
                if (PkgChannel >= 0) {
                    ulong e = (ulong)Marshal.ReadInt64(MeasBuffer, PkgChannel * 16);
                    ulong t = (ulong)Marshal.ReadInt64(MeasBuffer, PkgChannel * 16 + 8);
                    if (t > PrevPkgTime && e >= PrevPkgEnergy) {
                        pkgWatts = Math.Round(((e - PrevPkgEnergy) * PICOWATT_HOURS_PER_100NS_TO_WATTS) / (t - PrevPkgTime), 1);
                    }
                    PrevPkgEnergy = e;
                    PrevPkgTime = t;
                }
                if (Pp1Channel >= 0) {
                    ulong e = (ulong)Marshal.ReadInt64(MeasBuffer, Pp1Channel * 16);
                    ulong t = (ulong)Marshal.ReadInt64(MeasBuffer, Pp1Channel * 16 + 8);
                    if (t > PrevPp1Time && e >= PrevPp1Energy) {
                        igpuWatts = Math.Round(((e - PrevPp1Energy) * PICOWATT_HOURS_PER_100NS_TO_WATTS) / (t - PrevPp1Time), 1);
                    }
                    PrevPp1Energy = e;
                    PrevPp1Time = t;
                }
                return true;
            } catch {
                return false;
            }
        }
    }

    public static void Shutdown() {
        lock (EmiLock) {
            IsReady = false;
            if (DeviceHandle != (IntPtr)(-1)) {
                try { CloseHandle(DeviceHandle); } catch {}
                DeviceHandle = (IntPtr)(-1);
            }
            if (MeasBuffer != IntPtr.Zero) {
                try { Marshal.FreeHGlobal(MeasBuffer); } catch {}
                MeasBuffer = IntPtr.Zero;
            }
        }
    }
}

public static class D3dKmtHost {
    [StructLayout(LayoutKind.Sequential)]
    public struct LUID {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_ENUMADAPTERS2 {
        public uint NumAdapters;
        public IntPtr pAdapters;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_ADAPTERINFO {
        public uint hAdapter;
        public LUID AdapterLuid;
        public uint NumOfSources;
        public int bPresentMoveRegionsPreferred;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_CLOSEADAPTER {
        public uint hAdapter;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_COUNTER {
        public uint Count;
        public ulong Bytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_DMA_PACKET_TYPE_INFORMATION {
        public uint a, b, c, d;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_QUEUE_PACKET_TYPE_INFORMATION {
        public uint a, b;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_PACKET_INFORMATION {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)]
        public D3DKMT_QUERYSTATISTICS_QUEUE_PACKET_TYPE_INFORMATION[] QueuePacket;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 4)]
        public D3DKMT_QUERYSTATISTICS_DMA_PACKET_TYPE_INFORMATION[] DmaPacket;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_PREEMPTION_INFORMATION {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public uint[] PreemptionCounter;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_PROCESS_NODE_INFORMATION {
        public long RunningTime;
        public uint ContextSwitch;
        public D3DKMT_QUERYSTATISTICS_PREEMPTION_INFORMATION PreemptionStatistics;
        public D3DKMT_QUERYSTATISTICS_PACKET_INFORMATION PacketStatistics;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)]
        public ulong[] Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_NODE_INFORMATION {
        public D3DKMT_QUERYSTATISTICS_PROCESS_NODE_INFORMATION GlobalInformation;
        public D3DKMT_QUERYSTATISTICS_PROCESS_NODE_INFORMATION SystemInformation;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)]
        public ulong[] Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_MEMORY {
        public ulong TotalBytesEvicted;
        public uint AllocsCommitted;
        public uint AllocsResident;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_SEGMENT_INFORMATION {
        public ulong CommitLimit;
        public ulong BytesCommitted;
        public ulong BytesResident;
        public D3DKMT_QUERYSTATISTICS_MEMORY Memory;
        public uint Aperture;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 5)]
        public ulong[] TotalBytesEvictedByPriority;
        public ulong SystemMemoryEndAddress;
        public ulong PowerFlags;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)]
        public ulong[] Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_REFERENCE_DMA_BUFFER {
        public uint f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_RENAMING {
        public uint f0, f1, f2, f3, f4, f5, f6, f7, f8;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_PREPRATION {
        public uint f0, f1, f2, f3;
        public D3DKMT_QUERYSTATISTICS_COUNTER AllocationsTrimmed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_PAGING_FAULT {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 10)]
        public D3DKMT_QUERYSTATISTICS_COUNTER[] c1;
        public uint f0, f1;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)]
        public D3DKMT_QUERYSTATISTICS_COUNTER[] c2;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_PAGING_TRANSFER {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)]
        public ulong[] f;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_SWIZZLING_RANGE {
        public uint a, b;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_LOCKS {
        public uint f0, f1, f2, f3, f4, f5, f6;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_ALLOCATIONS {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 7)]
        public D3DKMT_QUERYSTATISTICS_COUNTER[] c;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_TERMINATIONS {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 4)]
        public D3DKMT_QUERYSTATISTICS_COUNTER[] c;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DKMT_QUERYSTATISTICS_ADAPTER_INFORMATION {
        public uint NbSegments;
        public uint NodeCount;
        public uint VidPnSourceCount;
        public uint VSyncEnabled;
        public uint TdrDetectedCount;
        public long ZeroLengthDmaBuffers;
        public ulong RestartedPeriod;
        public D3DKMT_QUERYSTATISTICS_REFERENCE_DMA_BUFFER ReferenceDmaBuffer;
        public D3DKMT_QUERYSTATISTICS_RENAMING Renaming;
        public D3DKMT_QUERYSTATISTICS_PREPRATION Preparation;
        public D3DKMT_QUERYSTATISTICS_PAGING_FAULT PagingFault;
        public D3DKMT_QUERYSTATISTICS_PAGING_TRANSFER PagingTransfer;
        public D3DKMT_QUERYSTATISTICS_SWIZZLING_RANGE SwizzlingRange;
        public D3DKMT_QUERYSTATISTICS_LOCKS Locks;
        public D3DKMT_QUERYSTATISTICS_ALLOCATIONS Allocations;
        public D3DKMT_QUERYSTATISTICS_TERMINATIONS Terminations;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)]
        public ulong[] Reserved;
    }

    [DllImport("gdi32.dll")]
    public static extern int D3DKMTEnumAdapters2(ref D3DKMT_ENUMADAPTERS2 pData);

    [DllImport("gdi32.dll")]
    public static extern int D3DKMTCloseAdapter(ref D3DKMT_CLOSEADAPTER pData);

    [DllImport("gdi32.dll")]
    public static extern int D3DKMTQueryStatistics(IntPtr pData);

    [StructLayout(LayoutKind.Sequential)]
    public struct ENUM_PAGE_FILE_INFORMATION {
        public uint cb;
        public uint Reserved;
        public UIntPtr TotalSize;
        public UIntPtr TotalInUse;
        public UIntPtr PeakUsage;
    }

    public delegate bool EnumPageFileCallback(IntPtr pContext, ref ENUM_PAGE_FILE_INFORMATION pPageFileInfo, [MarshalAs(UnmanagedType.LPWStr)] string lpFilename);

    [DllImport("psapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool EnumPageFilesW(EnumPageFileCallback pCallbackRoutine, IntPtr lpContext);

    [StructLayout(LayoutKind.Sequential)]
    public struct PERFORMANCE_INFORMATION {
        public uint cb;
        public IntPtr CommitTotal;
        public IntPtr CommitLimit;
        public IntPtr CommitPeak;
        public IntPtr PhysicalTotal;
        public IntPtr PhysicalAvailable;
        public IntPtr SystemCache;
        public IntPtr KernelTotal;
        public IntPtr KernelPaged;
        public IntPtr KernelNonpaged;
        public IntPtr PageSize;
        public uint HandleCount;
        public uint ProcessCount;
        public uint ThreadCount;
    }

    [DllImport("psapi.dll", SetLastError = true)]
    public static extern bool GetPerformanceInfo(out PERFORMANCE_INFORMATION pPerformanceInformation, uint cb);

    private class AdapterEntry {
        public LUID Luid;
        public List<uint> ApertureSegments = new List<uint>();
    }

    private static readonly object D3dLock = new object();
    private static List<AdapterEntry> CachedAdapters = null;
    private static IntPtr QueryBuf = IntPtr.Zero;
    private static int QueryBufSize = 0;
    private static int HdrSize = 0;
    private static int ResultSize = 0;
    private static double PageSizeBytes = 4096.0;

    public static void Init() {
        lock (D3dLock) {
            try {
                PERFORMANCE_INFORMATION pi = new PERFORMANCE_INFORMATION();
                pi.cb = (uint)Marshal.SizeOf(typeof(PERFORMANCE_INFORMATION));
                if (GetPerformanceInfo(out pi, pi.cb) && pi.PageSize.ToInt64() > 0) {
                    PageSizeBytes = (double)pi.PageSize.ToInt64();
                }
            } catch {}

            if (CachedAdapters != null) return;

            int szAd = Marshal.SizeOf(typeof(D3DKMT_QUERYSTATISTICS_ADAPTER_INFORMATION));
            int szNode = Marshal.SizeOf(typeof(D3DKMT_QUERYSTATISTICS_NODE_INFORMATION));
            int szSeg = Marshal.SizeOf(typeof(D3DKMT_QUERYSTATISTICS_SEGMENT_INFORMATION));
            ResultSize = Math.Max(szAd, Math.Max(szNode, szSeg));
            HdrSize = IntPtr.Size == 8 ? 24 : 16;
            QueryBufSize = HdrSize + ResultSize + 64;
            QueryBuf = Marshal.AllocHGlobal(QueryBufSize);
            CachedAdapters = new List<AdapterEntry>();

            try {
                D3DKMT_ENUMADAPTERS2 ea = new D3DKMT_ENUMADAPTERS2();
                if (D3DKMTEnumAdapters2(ref ea) == 0 && ea.NumAdapters > 0) {
                    int adSize = Marshal.SizeOf(typeof(D3DKMT_ADAPTERINFO));
                    IntPtr pAd = Marshal.AllocHGlobal((int)(ea.NumAdapters * adSize));
                    try {
                        ea.pAdapters = pAd;
                        if (D3DKMTEnumAdapters2(ref ea) == 0) {
                            var seen = new HashSet<long>();
                            for (int i = 0; i < ea.NumAdapters; i++) {
                                var info = (D3DKMT_ADAPTERINFO)Marshal.PtrToStructure(IntPtr.Add(pAd, i * adSize), typeof(D3DKMT_ADAPTERINFO));
                                long lk = ((long)info.AdapterLuid.HighPart << 32) | info.AdapterLuid.LowPart;
                                if (seen.Add(lk)) {
                                    ZeroBuffer(QueryBuf, QueryBufSize);
                                    Marshal.WriteInt32(QueryBuf, 0, 0);
                                    Marshal.WriteInt32(QueryBuf, 4, (int)info.AdapterLuid.LowPart);
                                    Marshal.WriteInt32(QueryBuf, 8, info.AdapterLuid.HighPart);
                                    if (D3DKMTQueryStatistics(QueryBuf) == 0) {
                                        uint nbSegs = (uint)Marshal.ReadInt32(QueryBuf, HdrSize);
                                        var entry = new AdapterEntry { Luid = info.AdapterLuid };
                                        for (uint s = 0; s < nbSegs; s++) {
                                            ZeroBuffer(QueryBuf, QueryBufSize);
                                            Marshal.WriteInt32(QueryBuf, 0, 3);
                                            Marshal.WriteInt32(QueryBuf, 4, (int)info.AdapterLuid.LowPart);
                                            Marshal.WriteInt32(QueryBuf, 8, info.AdapterLuid.HighPart);
                                            Marshal.WriteInt32(QueryBuf, HdrSize + ResultSize, (int)s);
                                            if (D3DKMTQueryStatistics(QueryBuf) == 0) {
                                                var segInfo = (D3DKMT_QUERYSTATISTICS_SEGMENT_INFORMATION)Marshal.PtrToStructure(IntPtr.Add(QueryBuf, HdrSize), typeof(D3DKMT_QUERYSTATISTICS_SEGMENT_INFORMATION));
                                                if (segInfo.Aperture == 1) {
                                                    entry.ApertureSegments.Add(s);
                                                }
                                            }
                                        }
                                        if (entry.ApertureSegments.Count > 0) {
                                            CachedAdapters.Add(entry);
                                        }
                                    }
                                }
                                var cl = new D3DKMT_CLOSEADAPTER { hAdapter = info.hAdapter };
                                D3DKMTCloseAdapter(ref cl);
                            }
                        }
                    } finally {
                        Marshal.FreeHGlobal(pAd);
                    }
                }
            } catch {}
        }
    }

    private static void ZeroBuffer(IntPtr buf, int len) {
        int i = 0;
        for (; i + 8 <= len; i += 8) Marshal.WriteInt64(buf, i, 0);
        for (; i < len; i++) Marshal.WriteByte(buf, i, 0);
    }

    public static double SampleMaxSharedMB() {
        lock (D3dLock) {
            if (CachedAdapters == null) Init();
            if (CachedAdapters == null || QueryBuf == IntPtr.Zero) return 0.0;
            double maxMb = 0.0;
            try {
                for (int i = 0; i < CachedAdapters.Count; i++) {
                    var ad = CachedAdapters[i];
                    ulong sharedBytes = 0;
                    for (int j = 0; j < ad.ApertureSegments.Count; j++) {
                        ZeroBuffer(QueryBuf, QueryBufSize);
                        Marshal.WriteInt32(QueryBuf, 0, 3);
                        Marshal.WriteInt32(QueryBuf, 4, (int)ad.Luid.LowPart);
                        Marshal.WriteInt32(QueryBuf, 8, ad.Luid.HighPart);
                        Marshal.WriteInt32(QueryBuf, HdrSize + ResultSize, (int)ad.ApertureSegments[j]);
                        if (D3DKMTQueryStatistics(QueryBuf) == 0) {
                            var segInfo = (D3DKMT_QUERYSTATISTICS_SEGMENT_INFORMATION)Marshal.PtrToStructure(IntPtr.Add(QueryBuf, HdrSize), typeof(D3DKMT_QUERYSTATISTICS_SEGMENT_INFORMATION));
                            sharedBytes += segInfo.BytesResident;
                        }
                    }
                    double mb = Math.Round(sharedBytes / (1024.0 * 1024.0), 0);
                    if (mb > maxMb) maxMb = mb;
                }
            } catch {}
            return maxMb;
        }
    }

    public static void SamplePageFile(out double usedGB, out double totalGB, out double pct) {
        usedGB = 0.0;
        totalGB = 0.0;
        pct = 0.0;
        ulong totalPages = 0;
        ulong usedPages = 0;
        try {
            EnumPageFilesW((IntPtr ctx, ref ENUM_PAGE_FILE_INFORMATION info, string fname) => {
                totalPages += info.TotalSize.ToUInt64();
                usedPages += info.TotalInUse.ToUInt64();
                return true;
            }, IntPtr.Zero);
            if (totalPages > 0) {
                totalGB = Math.Round((totalPages * PageSizeBytes) / (1024.0 * 1024.0 * 1024.0), 1);
                usedGB = Math.Round((usedPages * PageSizeBytes) / (1024.0 * 1024.0 * 1024.0), 1);
                pct = Math.Round((usedPages * 100.0) / totalPages, 0);
            }
        } catch {}
    }

    public static void Shutdown() {
        lock (D3dLock) {
            CachedAdapters = null;
            if (QueryBuf != IntPtr.Zero) {
                try { Marshal.FreeHGlobal(QueryBuf); } catch {}
                QueryBuf = IntPtr.Zero;
            }
        }
    }
}

public static class PdhHost {
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

    private static readonly object PdhLock = new object();
    private static volatile bool IsInitialized = false;
    private static IntPtr Query = IntPtr.Zero;
    private static IntPtr cPkg = IntPtr.Zero;
    private static IntPtr cPp1 = IntPtr.Zero;

    public static void EnsureFallbackRaplInit() {
        if (IsInitialized) return;
        lock (PdhLock) {
            if (IsInitialized) return;
            try {
                IntPtr q = IntPtr.Zero;
                if (PdhOpenQuery(null, IntPtr.Zero, out q) == 0) {
                    IntPtr hPkg = IntPtr.Zero, hPp1 = IntPtr.Zero;
                    if (PdhAddEnglishCounter(q, @"\Energy Meter(RAPL_Package0_PKG)\Power", IntPtr.Zero, out hPkg) != 0) hPkg = IntPtr.Zero;
                    if (PdhAddEnglishCounter(q, @"\Energy Meter(RAPL_Package0_PP1)\Power", IntPtr.Zero, out hPp1) != 0) hPp1 = IntPtr.Zero;
                    if (hPkg != IntPtr.Zero || hPp1 != IntPtr.Zero) {
                        PdhCollectQueryData(q);
                        Query = q;
                        cPkg = hPkg;
                        cPp1 = hPp1;
                        IsInitialized = true;
                        return;
                    }
                    PdhCloseQuery(q);
                }
            } catch {}
        }
    }

    public static void SampleRaplFallback(out double pkgWatts, out double igpuWatts) {
        pkgWatts = 0.0;
        igpuWatts = 0.0;
        lock (PdhLock) {
            if (!IsInitialized || Query == IntPtr.Zero) return;
            try {
                PdhCollectQueryData(Query);
                PDH_FMT_COUNTERVALUE v;
                if (cPkg != IntPtr.Zero && PdhGetFormattedCounterValue(cPkg, 0x200u, IntPtr.Zero, out v) == 0 && v.CStatus == 0) {
                    pkgWatts = Math.Round(v.doubleValue / 1000.0, 1);
                }
                if (cPp1 != IntPtr.Zero && PdhGetFormattedCounterValue(cPp1, 0x200u, IntPtr.Zero, out v) == 0 && v.CStatus == 0) {
                    igpuWatts = Math.Round(v.doubleValue / 1000.0, 1);
                }
            } catch {}
        }
    }

    public static void Shutdown() {
        lock (PdhLock) {
            IsInitialized = false;
            if (Query != IntPtr.Zero) {
                try { PdhCloseQuery(Query); } catch {}
                Query = IntPtr.Zero;
            }
        }
    }
}

public static class MonitorController {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PHYSICAL_MONITOR {
        public IntPtr hPhysicalMonitor;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szPhysicalMonitorDescription;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int left, top, right, bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
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

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll")]
    public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint pdwNumberOfPhysicalMonitors);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint dwPhysicalMonitorArraySize, [Out] PHYSICAL_MONITOR[] pPhysicalMonitorArray);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool DestroyPhysicalMonitors(uint dwPhysicalMonitorArraySize, [In] PHYSICAL_MONITOR[] pPhysicalMonitorArray);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetMonitorBrightness(IntPtr hMonitor, out uint pdwMinimumBrightness, out uint pdwCurrentBrightness, out uint pdwMaximumBrightness);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool SetMonitorBrightness(IntPtr hMonitor, uint dwNewBrightness);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetMonitorContrast(IntPtr hMonitor, out uint pdwMinimumContrast, out uint pdwCurrentContrast, out uint pdwMaximumContrast);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool SetMonitorContrast(IntPtr hMonitor, uint dwNewContrast);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetMonitorRedGreenOrBlueGain(IntPtr hMonitor, uint dwGainType, out uint pdwMinimumGain, out uint pdwCurrentGain, out uint pdwMaximumGain);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool SetMonitorRedGreenOrBlueGain(IntPtr hMonitor, uint dwGainType, uint dwNewGain);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr hMonitor, byte bVCPCode, out uint pvct, out uint pdwCurrentValue, out uint pdwMaximumValue);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool SetVCPFeature(IntPtr hMonitor, byte bVCPCode, uint dwNewValue);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DeviceIoControl(IntPtr hDevice, uint dwIoControlCode, IntPtr lpInBuffer, uint nInBufferSize, IntPtr lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAY_BRIGHTNESS {
        public byte ucDisplayPolicy;
        public byte ucACBrightness;
        public byte ucDCBrightness;
    }

    public static int SetLcdBrightnessKernel(byte level) {
        IntPtr hLcd = CreateFile(@"\\.\LCD", 0xC0000000u, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (hLcd == (IntPtr)(-1)) {
            hLcd = CreateFile(@"\\.\LCD", 0x40000000u, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (hLcd == (IntPtr)(-1)) return Marshal.GetLastWin32Error();
        }
        IntPtr pDb = IntPtr.Zero;
        try {
            DISPLAY_BRIGHTNESS db = new DISPLAY_BRIGHTNESS();
            db.ucDisplayPolicy = 3;
            db.ucACBrightness = level;
            db.ucDCBrightness = level;
            int sz = Marshal.SizeOf(typeof(DISPLAY_BRIGHTNESS));
            pDb = Marshal.AllocHGlobal(sz);
            Marshal.StructureToPtr(db, pDb, false);
            uint retBytes = 0;
            bool ok = DeviceIoControl(hLcd, 0x23049Cu, pDb, (uint)sz, IntPtr.Zero, 0, out retBytes, IntPtr.Zero);
            if (!ok) {
                db.ucDisplayPolicy = 1;
                Marshal.StructureToPtr(db, pDb, false);
                ok = DeviceIoControl(hLcd, 0x23049Cu, pDb, (uint)sz, IntPtr.Zero, 0, out retBytes, IntPtr.Zero);
                int err = ok ? 0 : Marshal.GetLastWin32Error();
                return err;
            }
            return 0;
        } finally {
            if (pDb != IntPtr.Zero) Marshal.FreeHGlobal(pDb);
            CloseHandle(hLcd);
        }
    }

    public static int QueryLcdBrightness(out byte level) {
        level = 50;
        IntPtr hLcd = CreateFile(@"\\.\LCD", 0x80000000u, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (hLcd == (IntPtr)(-1)) {
            hLcd = CreateFile(@"\\.\LCD", 0x00000000u, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (hLcd == (IntPtr)(-1)) return Marshal.GetLastWin32Error();
        }
        IntPtr pDb = IntPtr.Zero;
        try {
            int sz = Marshal.SizeOf(typeof(DISPLAY_BRIGHTNESS));
            pDb = Marshal.AllocHGlobal(sz);
            uint retBytes = 0;
            bool ok = DeviceIoControl(hLcd, 0x230498u, IntPtr.Zero, 0, pDb, (uint)sz, out retBytes, IntPtr.Zero);
            if (ok) {
                DISPLAY_BRIGHTNESS db = (DISPLAY_BRIGHTNESS)Marshal.PtrToStructure(pDb, typeof(DISPLAY_BRIGHTNESS));
                level = (db.ucDisplayPolicy == 2) ? db.ucDCBrightness : db.ucACBrightness;
                return 0;
            }
            return Marshal.GetLastWin32Error();
        } finally {
            if (pDb != IntPtr.Zero) Marshal.FreeHGlobal(pDb);
            CloseHandle(hLcd);
        }
    }

    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateDC(string lpszDriver, string lpszDevice, string lpszOutput, IntPtr lpInitData);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern bool SetDeviceGammaRamp(IntPtr hdc, IntPtr lpRamp);

    public static int internalContrast = 50;
    public static int internalGainR = 50;
    public static int internalGainG = 50;
    public static int internalGainB = 50;

    public static bool ApplyInternalCalibrationRamp(string gdiDeviceName, int contrastVal, int rGain, int gGain, int bGain, int softwareBrightVal = 100) {
        string devName = string.IsNullOrEmpty(gdiDeviceName) ? @"\\.\DISPLAY1" : gdiDeviceName;
        IntPtr hdc = CreateDC("DISPLAY", devName, null, IntPtr.Zero);
        if (hdc == IntPtr.Zero) hdc = CreateDC(devName, null, null, IntPtr.Zero);
        if (hdc == IntPtr.Zero) return false;
        IntPtr pRamp = IntPtr.Zero;
        try {
            ushort[] ramp = new ushort[256 * 3];
            double bScale = Math.Max(0.10, Math.Min(1.0, softwareBrightVal / 100.0));
            double cMult = Math.Max(0.1, Math.Min(2.0, contrastVal / 50.0));
            double[] chScale = new double[] {
                Math.Max(0.2, Math.Min(2.0, rGain / 50.0)),
                Math.Max(0.2, Math.Min(2.0, gGain / 50.0)),
                Math.Max(0.2, Math.Min(2.0, bGain / 50.0))
            };
            for (int c = 0; c < 3; c++) {
                for (int i = 0; i < 256; i++) {
                    double norm = i / 255.0;
                    double adjusted = ((norm - 0.5) * cMult + 0.5) * chScale[c] * bScale;
                    if (adjusted < 0.0) adjusted = 0.0;
                    if (adjusted > 1.0) adjusted = 1.0;
                    ramp[c * 256 + i] = (ushort)(adjusted * 65535.0);
                }
            }
            pRamp = Marshal.AllocHGlobal(256 * 3 * 2);
            short[] sRamp = new short[256 * 3];
            Buffer.BlockCopy(ramp, 0, sRamp, 0, 256 * 3 * 2);
            Marshal.Copy(sRamp, 0, pRamp, 256 * 3);
            return SetDeviceGammaRamp(hdc, pRamp);
        } finally {
            if (pRamp != IntPtr.Zero) Marshal.FreeHGlobal(pRamp);
            DeleteDC(hdc);
        }
    }

    public static bool ApplyGammaBrightness(string gdiDeviceName, int val, int contrastVal = 50, int rGain = 50, int gGain = 50, int bGain = 50) {
        if (string.IsNullOrEmpty(gdiDeviceName)) return false;
        return ApplyInternalCalibrationRamp(gdiDeviceName, contrastVal, rGain, gGain, bGain, val);
    }

    public static void SetInternalDisplayCalibration(int contrast, int r, int g, int b) {
        string targetGdi = null;
        lock (SyncLock) {
            if (contrast >= 0) internalContrast = Math.Max(0, Math.Min(100, contrast));
            if (r >= 0) internalGainR = Math.Max(0, Math.Min(100, r));
            if (g >= 0) internalGainG = Math.Max(0, Math.Min(100, g));
            if (b >= 0) internalGainB = Math.Max(0, Math.Min(100, b));
            for (int i = 0; i < CurrentMonitors.Count; i++) {
                if (CurrentMonitors[i].isInternal) {
                    CurrentMonitors[i].contrast = internalContrast;
                    CurrentMonitors[i].gainR = internalGainR;
                    CurrentMonitors[i].gainG = internalGainG;
                    CurrentMonitors[i].gainB = internalGainB;
                    targetGdi = CurrentMonitors[i].gdiDevice;
                }
            }
        }
        if (string.IsNullOrEmpty(targetGdi)) targetGdi = @"\\.\DISPLAY1";
        ApplyInternalCalibrationRamp(targetGdi, internalContrast, internalGainR, internalGainG, internalGainB, 100);
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
    public static extern uint CallNtPowerInformation(int InformationLevel, IntPtr lpInputBuffer, uint nInputBufferSize, IntPtr lpOutputBuffer, uint nOutputBufferSize);

    public static PROCESSOR_POWER_INFORMATION[] GetProcessorPowerInfo() {
        int count = Environment.ProcessorCount;
        int sz = Marshal.SizeOf(typeof(PROCESSOR_POWER_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(sz * count);
        try {
            uint status = CallNtPowerInformation(11, IntPtr.Zero, 0, ptr, (uint)(sz * count));
            if (status == 0) {
                var res = new PROCESSOR_POWER_INFORMATION[count];
                for (int i = 0; i < count; i++) {
                    res[i] = (PROCESSOR_POWER_INFORMATION)Marshal.PtrToStructure(IntPtr.Add(ptr, i * sz), typeof(PROCESSOR_POWER_INFORMATION));
                }
                return res;
            }
        } finally {
            Marshal.FreeHGlobal(ptr);
        }
        return null;
    }

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
    public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetSystemTimes(out ulong lpIdleTime, out ulong lpKernelTime, out ulong lpUserTime);

    private static ulong lastIdle = 0, lastKernel = 0, lastUser = 0;
    public static int GetInstantCpuLoad() {
        ulong idle, kernel, user;
        if (!GetSystemTimes(out idle, out kernel, out user)) return 0;
        if (lastKernel == 0 && lastUser == 0) {
            lastIdle = idle; lastKernel = kernel; lastUser = user;
            return 0;
        }
        ulong idDiff = idle - lastIdle;
        ulong sysDiff = (kernel - lastKernel) + (user - lastUser);
        lastIdle = idle; lastKernel = kernel; lastUser = user;
        if (sysDiff == 0) return 0;
        int util = (int)Math.Round(((double)(sysDiff - idDiff) / (double)sysDiff) * 100.0);
        return Math.Max(0, Math.Min(100, util));
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    public static int GetParentProcessId() {
        PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
        int retLen;
        if (NtQueryInformationProcess(GetCurrentProcess(), 0, ref pbi, Marshal.SizeOf(pbi), out retLen) == 0) {
            return pbi.InheritedFromUniqueProcessId.ToInt32();
        }
        return -1;
    }

    public static string GetMonitorPnpId(IntPtr hMonitor, out string gdiDevName, out int width, out int height) {
        gdiDevName = null;
        width = 0;
        height = 0;
        MONITORINFOEX mi = new MONITORINFOEX();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (GetMonitorInfo(hMonitor, ref mi)) {
            gdiDevName = mi.szDevice;
            width = mi.rcMonitor.right - mi.rcMonitor.left;
            height = mi.rcMonitor.bottom - mi.rcMonitor.top;
            DISPLAY_DEVICE dd = new DISPLAY_DEVICE();
            dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            if (EnumDisplayDevices(mi.szDevice, 0, ref dd, 0) && !string.IsNullOrEmpty(dd.DeviceID)) {
                string[] parts = dd.DeviceID.Split('\\');
                if (parts.Length >= 2) return parts[1];
                return dd.DeviceID;
            }
        }
        return null;
    }

    private static readonly Dictionary<string, string> EdidNameCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    public static string GetMonitorFriendlyNameFromEdid(string pnpId) {
        if (string.IsNullOrEmpty(pnpId)) return null;
        string cached;
        if (EdidNameCache.TryGetValue(pnpId, out cached)) return cached;
        try {
            using (var displayKey = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\DISPLAY\" + pnpId)) {
                if (displayKey != null) {
                    foreach (var subName in displayKey.GetSubKeyNames()) {
                        using (var instKey = displayKey.OpenSubKey(subName + @"\Device Parameters")) {
                            if (instKey != null) {
                                byte[] edid = instKey.GetValue("EDID") as byte[];
                                if (edid != null && edid.Length >= 128) {
                                    for (int off = 54; off <= 108; off += 18) {
                                        if (off + 18 <= edid.Length && edid[off] == 0 && edid[off + 1] == 0 && edid[off + 2] == 0 && edid[off + 3] == 0xFC) {
                                            string name = Encoding.ASCII.GetString(edid, off + 5, 13).Split('\n', '\r', '\0')[0].Trim();
                                            if (!string.IsNullOrEmpty(name)) {
                                                EdidNameCache[pnpId] = name;
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
        public int inputSource;
        public int colorPreset;
        public int overdrive;
        public int strobing;
        public int mprt;
        public int freeSync;
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
        public int input = -1, strobing = -1, mprt = -1, od = -1, fs = -1;
        public string friendlyName;
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

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hMonitor, IntPtr hdc, ref RECT lprc, IntPtr data) => {
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

        activeGdiDevices.Sort((a, b) => ExtractGdiNumber(a).CompareTo(ExtractGdiNumber(b)));

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

                bool isInternalMatch = (!string.IsNullOrEmpty(SavedInternalPnpId) && string.Equals(SavedInternalPnpId, pnpId, StringComparison.OrdinalIgnoreCase)) ||
                                       (!string.IsNullOrEmpty(gdiDev) && gdiDev.IndexOf("DISPLAY1", StringComparison.OrdinalIgnoreCase) >= 0);

                byte curLcd = 50;
                if (isInternalMatch && QueryLcdBrightness(out curLcd) == 0) {
                    if (string.IsNullOrEmpty(SavedInternalPnpId) && !string.IsNullOrEmpty(pnpId)) {
                        SavedInternalPnpId = pnpId;
                    }
                    string modelName = null;
                    if (!string.IsNullOrEmpty(pnpId)) {
                        SavedFriendlyNames.TryGetValue(pnpId, out modelName);
                    }
                    if (string.IsNullOrEmpty(modelName)) modelName = "Internal Display";

                    string canonicalId = !string.IsNullOrEmpty(pnpId) ? pnpId : (!string.IsNullOrEmpty(gdiDev) ? gdiDev : "internal");

                    boundList.Add(new BoundPhysicalMonitor {
                        id = canonicalId,
                        hPhys = IntPtr.Zero,
                        count = 0,
                        monitors = null,
                        gdiDevice = gdiDev ?? "",
                        pnpId = pnpId ?? "",
                        name = modelName,
                        windowsDisplayNumber = winNum,
                        width = mWidth,
                        height = mHeight,
                        isInternal = true,
                        initialBrightness = (int)curLcd
                    });
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
                                SavedFriendlyNames.TryGetValue(pnpId, out modelName);
                            }
                            if (string.IsNullOrEmpty(modelName)) {
                                modelName = "Monitor " + winNum;
                            }

                            string canonicalId = !string.IsNullOrEmpty(pnpId) ? pnpId : (!string.IsNullOrEmpty(gdiDev) ? gdiDev : ("mon_" + ddcIndex));

                            boundList.Add(new BoundPhysicalMonitor {
                                id = canonicalId,
                                hPhys = hPhys,
                                count = count,
                                monitors = physicalMonitors,
                                gdiDevice = gdiDev ?? "",
                                pnpId = pnpId ?? "",
                                name = modelName,
                                windowsDisplayNumber = winNum,
                                width = mWidth,
                                height = mHeight,
                                isInternal = false,
                                initialBrightness = -1
                            });
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
                        ? activeGdiDevices[0] : @"\\.\DISPLAY1";
                    int winNum = activeGdiDevices.Contains(intGdi) ? (activeGdiDevices.IndexOf(intGdi) + 1) : 1;
                    int intWidth = (activeGdiDevices.Count > 0 && monitorGdiDevs.Contains(intGdi))
                        ? monitorWidths[monitorGdiDevs.IndexOf(intGdi)] : GetSystemMetrics(0);
                    int intHeight = (activeGdiDevices.Count > 0 && monitorGdiDevs.Contains(intGdi))
                        ? monitorHeights[monitorGdiDevs.IndexOf(intGdi)] : GetSystemMetrics(1);

                    boundList.Add(new BoundPhysicalMonitor {
                        id = intPnp,
                        hPhys = IntPtr.Zero,
                        count = 0,
                        monitors = null,
                        gdiDevice = intGdi,
                        pnpId = intPnp,
                        name = intModel,
                        windowsDisplayNumber = winNum,
                        width = intWidth,
                        height = intHeight,
                        isInternal = true,
                        initialBrightness = (int)curLcd
                    });
                }
            }

            boundList.Sort((a, b) => a.windowsDisplayNumber.CompareTo(b.windowsDisplayNumber));

            var initialDevList = new List<DisplayDeviceItem>(boundList.Count);
            foreach (var b in boundList) {
                var item = new DisplayDeviceItem();
                item.id = b.id;
                item.pnpId = b.pnpId;
                item.gdiDevice = b.gdiDevice;
                item.name = b.name;
                item.windowsDisplayNumber = b.windowsDisplayNumber;
                item.width = b.width;
                item.height = b.height;
                item.isInternal = b.isInternal;
                item.brightness = b.isInternal ? b.initialBrightness : -1;
                item.contrast = b.isInternal ? internalContrast : -1;
                item.gainR = b.isInternal ? internalGainR : -1;
                item.gainG = b.isInternal ? internalGainG : -1;
                item.gainB = b.isInternal ? internalGainB : -1;
                item.inputSource = -1;
                item.colorPreset = -1;
                item.overdrive = -1;
                item.strobing = -1;
                item.mprt = -1;
                item.freeSync = -1;
                initialDevList.Add(item);
            }

            lock (SyncLock) {
                BoundMonitors = boundList;
                CurrentMonitors = initialDevList;
            }
            allocatedSets.Clear();
            if (signalWake) WakeSignal.Set();
        } finally {
            var destroyed = new HashSet<PHYSICAL_MONITOR[]>();
            foreach (var arr in allocatedSets) {
                try {
                    if (arr != null && !destroyed.Contains(arr)) {
                        destroyed.Add(arr);
                        DestroyPhysicalMonitors((uint)arr.Length, arr);
                    }
                } catch {}
            }
        }
    }

    private static BoundPhysicalMonitor FindBoundTarget(string monitorId, string pnpId, string gdiDev, bool isInt) {
        lock (SyncLock) {
            if (BoundMonitors.Count == 0) return null;
            for (int i = 0; i < BoundMonitors.Count; i++) {
                var b = BoundMonitors[i];
                if (!string.IsNullOrEmpty(monitorId) && b.id == monitorId) return b;
                if (!string.IsNullOrEmpty(pnpId) && b.pnpId == pnpId) return b;
                if (!string.IsNullOrEmpty(gdiDev) && b.gdiDevice == gdiDev) return b;
            }
            if (isInt || (!string.IsNullOrEmpty(monitorId) && monitorId.IndexOf("internal", StringComparison.OrdinalIgnoreCase) >= 0) ||
                (!string.IsNullOrEmpty(gdiDev) && gdiDev.IndexOf("DISPLAY1", StringComparison.OrdinalIgnoreCase) >= 0)) {
                for (int i = 0; i < BoundMonitors.Count; i++) {
                    if (BoundMonitors[i].isInternal) return BoundMonitors[i];
                }
            }
            int parsedIdx;
            if (!string.IsNullOrEmpty(monitorId) && monitorId.StartsWith("mon_") && int.TryParse(monitorId.Substring(4), out parsedIdx)) {
                if (parsedIdx >= 0 && parsedIdx < BoundMonitors.Count) return BoundMonitors[parsedIdx];
            }
        }
        return null;
    }

    private delegate bool DdcWriteAction(IntPtr hPhys);

    private static bool ExecuteWithReprobe(ref BoundPhysicalMonitor target, DdcWriteAction action) {
        if (target == null) return false;
        if (action(target.hPhys)) return true;

        string targetId = target.id;
        string targetPnp = target.pnpId;
        string targetGdi = target.gdiDevice;
        bool targetIsInt = target.isInternal;

        lock (ProbeLock) {
            BindPhysicalMonitors(SavedFriendlyNames, false);
        }
        target = FindBoundTarget(targetId, targetPnp, targetGdi, targetIsInt);
        if (target == null) return false;
        return action(target.hPhys);
    }

    private static bool WriteVcpWithRetry(ref BoundPhysicalMonitor target, byte code, uint val) {
        return ExecuteWithReprobe(ref target, (hPhys) => SetVCPFeature(hPhys, code, val));
    }

    private static bool SetBrightnessTiered(ref BoundPhysicalMonitor target, int val) {
        uint v = (uint)Math.Max(0, Math.Min(100, val));
        return ExecuteWithReprobe(ref target, (hPhys) => SetMonitorBrightness(hPhys, v) || SetVCPFeature(hPhys, 0x10, v));
    }

    private static bool SetContrastTiered(ref BoundPhysicalMonitor target, int val) {
        uint v = (uint)Math.Max(0, Math.Min(100, val));
        return ExecuteWithReprobe(ref target, (hPhys) => SetMonitorContrast(hPhys, v) || SetVCPFeature(hPhys, 0x12, v));
    }

    private static bool SetGainTiered(ref BoundPhysicalMonitor target, uint channelIdx, byte vcpCode, int val) {
        uint v = (uint)Math.Max(0, Math.Min(100, val));
        return ExecuteWithReprobe(ref target, (hPhys) => SetMonitorRedGreenOrBlueGain(hPhys, channelIdx, v) || SetVCPFeature(hPhys, vcpCode, v));
    }

    private static bool InvokeWmiSetBrightness(byte val) {
        try {
            using (var mc = new ManagementClass("root\\wmi", "WmiMonitorBrightnessMethods", null)) {
                foreach (ManagementObject mo in mc.GetInstances()) {
                    using (mo) {
                        mo.InvokeMethod("WmiSetBrightness", new object[] { (uint)1, val });
                        return true;
                    }
                }
            }
        } catch {}
        return false;
    }

    public static bool ApplyControl(string monitorId, string control, int val, string pnpId = null, string gdiDev = null, bool isInt = false) {
        BoundPhysicalMonitor target = FindBoundTarget(monitorId, pnpId, gdiDev, isInt);
        if (target == null) {
            lock (ProbeLock) {
                BindPhysicalMonitors(SavedFriendlyNames, false);
            }
            target = FindBoundTarget(monitorId, pnpId, gdiDev, isInt);
        }

        string ctrl = string.IsNullOrEmpty(control) ? "" : control.ToLower().Replace("_", "");
        if (target != null && target.isInternal) {
            if (ctrl == "brightness") {
                byte bVal = (byte)Math.Max(0, Math.Min(100, val));
                bool ok = (SetLcdBrightnessKernel(bVal) == 0);
                if (!ok) ok = InvokeWmiSetBrightness(bVal);
                if (!ok) ok = ApplyGammaBrightness(target.gdiDevice, (int)bVal, internalContrast, internalGainR, internalGainG, internalGainB);
                if (ok) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].isInternal || CurrentMonitors[i].id == target.id) {
                                CurrentMonitors[i].brightness = val;
                                break;
                            }
                        }
                    }
                }
                return ok;
            } else if (ctrl == "contrast" || ctrl == "gainr" || ctrl == "gaing" || ctrl == "gainb") {
                int c = (ctrl == "contrast") ? val : -1;
                int r = (ctrl == "gainr") ? val : -1;
                int g = (ctrl == "gaing") ? val : -1;
                int b = (ctrl == "gainb") ? val : -1;
                SetInternalDisplayCalibration(c, r, g, b);
                return true;
            }
            return false;
        }

        if (target == null) return false;

        bool ddcOk = false;
        switch (ctrl) {
            case "brightness":
                ddcOk = SetBrightnessTiered(ref target, val);
                if (!ddcOk && target != null) {
                    ddcOk = ApplyGammaBrightness(target.gdiDevice, val);
                }
                if (ddcOk && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].brightness = val; break; }
                        }
                    }
                }
                break;
            case "contrast":
                ddcOk = SetContrastTiered(ref target, val);
                if (ddcOk && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].contrast = val; break; }
                        }
                    }
                }
                break;
            case "gainr":
                ddcOk = SetGainTiered(ref target, 0, 0x16, val);
                if (ddcOk && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].gainR = val; break; }
                        }
                    }
                }
                break;
            case "gaing":
                ddcOk = SetGainTiered(ref target, 1, 0x18, val);
                if (ddcOk && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].gainG = val; break; }
                        }
                    }
                }
                break;
            case "gainb":
                ddcOk = SetGainTiered(ref target, 2, 0x1A, val);
                if (ddcOk && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].gainB = val; break; }
                        }
                    }
                }
                break;
            case "preset":
            case "colorpreset":
                ddcOk = WriteVcpWithRetry(ref target, 0x14, (uint)val);
                if (ddcOk && target != null) {
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
                break;
            case "input":
            case "inputsource":
                ddcOk = WriteVcpWithRetry(ref target, 0x60, (uint)val);
                if (ddcOk && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].inputSource = val; break; }
                        }
                    }
                }
                break;
            case "overdrive":
                ddcOk = WriteVcpWithRetry(ref target, 0xE8, (uint)val);
                if (ddcOk && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].overdrive = val; break; }
                        }
                    }
                }
                break;
            case "strobing":
            case "mprt":
                byte mprtCode = (byte)((target != null && target.pnpId != null && target.pnpId.StartsWith("ACR", StringComparison.OrdinalIgnoreCase)) ? 0xE5 : 0xEF);
                ddcOk = WriteVcpWithRetry(ref target, mprtCode, (uint)val);
                if (!ddcOk && target != null) {
                    byte altCode = (mprtCode == 0xE5) ? (byte)0xEF : (byte)0xE5;
                    ddcOk = WriteVcpWithRetry(ref target, altCode, (uint)val);
                }
                if (ddcOk && target != null) {
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
                break;
            case "freesync":
                ddcOk = WriteVcpWithRetry(ref target, 0xEA, (uint)val);
                if (ddcOk && target != null) {
                    lock (SyncLock) {
                        for (int i = 0; i < CurrentMonitors.Count; i++) {
                            if (CurrentMonitors[i].id == target.id) { CurrentMonitors[i].freeSync = val; break; }
                        }
                    }
                }
                break;
        }
        return ddcOk;
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
                    if (!string.IsNullOrEmpty(bound.pnpId)) {
                        u.friendlyName = GetMonitorFriendlyNameFromEdid(bound.pnpId);
                    }
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

                // 1. Empirical Brightness
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x10, out pvct, out vCur, out vMax)) {
                    u.brightVal = (int)vCur;
                    hasBright = true; brightCur = vCur; brightMax = vMax;
                    hasPrev = true; prevCur = vCur; prevMax = vMax;
                } else if (GetMonitorBrightness(hPhys, out hlMin, out hlCur, out hlMax)) {
                    u.brightVal = (int)hlCur;
                    hasBright = true; brightCur = hlCur; brightMax = hlMax;
                    hasPrev = true; prevCur = hlCur; prevMax = hlMax;
                }

                // 2. Empirical Color Preset
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x14, out pvct, out vCur, out vMax)) {
                    u.preset = (int)vCur;
                    hasPreset = true; presetCur = vCur; presetMax = vMax;
                    hasPrev = true; prevCur = vCur; prevMax = vMax;
                }

                // 3. Empirical RGB Gains when User/Custom mode active (or preset unavailable)
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

                // Resolve EDID display name off the bind critical path while DDC reads run
                if (!string.IsNullOrEmpty(bound.pnpId)) {
                    u.friendlyName = GetMonitorFriendlyNameFromEdid(bound.pnpId);
                }

                // 4. Input Source (0x60) & FreeSync (0xEA): defer echo disambiguation to the mandatory 0x12 Contrast read
                bool suspectInput = false;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x60, out pvct, out vCur, out vMax)) {
                    if (hasPrev && vCur == prevCur && vMax == prevMax) {
                        suspectInput = true;
                    } else {
                        u.input = (int)vCur;
                        hasPrev = true; prevCur = vCur; prevMax = vMax;
                    }
                }

                bool suspectEa = false;
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xEA, out pvct, out vCur, out vMax)) {
                    if (hasPrev && vCur == prevCur && vMax == prevMax) {
                        suspectEa = true;
                    } else {
                        u.fs = (int)vCur;
                        hasPrev = true; prevCur = vCur; prevMax = vMax;
                    }
                }

                // 5. Mandatory Contrast read (0x12) acts as live value and baseline flip between 0xEA and 0xEF/0xE5
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x12, out pvct, out vCur, out vMax)) {
                    u.contrastVal = (int)vCur;
                    hasContrast = true; contrastCur = vCur; contrastMax = vMax;
                    hasPrev = true; prevCur = vCur; prevMax = vMax;
                } else if (GetMonitorContrast(hPhys, out hlMin, out hlCur, out hlMax)) {
                    u.contrastVal = (int)hlCur;
                    hasContrast = true; contrastCur = hlCur; contrastMax = hlMax;
                    hasPrev = true; prevCur = hlCur; prevMax = hlMax;
                }

                if (suspectInput && hasPrev && GetVCPFeatureAndVCPFeatureReply(hPhys, 0x60, out pvct, out vCur, out vMax)) {
                    if (!(vCur == prevCur && vMax == prevMax)) {
                        u.input = (int)vCur;
                        prevCur = vCur; prevMax = vMax;
                    }
                }

                if (suspectEa && hasPrev && GetVCPFeatureAndVCPFeatureReply(hPhys, 0xEA, out pvct, out vCur, out vMax)) {
                    if (!(vCur == prevCur && vMax == prevMax)) {
                        u.fs = (int)vCur;
                        prevCur = vCur; prevMax = vMax;
                    }
                }

                // Stale DDC buffer echo disambiguation helper for remaining secondary registers
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

                // 6. Strobing/VRB (0xE5 or 0xEF) & Overdrive (0xE8)
                int strVal = readVerifiedVcp(0xE5);
                if (strVal < 0) {
                    strVal = readVerifiedVcp(0xEF);
                }
                if (strVal >= 0) {
                    u.strobing = strVal;
                    u.mprt = strVal;
                }

                int odVal = readVerifiedVcp(0xE8);
                if (odVal >= 0) {
                    u.od = odVal;
                }
            });
            extT.IsBackground = true;
            extT.Start();
            extThreads.Add(extT);
        }

        for (int i = 0; i < extThreads.Count; i++) {
            try { extThreads[i].Join(); } catch {}
        }

        try { EmiHost.ReadyEvent.WaitOne(); } catch {}
        try { NvmlHost.ReadyEvent.WaitOne(); } catch {}

        lock (SyncLock) {
            for (int i = 0; i < updates.Length; i++) {
                var u = updates[i];
                if (u == null || u.id == null) continue;
                for (int j = 0; j < CurrentMonitors.Count; j++) {
                    if (CurrentMonitors[j].id == u.id || (u.isInternal && CurrentMonitors[j].isInternal)) {
                        if (!string.IsNullOrEmpty(u.friendlyName)) {
                            CurrentMonitors[j].name = u.friendlyName;
                            if (!string.IsNullOrEmpty(CurrentMonitors[j].pnpId)) {
                                SavedFriendlyNames[CurrentMonitors[j].pnpId] = u.friendlyName;
                            }
                        }
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
        }
        WakeSignal.Set();
    }

    public static void RequestEmpiricalProbe(int probeId = 0, bool forceRebind = false, Dictionary<string, string> friendlyNames = null) {
        lock (SyncLock) {
            if (probeId > PendingProbeId) PendingProbeId = probeId;
            if (forceRebind) ForceRebindPending = true;
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
                            ApplyControl(monId, control, val, pnpId, gdiDev, isInt);
                        }
                    } else if (action == "set_brightness") {
                        string monId = ExtractJsonString(json, "monitorId");
                        string pnpId = ExtractJsonString(json, "pnpId");
                        string gdiDev = ExtractJsonString(json, "gdiDevice");
                        int val = ExtractJsonInt(json, "value", 50);
                        ApplyControl(monId, "brightness", val, pnpId, gdiDev);
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
                    if (int.TryParse(raw.Substring(i + 1, 4), NumberStyles.HexNumber, null, out code)) {
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
        sb.Append("\"cpuPower\":").Append(cpuPower.ToString("0.0", CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"cpuTemp\":").Append(cpuTemp).Append(',');
        sb.Append("\"igpuPower\":").Append(igpuPower.ToString("0.0", CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"igpuRam\":"); AppendEscapedJson(sb, igpuRam); sb.Append(',');
        sb.Append("\"cpuLimit\":").Append(cpuLimit).Append(',');
        sb.Append("\"ramUsed\":"); AppendEscapedJson(sb, ramUsed); sb.Append(',');
        sb.Append("\"pageUsed\":"); AppendEscapedJson(sb, pageUsed); sb.Append(',');
        sb.Append("\"commitUsed\":"); AppendEscapedJson(sb, commitUsed); sb.Append(',');
        sb.Append("\"gpuTemp\":").Append(gpuTemp).Append(',');
        sb.Append("\"coreClock\":").Append(coreClock).Append(',');
        sb.Append("\"memClock\":").Append(memClock).Append(',');
        sb.Append("\"gpuPower\":").Append(gpuPower.ToString("0.0", CultureInfo.InvariantCulture)).Append(',');
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
                    sb.Append("\"volume\":-1,");
                    sb.Append("\"inputSource\":").Append(m.inputSource).Append(',');
                    sb.Append("\"colorPreset\":").Append(m.colorPreset).Append(',');
                    sb.Append("\"powerMode\":-1,");
                    sb.Append("\"gamma\":-1,");
                    sb.Append("\"blackBoost\":-1,");
                    sb.Append("\"darkBoost\":-1,");
                    sb.Append("\"blackLevel\":-1,");
                    sb.Append("\"overdrive\":").Append(m.overdrive).Append(',');
                    sb.Append("\"strobing\":").Append(m.strobing).Append(',');
                    sb.Append("\"mprt\":").Append(m.mprt).Append(',');
                    sb.Append("\"freeSync\":").Append(m.freeSync).Append(',');
                    sb.Append("\"gameMode\":-1,");
                    sb.Append("\"superSharpness\":-1,");
                    sb.Append("\"blueLight\":-1");
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

public class Program {
    private static bool TryNvidiaSmiFallback(
        out double gpuTemp, out int coreClk, out int memClk, out double gpuWatt,
        out double vramUsedGB, out double vramTotalGB, out int vramPct, out int gpuLoad,
        out string pState, out string vrmBrake, out string hwThermal)
    {
        gpuTemp = 0.0; coreClk = 0; memClk = 0; gpuWatt = 0.0;
        vramUsedGB = 0.0; vramTotalGB = 0.0; vramPct = 0; gpuLoad = 0;
        pState = "Unknown"; vrmBrake = "Unknown"; hwThermal = "Unknown";
        try {
            var psi = new ProcessStartInfo {
                FileName = "nvidia-smi",
                Arguments = "--query-gpu=temperature.gpu,clocks.current.graphics,clocks.current.memory,power.draw,memory.used,memory.total,utilization.gpu,pstate,clocks_event_reasons.hw_power_brake_slowdown,clocks_event_reasons.hw_thermal_slowdown --format=csv,noheader,nounits",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            using (var proc = Process.Start(psi)) {
                string line = proc.StandardOutput.ReadLine();
                proc.WaitForExit();
                if (proc.ExitCode == 0 && !string.IsNullOrEmpty(line)) {
                    string[] parts = line.Trim().Split(',');
                    if (parts.Length >= 10) {
                        double.TryParse(parts[0].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out gpuTemp);
                        int.TryParse(parts[1].Trim(), out coreClk);
                        int.TryParse(parts[2].Trim(), out memClk);
                        double.TryParse(parts[3].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out gpuWatt);
                        double uMb = 0.0, tMb = 0.0;
                        double.TryParse(parts[4].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out uMb);
                        double.TryParse(parts[5].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out tMb);
                        vramUsedGB = Math.Round(uMb / 1024.0, 1);
                        vramTotalGB = Math.Round(tMb / 1024.0, 1);
                        vramPct = (tMb > 0) ? (int)Math.Round((uMb / tMb) * 100.0, 0) : 0;
                        int.TryParse(parts[6].Trim(), out gpuLoad);
                        pState = parts[7].Trim();
                        vrmBrake = parts[8].Trim();
                        hwThermal = parts[9].Trim();
                        return true;
                    }
                }
            }
        } catch {}
        return false;
    }

    public static void Main(string[] args) {
        int numThreads = Environment.ProcessorCount;
        int numPThreads = (numThreads > 16) ? (int)(numThreads * 0.6) : ((numThreads > 8) ? (int)(numThreads * 0.5) : numThreads);

        MonitorController.GetInstantCpuLoad();

        var friendlyNames = new Dictionary<string, string>();
        MonitorController.StartWorker(friendlyNames);

        bool hasNvmlDll = File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "nvml.dll"));
        if (hasNvmlDll) {
            NvmlHost.StartInitAsync();
        } else {
            NvmlHost.ReadyEvent.Set();
        }
        EmiHost.StartInitAsync();

        Thread d3dInitT = new Thread(() => { D3dKmtHost.Init(); });
        d3dInitT.IsBackground = true;
        d3dInitT.Start();

        Process parentObj = null;
        try {
            int parentPid = MonitorController.GetParentProcessId();
            if (parentPid > 0) parentObj = Process.GetProcessById(parentPid);
        } catch {}

        double totalRamGB = 16.0, ramUsedGB = 0.0;
        int ramPct = 0;
        double commitLimitGB = 16.0, commitUsedGB = 0.0;
        double commitPct = 0.0;
        double totalPageGB = 8.5, pageUsedGB = 0.0, pagePct = 0.0;
        double igpuSharedMB = 0.0;

        var memStat = new MonitorController.MEMORYSTATUSEX();
        memStat.dwLength = (uint)Marshal.SizeOf(typeof(MonitorController.MEMORYSTATUSEX));
        if (MonitorController.GlobalMemoryStatusEx(ref memStat)) {
            if (memStat.ullTotalPhys > 0) {
                totalRamGB = Math.Round(memStat.ullTotalPhys / (1024.0 * 1024.0 * 1024.0), 1);
                ramUsedGB = Math.Round((memStat.ullTotalPhys - memStat.ullAvailPhys) / (1024.0 * 1024.0 * 1024.0), 1);
                ramPct = (int)memStat.dwMemoryLoad;
            }
            if (memStat.ullTotalPageFile > 0) {
                commitLimitGB = Math.Round(memStat.ullTotalPageFile / (1024.0 * 1024.0 * 1024.0), 1);
                commitUsedGB = Math.Round((memStat.ullTotalPageFile - memStat.ullAvailPageFile) / (1024.0 * 1024.0 * 1024.0), 1);
                if (commitLimitGB > 0) commitPct = Math.Round((commitUsedGB / commitLimitGB) * 100.0, 0);
            }
            if (memStat.ullTotalPageFile > memStat.ullTotalPhys) {
                totalPageGB = Math.Round((memStat.ullTotalPageFile - memStat.ullTotalPhys) / (1024.0 * 1024.0 * 1024.0), 1);
            }
        }

        Stream stdout = Console.OpenStandardOutput();
        int cpuClock = 0;
        int cpuUtil = 0;
        int cpuLimit = 100;
        double cpuPower = 0.0;
        double igpuPower = 0.0;
        double sinkTemp = 0.0;
        double cpuEstTemp = 0.0;
        double prevCpuP = 0.0;
        bool isFirstTick = true;
        int warmupTicks = 0;
        bool isGamingLoad = false;
        int loadStreak = 0;
        int idleStreak = 0;
        bool emiFallbackChecked = false;

        try {
            while (MonitorController.IsRunning) {
                if (parentObj != null && parentObj.HasExited) {
                    MonitorController.IsRunning = false;
                    break;
                }

                // 1. GPU telemetry (NVML 0ms or nvidia-smi fallback)
                double rawGpuTemp = 0.0, rawGpuWatt = 0.0, vramUsedGB = 0.0, vramTotalGB = 0.0;
                int gpuCoreClk = 0, gpuMemClk = 0, gpuLoad = 0, vramPct = 0;
                string pStateStr = "Unknown", vrmBrakeStr = "Not Active", hwThermalStr = "Not Active";

                if (NvmlHost.IsReady) {
                    try {
                        uint temp = 0, pwr = 0, core = 0, memC = 0, pStateVal = 0;
                        ulong throttleMask = 0;
                        NvmlHost.NvmlUtilization util;
                        NvmlHost.NvmlMemory memInfo;
                        NvmlHost.GetTemperature(NvmlHost.DeviceHandle, 0, out temp);
                        NvmlHost.GetPowerUsage(NvmlHost.DeviceHandle, out pwr);
                        NvmlHost.GetUtilizationRates(NvmlHost.DeviceHandle, out util);
                        NvmlHost.GetMemoryInfo(NvmlHost.DeviceHandle, out memInfo);
                        NvmlHost.GetClockInfo(NvmlHost.DeviceHandle, 0, out core);
                        NvmlHost.GetClockInfo(NvmlHost.DeviceHandle, 2, out memC);
                        NvmlHost.GetPerformanceState(NvmlHost.DeviceHandle, out pStateVal);
                        if (NvmlHost.GetClocksThrottleReasons != null) {
                            NvmlHost.GetClocksThrottleReasons(NvmlHost.DeviceHandle, out throttleMask);
                        }
                        rawGpuTemp = temp;
                        rawGpuWatt = Math.Round(pwr / 1000.0, 1);
                        gpuCoreClk = (int)core;
                        gpuMemClk = (int)memC;
                        gpuLoad = (int)util.gpu;
                        pStateStr = "P" + pStateVal;
                        vramUsedGB = Math.Round(memInfo.used / (1024.0 * 1024.0 * 1024.0), 1);
                        vramTotalGB = Math.Round(memInfo.total / (1024.0 * 1024.0 * 1024.0), 1);
                        vramPct = (memInfo.total > 0) ? (int)Math.Round(((double)memInfo.used / (double)memInfo.total) * 100.0, 0) : 0;
                        hwThermalStr = ((throttleMask & 0x60ul) != 0) ? "Active" : "Not Active";
                        vrmBrakeStr = ((throttleMask & 0x80ul) != 0) ? "Active" : "Not Active";
                    } catch {}
                } else if (warmupTicks >= 3 && !hasNvmlDll) {
                    TryNvidiaSmiFallback(out rawGpuTemp, out gpuCoreClk, out gpuMemClk, out rawGpuWatt,
                        out vramUsedGB, out vramTotalGB, out vramPct, out gpuLoad,
                        out pStateStr, out vrmBrakeStr, out hwThermalStr);
                }

                // 2. CPU load and P/E core clocks (<1ms)
                int instantCpuLoad = MonitorController.GetInstantCpuLoad();
                if (instantCpuLoad > 0 || cpuUtil == 0) {
                    cpuUtil = instantCpuLoad;
                }

                double maxP = 0.0, maxE = 0.0;
                string peClock = "P: 0.0 GHz";
                var ntCores = MonitorController.GetProcessorPowerInfo();
                if (ntCores != null && ntCores.Length > 0) {
                    int lim = Math.Min(numThreads, ntCores.Length);
                    for (int th = 0; th < lim; th++) {
                        double mhz = ntCores[th].CurrentMhz;
                        if (th < numPThreads) {
                            if (mhz > maxP) maxP = mhz;
                        } else {
                            if (mhz > maxE) maxE = mhz;
                        }
                    }
                    if (maxP > 0) cpuClock = (int)Math.Round(maxP, 0);
                    string pGhz = (maxP / 1000.0).ToString("0.0", CultureInfo.InvariantCulture);
                    string eGhz = (maxE / 1000.0).ToString("0.0", CultureInfo.InvariantCulture);
                    peClock = (maxE > 0) ? ("P: " + pGhz + " GHz | E: " + eGhz + " GHz") : ("P: " + pGhz + " GHz");
                    if (ntCores[0].MaxMhz > 0 && ntCores[0].MhzLimit > 0) {
                        cpuLimit = Math.Min(100, (int)Math.Round(((double)ntCores[0].MhzLimit / (double)ntCores[0].MaxMhz) * 100.0, 0));
                    }
                }

                // 3. Direct EMI RAPL + D3DKMT Shared GPU Memory + EnumPageFilesW (<5ms, zero PDH cold delay)
                if (EmiHost.IsReady) {
                    double pkgW = 0.0, pp1W = 0.0;
                    if (EmiHost.Sample(out pkgW, out pp1W)) {
                        if (pkgW > 0.0) cpuPower = pkgW;
                        igpuPower = pp1W;
                    }
                } else if (EmiHost.ReadyEvent.WaitOne(0)) {
                    if (!emiFallbackChecked) {
                        emiFallbackChecked = true;
                        PdhHost.EnsureFallbackRaplInit();
                    }
                    double pkgW = 0.0, pp1W = 0.0;
                    PdhHost.SampleRaplFallback(out pkgW, out pp1W);
                    if (pkgW > 0.0) cpuPower = pkgW;
                    igpuPower = pp1W;
                }

                double shMb = D3dKmtHost.SampleMaxSharedMB();
                if (shMb > 0.0 || igpuSharedMB == 0.0) igpuSharedMB = shMb;

                double pfUsed = 0.0, pfTotal = 0.0, pfPct = 0.0;
                D3dKmtHost.SamplePageFile(out pfUsed, out pfTotal, out pfPct);
                if (pfTotal > 0.0) {
                    pageUsedGB = pfUsed;
                    totalPageGB = pfTotal;
                    pagePct = pfPct;
                }

                // 4. Physical & commit memory (<0.1ms)
                if (MonitorController.GlobalMemoryStatusEx(ref memStat)) {
                    ramUsedGB = Math.Round((memStat.ullTotalPhys - memStat.ullAvailPhys) / (1024.0 * 1024.0 * 1024.0), 1);
                    ramPct = (int)memStat.dwMemoryLoad;
                    if (memStat.ullTotalPageFile > 0 && commitLimitGB > 0) {
                        commitUsedGB = Math.Round((memStat.ullTotalPageFile - memStat.ullAvailPageFile) / (1024.0 * 1024.0 * 1024.0), 1);
                        commitPct = Math.Round((commitUsedGB / commitLimitGB) * 100.0, 0);
                    }
                }

                string igpuRamStr = (igpuSharedMB >= 1024.0)
                    ? ((igpuSharedMB / 1024.0).ToString("0.0", CultureInfo.InvariantCulture) + " GB")
                    : (igpuSharedMB.ToString("0", CultureInfo.InvariantCulture) + " MB");

                if (cpuPower <= 0.0) {
                    cpuPower = Math.Round(15.0 + (35.0 * (cpuUtil / 100.0)), 1);
                }

                // 5. Lumped-Parameter Continuous Thermal Observer
                double pTotal = cpuPower + rawGpuWatt;
                double rConv = 0.22 + (0.58 / (1.0 + Math.Pow(pTotal / 46.0, 1.4)));
                double sinkConv = 24.0 + (pTotal * rConv);
                double sinkGpu = (rawGpuTemp >= 28.0) ? Math.Max(24.0, rawGpuTemp - (rawGpuWatt * 0.14) + (cpuPower * 0.06)) : sinkConv;
                double sinkTarget = (rawGpuTemp >= 28.0) ? sinkGpu : sinkConv;

                sinkTemp = isFirstTick ? sinkTarget : (sinkTemp + 0.080 * (sinkTarget - sinkTemp));

                double boostFactor = Math.Max(0.0, Math.Min(1.0, (maxP - 3200.0) / 1500.0));
                double utilFactor = 1.0 - Math.Max(0.0, Math.Min(1.0, cpuUtil / 100.0));
                double rDie = 0.32 + (0.14 * boostFactor * utilFactor);

                double cpuTarget = sinkTemp + (cpuPower * rDie);
                if (cpuLimit < 100 && cpuPower > 35.0) {
                    double prochotFloor = 98.0 + Math.Min(2.0, (100.0 - cpuLimit) * 0.1);
                    if (cpuTarget < prochotFloor) cpuTarget = prochotFloor;
                }

                double dP = isFirstTick ? 0.0 : (cpuPower - prevCpuP);
                prevCpuP = cpuPower;
                double alphaCool = (dP < -5.0) ? Math.Max(0.12, 0.33 + (dP * 0.012)) : 0.33;

                if (isFirstTick) {
                    cpuEstTemp = cpuTarget;
                    isFirstTick = false;
                } else {
                    double alphaDie = (cpuTarget > cpuEstTemp) ? 0.86 : alphaCool;
                    cpuEstTemp += alphaDie * (cpuTarget - cpuEstTemp);
                }

                cpuEstTemp = Math.Max(Math.Max(24.0, sinkTemp), Math.Min(101.0, cpuEstTemp));
                int cpuTempInt = (int)Math.Round(cpuEstTemp, 0);

                // 6. Emit length-prefixed UTF-8 telemetry packet
                string payload = MonitorController.BuildTelemetryJson(
                    DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture),
                    cpuClock,
                    cpuUtil,
                    peClock,
                    cpuPower,
                    cpuTempInt,
                    igpuPower,
                    igpuRamStr,
                    cpuLimit,
                    ramUsedGB.ToString("0.0", CultureInfo.InvariantCulture) + " / " + totalRamGB.ToString("0.0", CultureInfo.InvariantCulture) + " GB (" + ramPct + "%)",
                    pageUsedGB.ToString("0.0", CultureInfo.InvariantCulture) + " / " + totalPageGB.ToString("0.0", CultureInfo.InvariantCulture) + " GB (" + pagePct.ToString("0", CultureInfo.InvariantCulture) + "%)",
                    commitUsedGB.ToString("0.0", CultureInfo.InvariantCulture) + " / " + commitLimitGB.ToString("0.0", CultureInfo.InvariantCulture) + " GB (" + commitPct.ToString("0", CultureInfo.InvariantCulture) + "%)",
                    (int)rawGpuTemp,
                    gpuCoreClk,
                    gpuMemClk,
                    Math.Round(rawGpuWatt, 1),
                    vramUsedGB.ToString("0.0", CultureInfo.InvariantCulture) + " / " + vramTotalGB.ToString("0.0", CultureInfo.InvariantCulture) + " GB (" + vramPct + "%)",
                    gpuLoad,
                    pStateStr,
                    vrmBrakeStr,
                    hwThermalStr
                );

                byte[] jsonBytes = Encoding.UTF8.GetBytes(payload);
                byte[] lengthPrefix = BitConverter.GetBytes((uint)jsonBytes.Length);
                stdout.Write(lengthPrefix, 0, 4);
                stdout.Write(jsonBytes, 0, jsonBytes.Length);
                stdout.Flush();

                warmupTicks++;

                bool instantLoad = (gpuLoad >= 20) || (rawGpuWatt >= 35.0) || (cpuPower >= 45.0);
                bool instantIdle = (gpuLoad <= 5) && (rawGpuWatt <= 20.0) && (cpuPower <= 25.0);

                if (instantLoad) {
                    loadStreak++;
                    idleStreak = 0;
                    if (loadStreak >= 2) isGamingLoad = true;
                } else if (instantIdle) {
                    idleStreak++;
                    loadStreak = 0;
                    if (idleStreak >= 3) isGamingLoad = false;
                } else {
                    loadStreak = 0;
                    idleStreak = 0;
                }

                int sleepInterval = (!MonitorController.HasProbed) ? 1800 : (isGamingLoad ? 800 : 1800);
                MonitorController.WakeSignal.WaitOne(sleepInterval);
            }
        } catch {}
        finally {
            MonitorController.IsRunning = false;
            try { MonitorController.ReleaseBoundMonitors(); } catch {}
            try { EmiHost.Shutdown(); } catch {}
            try { D3dKmtHost.Shutdown(); } catch {}
            try { PdhHost.Shutdown(); } catch {}
            if (parentObj != null) { try { parentObj.Dispose(); } catch {} }
            if (NvmlHost.IsReady && NvmlHost.Shutdown != null) {
                try { NvmlHost.Shutdown(); } catch {}
            }
        }
    }
}
