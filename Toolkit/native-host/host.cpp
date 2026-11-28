#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _CRT_SECURE_NO_WARNINGS
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <windows.h>
#include <objbase.h>
#include <oleauto.h>
#include <setupapi.h>
#include <physicalmonitorenumerationapi.h>
#include <highlevelmonitorconfigurationapi.h>
#include <lowlevelmonitorconfigurationapi.h>
#include <psapi.h>
#include <pdh.h>
#include <wbemidl.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "dxva2.lib")
#pragma comment(lib, "setupapi.lib")
#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "pdh.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "wbemuuid.lib")
#pragma comment(lib, "kernel32.lib")

namespace {

std::string WideToUtf8(const std::wstring& ws) {
    if (ws.empty()) return std::string();
    int len = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), nullptr, 0, nullptr, nullptr);
    if (len <= 0) return std::string();
    std::string out((size_t)len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), &out[0], len, nullptr, nullptr);
    return out;
}

std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    if (len <= 0) return std::wstring();
    std::wstring out((size_t)len, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], len);
    return out;
}

std::string ToLowerAscii(const std::string& s) {
    std::string out = s;
    for (size_t i = 0; i < out.size(); i++) {
        if (out[i] >= 'A' && out[i] <= 'Z') out[i] = (char)(out[i] + ('a' - 'A'));
    }
    return out;
}

bool ContainsCaseInsensitive(const std::string& hay, const std::string& needle) {
    if (needle.empty()) return true;
    std::string h = ToLowerAscii(hay);
    std::string n = ToLowerAscii(needle);
    return h.find(n) != std::string::npos;
}

bool EqualsCaseInsensitive(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    return ToLowerAscii(a) == ToLowerAscii(b);
}

bool StartsWithCaseInsensitive(const std::string& s, const std::string& prefix) {
    if (s.size() < prefix.size()) return false;
    return ToLowerAscii(s.substr(0, prefix.size())) == ToLowerAscii(prefix);
}

std::string FormatFixed1(double val) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.1f", val);
    return std::string(buf);
}

std::string FormatFixed0(double val) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.0f", val);
    return std::string(buf);
}

void AppendEscapedJson(std::string& sb, const std::string& s, bool isNull = false) {
    if (isNull) {
        sb += "null";
        return;
    }
    sb.push_back('"');
    for (size_t i = 0; i < s.size(); i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '\\': sb += "\\\\"; break;
            case '"':  sb += "\\\""; break;
            case '\n': sb += "\\n"; break;
            case '\r': sb += "\\r"; break;
            case '\t': sb += "\\t"; break;
            case '\b': sb += "\\b"; break;
            case '\f': sb += "\\f"; break;
            default:
                if (c < 32) {
                    char u[8];
                    std::snprintf(u, sizeof(u), "\\u%04x", (unsigned int)c);
                    sb += u;
                } else {
                    sb.push_back((char)c);
                }
                break;
        }
    }
    sb.push_back('"');
}

std::string ExtractJsonString(const std::string& json, const std::string& key) {
    if (json.empty()) return std::string();
    std::string search = "\"" + key + "\"";
    size_t idx = json.find(search);
    if (idx == std::string::npos) return std::string();
    size_t colon = json.find(':', idx + search.size());
    if (colon == std::string::npos) return std::string();
    size_t start = colon + 1;
    while (start < json.size() && (json[start] == ' ' || json[start] == '\t' || json[start] == '\r' || json[start] == '\n')) start++;
    if (start >= json.size() || json[start] != '"') return std::string();
    size_t quoteEnd = start + 1;
    while (quoteEnd < json.size()) {
        if (json[quoteEnd] == '"') {
            int bsCount = 0;
            size_t back = quoteEnd - 1;
            while (back >= start && json[back] == '\\') {
                bsCount++;
                if (back == 0) break;
                back--;
            }
            if ((bsCount % 2) == 0) break;
        }
        quoteEnd++;
    }
    if (quoteEnd >= json.size()) return std::string();
    std::string raw = json.substr(start + 1, quoteEnd - start - 1);
    std::string out;
    out.reserve(raw.size());
    for (size_t i = 0; i < raw.size(); i++) {
        if (raw[i] == '\\' && i + 1 < raw.size()) {
            i++;
            char c = raw[i];
            if (c == '"') out.push_back('"');
            else if (c == '\\') out.push_back('\\');
            else if (c == '/') out.push_back('/');
            else if (c == 'b') out.push_back('\b');
            else if (c == 'f') out.push_back('\f');
            else if (c == 'n') out.push_back('\n');
            else if (c == 'r') out.push_back('\r');
            else if (c == 't') out.push_back('\t');
            else if (c == 'u' && i + 4 < raw.size()) {
                unsigned int code = 0;
                if (std::sscanf(raw.substr(i + 1, 4).c_str(), "%x", &code) == 1) {
                    if (code < 0x80) {
                        out.push_back((char)code);
                    } else {
                        wchar_t wc = (wchar_t)code;
                        out += WideToUtf8(std::wstring(1, wc));
                    }
                    i += 4;
                } else {
                    out.push_back('\\');
                    out.push_back(c);
                }
            } else {
                out.push_back(c);
            }
        } else {
            out.push_back(raw[i]);
        }
    }
    return out;
}

int ExtractJsonInt(const std::string& json, const std::string& key, int defaultVal) {
    if (json.empty()) return defaultVal;
    std::string search = "\"" + key + "\"";
    size_t idx = json.find(search);
    if (idx == std::string::npos) return defaultVal;
    size_t colon = json.find(':', idx + search.size());
    if (colon == std::string::npos) return defaultVal;
    size_t start = colon + 1;
    while (start < json.size() && (json[start] == ' ' || json[start] == '\t' || json[start] == '\r' || json[start] == '\n')) start++;
    size_t end = start;
    while (end < json.size() && ((json[end] >= '0' && json[end] <= '9') || json[end] == '-')) end++;
    if (end > start) {
        return std::atoi(json.substr(start, end - start).c_str());
    }
    return defaultVal;
}

bool ExtractJsonBool(const std::string& json, const std::string& key, bool defaultVal) {
    if (json.empty()) return defaultVal;
    std::string search = "\"" + key + "\"";
    size_t idx = json.find(search);
    if (idx == std::string::npos) return defaultVal;
    size_t colon = json.find(':', idx + search.size());
    if (colon == std::string::npos) return defaultVal;
    size_t start = colon + 1;
    while (start < json.size() && (json[start] == ' ' || json[start] == '\t' || json[start] == '\r' || json[start] == '\n')) start++;
    if (start + 4 <= json.size() && EqualsCaseInsensitive(json.substr(start, 4), "true")) return true;
    if (start + 5 <= json.size() && EqualsCaseInsensitive(json.substr(start, 5), "false")) return false;
    return defaultVal;
}

} // namespace

// ============================================================================
// NVML Dynamic GPU Host (0ms per-sample latency)
// ============================================================================
namespace NvmlHost {

#pragma pack(push, 8)
struct NvmlUtilization {
    unsigned int gpu;
    unsigned int memory;
};
struct NvmlMemory {
    unsigned long long total;
    unsigned long long free;
    unsigned long long used;
};
#pragma pack(pop)

using NvmlInitFn = int (*)();
using NvmlShutdownFn = int (*)();
using NvmlGetHandleFn = int (*)(unsigned int, void**);
using NvmlGetTempFn = int (*)(void*, unsigned int, unsigned int*);
using NvmlGetPowerFn = int (*)(void*, unsigned int*);
using NvmlGetUtilFn = int (*)(void*, NvmlUtilization*);
using NvmlGetMemFn = int (*)(void*, NvmlMemory*);
using NvmlGetClockFn = int (*)(void*, unsigned int, unsigned int*);
using NvmlGetPStateFn = int (*)(void*, unsigned int*);
using NvmlGetThrottleFn = int (*)(void*, unsigned long long*);

NvmlInitFn Init = nullptr;
NvmlShutdownFn Shutdown = nullptr;
NvmlGetHandleFn GetHandleByIndex = nullptr;
NvmlGetTempFn GetTemperature = nullptr;
NvmlGetPowerFn GetPowerUsage = nullptr;
NvmlGetUtilFn GetUtilizationRates = nullptr;
NvmlGetMemFn GetMemoryInfo = nullptr;
NvmlGetClockFn GetClockInfo = nullptr;
NvmlGetPStateFn GetPerformanceState = nullptr;
NvmlGetThrottleFn GetClocksThrottleReasons = nullptr;

std::atomic<bool> IsReady{false};
void* DeviceHandle = nullptr;
HANDLE ReadyEvent = nullptr;
std::thread InitThread;

void StartInitAsync() {
    if (!ReadyEvent) ReadyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    InitThread = std::thread([]() {
        HMODULE hMod = LoadLibraryW(L"nvml.dll");
        if (hMod) {
            auto pInit = (NvmlInitFn)GetProcAddress(hMod, "nvmlInit_v2");
            if (!pInit) pInit = (NvmlInitFn)GetProcAddress(hMod, "nvmlInit");
            if (pInit) {
                Init = pInit;
                Shutdown = (NvmlShutdownFn)GetProcAddress(hMod, "nvmlShutdown");
                auto pHdl = (NvmlGetHandleFn)GetProcAddress(hMod, "nvmlDeviceGetHandleByIndex_v2");
                if (!pHdl) pHdl = (NvmlGetHandleFn)GetProcAddress(hMod, "nvmlDeviceGetHandleByIndex");
                GetHandleByIndex = pHdl;
                GetTemperature = (NvmlGetTempFn)GetProcAddress(hMod, "nvmlDeviceGetTemperature");
                GetPowerUsage = (NvmlGetPowerFn)GetProcAddress(hMod, "nvmlDeviceGetPowerUsage");
                GetUtilizationRates = (NvmlGetUtilFn)GetProcAddress(hMod, "nvmlDeviceGetUtilizationRates");
                GetMemoryInfo = (NvmlGetMemFn)GetProcAddress(hMod, "nvmlDeviceGetMemoryInfo");
                GetClockInfo = (NvmlGetClockFn)GetProcAddress(hMod, "nvmlDeviceGetClockInfo");
                GetPerformanceState = (NvmlGetPStateFn)GetProcAddress(hMod, "nvmlDeviceGetPerformanceState");
                GetClocksThrottleReasons = (NvmlGetThrottleFn)GetProcAddress(hMod, "nvmlDeviceGetCurrentClocksThrottleReasons");
                if (Init && Init() == 0 && GetHandleByIndex && GetHandleByIndex(0, &DeviceHandle) == 0) {
                    IsReady.store(true);
                }
            }
        }
        SetEvent(ReadyEvent);
    });
}

void WaitShutdown() {
    if (InitThread.joinable()) InitThread.join();
}

} // namespace NvmlHost

// ============================================================================
// Direct Kernel EMI RAPL Host
// ============================================================================
namespace EmiHost {

constexpr DWORD IOCTL_EMI_GET_VERSION = 0x224000u;
constexpr DWORD IOCTL_EMI_GET_METADATA_SIZE = 0x224004u;
constexpr DWORD IOCTL_EMI_GET_METADATA = 0x224008u;
constexpr DWORD IOCTL_EMI_GET_MEASUREMENT = 0x22400Cu;
constexpr double PICOWATT_HOURS_PER_100NS_TO_WATTS = 0.036;

std::atomic<bool> IsReady{false};
HANDLE ReadyEvent = nullptr;
std::mutex EmiMutex;
HANDLE DeviceHandle = INVALID_HANDLE_VALUE;
std::vector<uint8_t> MeasBuffer;
int ChannelCount = 0;
int PkgChannel = -1;
int Pp1Channel = -1;
uint64_t PrevPkgEnergy = 0;
uint64_t PrevPkgTime = 0;
uint64_t PrevPp1Energy = 0;
uint64_t PrevPp1Time = 0;
std::thread InitThread;

void StartInitAsync() {
    if (!ReadyEvent) ReadyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    InitThread = std::thread([]() {
        GUID emiGuid = { 0x45BD8344, 0x7ED6, 0x49CF, { 0xA4, 0x40, 0xC2, 0x76, 0xC9, 0x33, 0xB0, 0x53 } };
        HDEVINFO devInfo = SetupDiGetClassDevsW(&emiGuid, nullptr, nullptr, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
        if (devInfo != INVALID_HANDLE_VALUE) {
            SP_DEVICE_INTERFACE_DATA did{};
            did.cbSize = sizeof(SP_DEVICE_INTERFACE_DATA);
            for (DWORD idx = 0; SetupDiEnumDeviceInterfaces(devInfo, nullptr, &emiGuid, idx, &did); idx++) {
                DWORD req = 0;
                SetupDiGetDeviceInterfaceDetailW(devInfo, &did, nullptr, 0, &req, nullptr);
                if (req == 0) continue;
                std::vector<uint8_t> detBuf(req, 0);
                auto det = reinterpret_cast<PSP_DEVICE_INTERFACE_DETAIL_DATA_W>(detBuf.data());
                det->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);
                if (!SetupDiGetDeviceInterfaceDetailW(devInfo, &did, det, req, &req, nullptr)) continue;

                HANDLE hEmi = CreateFileW(det->DevicePath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
                if (hEmi == INVALID_HANDLE_VALUE) continue;

                bool accepted = false;
                uint8_t vBuf[64]{};
                DWORD bRet = 0;
                if (DeviceIoControl(hEmi, IOCTL_EMI_GET_VERSION, nullptr, 0, vBuf, sizeof(vBuf), &bRet, nullptr) && bRet >= 2) {
                    int16_t ver = 0;
                    std::memcpy(&ver, vBuf, 2);
                    if (ver == 2 && DeviceIoControl(hEmi, IOCTL_EMI_GET_METADATA_SIZE, nullptr, 0, vBuf, sizeof(vBuf), &bRet, nullptr) && bRet >= 4) {
                        int32_t mSize = 0;
                        std::memcpy(&mSize, vBuf, 4);
                        if (mSize >= 68) {
                            std::vector<uint8_t> mBuf((size_t)mSize, 0);
                            if (DeviceIoControl(hEmi, IOCTL_EMI_GET_METADATA, nullptr, 0, mBuf.data(), (DWORD)mSize, &bRet, nullptr) && bRet >= 68) {
                                uint16_t chCount = 0;
                                std::memcpy(&chCount, mBuf.data() + 66, 2);
                                int pkgIdx = -1, pp1Idx = -1;
                                size_t off = 68;
                                for (int i = 0; i < (int)chCount && off + 6 <= (size_t)bRet; i++) {
                                    int32_t unit = 0;
                                    uint16_t nSize = 0;
                                    std::memcpy(&unit, mBuf.data() + off, 4);
                                    std::memcpy(&nSize, mBuf.data() + off + 4, 2);
                                    if (off + 6 + nSize <= (size_t)bRet && nSize >= 2 && unit == 0) {
                                        size_t wcharLen = nSize / 2;
                                        std::wstring chName(wcharLen, L'\0');
                                        std::memcpy(&chName[0], mBuf.data() + off + 6, wcharLen * 2);
                                        while (!chName.empty() && chName.back() == L'\0') chName.pop_back();
                                        if (chName == L"RAPL_Package0_PKG") pkgIdx = i;
                                        else if (chName == L"RAPL_Package0_PP1") pp1Idx = i;
                                    }
                                    off += 6 + nSize;
                                }
                                if (pkgIdx >= 0 || pp1Idx >= 0) {
                                    std::vector<uint8_t> mData((size_t)chCount * 16, 0);
                                    DWORD measBytes = 0;
                                    if (DeviceIoControl(hEmi, IOCTL_EMI_GET_MEASUREMENT, nullptr, 0, mData.data(), (DWORD)mData.size(), &measBytes, nullptr) && measBytes >= (DWORD)mData.size()) {
                                        std::lock_guard<std::mutex> lock(EmiMutex);
                                        DeviceHandle = hEmi;
                                        ChannelCount = (int)chCount;
                                        PkgChannel = pkgIdx;
                                        Pp1Channel = pp1Idx;
                                        MeasBuffer = std::move(mData);
                                        if (pkgIdx >= 0) {
                                            std::memcpy(&PrevPkgEnergy, MeasBuffer.data() + pkgIdx * 16, 8);
                                            std::memcpy(&PrevPkgTime, MeasBuffer.data() + pkgIdx * 16 + 8, 8);
                                        }
                                        if (pp1Idx >= 0) {
                                            std::memcpy(&PrevPp1Energy, MeasBuffer.data() + pp1Idx * 16, 8);
                                            std::memcpy(&PrevPp1Time, MeasBuffer.data() + pp1Idx * 16 + 8, 8);
                                        }
                                        IsReady.store(true);
                                        accepted = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                if (!accepted) CloseHandle(hEmi);
            }
            SetupDiDestroyDeviceInfoList(devInfo);
        }
        SetEvent(ReadyEvent);
    });
}

bool Sample(double& pkgWatts, double& igpuWatts) {
    pkgWatts = 0.0;
    igpuWatts = 0.0;
    std::lock_guard<std::mutex> lock(EmiMutex);
    if (!IsReady.load() || DeviceHandle == INVALID_HANDLE_VALUE || MeasBuffer.empty()) return false;
    DWORD bytesRet = 0;
    DWORD bufSz = (DWORD)MeasBuffer.size();
    if (!DeviceIoControl(DeviceHandle, IOCTL_EMI_GET_MEASUREMENT, nullptr, 0, MeasBuffer.data(), bufSz, &bytesRet, nullptr) || bytesRet < bufSz) {
        return false;
    }
    if (PkgChannel >= 0) {
        uint64_t e = 0, t = 0;
        std::memcpy(&e, MeasBuffer.data() + PkgChannel * 16, 8);
        std::memcpy(&t, MeasBuffer.data() + PkgChannel * 16 + 8, 8);
        if (t > PrevPkgTime && e >= PrevPkgEnergy) {
            pkgWatts = std::round((((double)(e - PrevPkgEnergy) * PICOWATT_HOURS_PER_100NS_TO_WATTS) / (double)(t - PrevPkgTime)) * 10.0) / 10.0;
        }
        PrevPkgEnergy = e;
        PrevPkgTime = t;
    }
    if (Pp1Channel >= 0) {
        uint64_t e = 0, t = 0;
        std::memcpy(&e, MeasBuffer.data() + Pp1Channel * 16, 8);
        std::memcpy(&t, MeasBuffer.data() + Pp1Channel * 16 + 8, 8);
        if (t > PrevPp1Time && e >= PrevPp1Energy) {
            igpuWatts = std::round((((double)(e - PrevPp1Energy) * PICOWATT_HOURS_PER_100NS_TO_WATTS) / (double)(t - PrevPp1Time)) * 10.0) / 10.0;
        }
        PrevPp1Energy = e;
        PrevPp1Time = t;
    }
    return true;
}

void Shutdown() {
    if (InitThread.joinable()) InitThread.join();
    std::lock_guard<std::mutex> lock(EmiMutex);
    IsReady.store(false);
    if (DeviceHandle != INVALID_HANDLE_VALUE) {
        CloseHandle(DeviceHandle);
        DeviceHandle = INVALID_HANDLE_VALUE;
    }
    MeasBuffer.clear();
}

} // namespace EmiHost

// ============================================================================
// Direct Kernel D3DKMT Shared GPU Memory + EnumPageFilesW Host
// ============================================================================
namespace D3dKmtHost {

struct CT_LUID {
    uint32_t LowPart;
    int32_t HighPart;
};

struct CT_D3DKMT_ENUMADAPTERS2 {
    uint32_t NumAdapters;
    void* pAdapters;
};

struct CT_D3DKMT_ADAPTERINFO {
    uint32_t hAdapter;
    CT_LUID AdapterLuid;
    uint32_t NumOfSources;
    int32_t bPresentMoveRegionsPreferred;
};

struct CT_D3DKMT_CLOSEADAPTER {
    uint32_t hAdapter;
};

struct CT_QS_COUNTER { uint32_t Count; uint64_t Bytes; };
struct CT_QS_DMA_PKT { uint32_t a, b, c, d; };
struct CT_QS_QUEUE_PKT { uint32_t a, b; };
struct CT_QS_PKT_INFO { CT_QS_QUEUE_PKT QueuePacket[8]; CT_QS_DMA_PKT DmaPacket[4]; };
struct CT_QS_PREEMPT_INFO { uint32_t PreemptionCounter[16]; };
struct CT_QS_PROC_NODE_INFO {
    int64_t RunningTime;
    uint32_t ContextSwitch;
    CT_QS_PREEMPT_INFO PreemptionStatistics;
    CT_QS_PKT_INFO PacketStatistics;
    uint64_t Reserved[8];
};
struct CT_QS_NODE_INFO {
    CT_QS_PROC_NODE_INFO GlobalInformation;
    CT_QS_PROC_NODE_INFO SystemInformation;
    uint64_t Reserved[8];
};
struct CT_QS_MEM { uint64_t TotalBytesEvicted; uint32_t AllocsCommitted; uint32_t AllocsResident; };
struct CT_QS_SEG_INFO {
    uint64_t CommitLimit;
    uint64_t BytesCommitted;
    uint64_t BytesResident;
    CT_QS_MEM Memory;
    uint32_t Aperture;
    uint64_t TotalBytesEvictedByPriority[5];
    uint64_t SystemMemoryEndAddress;
    uint64_t PowerFlags;
    uint64_t Reserved[6];
};
struct CT_QS_REF_DMA { uint32_t f[14]; };
struct CT_QS_RENAMING { uint32_t f[9]; };
struct CT_QS_PREP { uint32_t f[4]; CT_QS_COUNTER AllocationsTrimmed; };
struct CT_QS_PAGING_FAULT { CT_QS_COUNTER c1[10]; uint32_t f0, f1; CT_QS_COUNTER c2[6]; };
struct CT_QS_PAGING_TRANSFER { uint64_t f[8]; };
struct CT_QS_SWIZZLING { uint32_t a, b; };
struct CT_QS_LOCKS { uint32_t f[7]; };
struct CT_QS_ALLOC { CT_QS_COUNTER c[7]; };
struct CT_QS_TERM { CT_QS_COUNTER c[4]; };
struct CT_QS_ADAPTER_INFO {
    uint32_t NbSegments, NodeCount, VidPnSourceCount, VSyncEnabled, TdrDetectedCount;
    int64_t ZeroLengthDmaBuffers;
    uint64_t RestartedPeriod;
    CT_QS_REF_DMA ReferenceDmaBuffer;
    CT_QS_RENAMING Renaming;
    CT_QS_PREP Preparation;
    CT_QS_PAGING_FAULT PagingFault;
    CT_QS_PAGING_TRANSFER PagingTransfer;
    CT_QS_SWIZZLING SwizzlingRange;
    CT_QS_LOCKS Locks;
    CT_QS_ALLOC Allocations;
    CT_QS_TERM Terminations;
    uint64_t Reserved[8];
};

using EnumAdapters2Fn = int (WINAPI*)(CT_D3DKMT_ENUMADAPTERS2*);
using CloseAdapterFn = int (WINAPI*)(CT_D3DKMT_CLOSEADAPTER*);
using QueryStatsFn = int (WINAPI*)(void*);

struct AdapterEntry {
    CT_LUID Luid;
    std::vector<uint32_t> ApertureSegments;
};

std::mutex D3dMutex;
EnumAdapters2Fn pEnumAdapters2 = nullptr;
CloseAdapterFn pCloseAdapter = nullptr;
QueryStatsFn pQueryStatistics = nullptr;
bool HasCachedAdapters = false;
std::vector<AdapterEntry> CachedAdapters;
std::vector<uint8_t> QueryBuf;
int HdrSize = 0;
int ResultSize = 0;
double PageSizeBytes = 4096.0;

void Init() {
    std::lock_guard<std::mutex> lock(D3dMutex);
    PERFORMANCE_INFORMATION pi{};
    pi.cb = sizeof(PERFORMANCE_INFORMATION);
    if (GetPerformanceInfo(&pi, pi.cb) && pi.PageSize > 0) {
        PageSizeBytes = (double)pi.PageSize;
    }
    if (HasCachedAdapters) return;
    HasCachedAdapters = true;

    HMODULE hGdi = GetModuleHandleW(L"gdi32.dll");
    if (!hGdi) hGdi = LoadLibraryW(L"gdi32.dll");
    if (!hGdi) return;
    pEnumAdapters2 = (EnumAdapters2Fn)GetProcAddress(hGdi, "D3DKMTEnumAdapters2");
    pCloseAdapter = (CloseAdapterFn)GetProcAddress(hGdi, "D3DKMTCloseAdapter");
    pQueryStatistics = (QueryStatsFn)GetProcAddress(hGdi, "D3DKMTQueryStatistics");
    if (!pEnumAdapters2 || !pCloseAdapter || !pQueryStatistics) return;

    int szAd = (int)sizeof(CT_QS_ADAPTER_INFO);
    int szNode = (int)sizeof(CT_QS_NODE_INFO);
    int szSeg = (int)sizeof(CT_QS_SEG_INFO);
    ResultSize = std::max(szAd, std::max(szNode, szSeg));
    HdrSize = (sizeof(void*) == 8) ? 24 : 16;
    QueryBuf.assign((size_t)(HdrSize + ResultSize + 64), 0);

    CT_D3DKMT_ENUMADAPTERS2 ea{};
    if (pEnumAdapters2(&ea) == 0 && ea.NumAdapters > 0) {
        std::vector<CT_D3DKMT_ADAPTERINFO> ads(ea.NumAdapters);
        ea.pAdapters = ads.data();
        if (pEnumAdapters2(&ea) == 0) {
            std::unordered_set<int64_t> seen;
            for (uint32_t i = 0; i < ea.NumAdapters; i++) {
                const auto& info = ads[i];
                int64_t lk = ((int64_t)info.AdapterLuid.HighPart << 32) | info.AdapterLuid.LowPart;
                if (seen.insert(lk).second) {
                    std::fill(QueryBuf.begin(), QueryBuf.end(), 0);
                    int32_t qType = 0;
                    std::memcpy(QueryBuf.data() + 0, &qType, 4);
                    std::memcpy(QueryBuf.data() + 4, &info.AdapterLuid.LowPart, 4);
                    std::memcpy(QueryBuf.data() + 8, &info.AdapterLuid.HighPart, 4);
                    if (pQueryStatistics(QueryBuf.data()) == 0) {
                        uint32_t nbSegs = 0;
                        std::memcpy(&nbSegs, QueryBuf.data() + HdrSize, 4);
                        AdapterEntry entry;
                        entry.Luid = info.AdapterLuid;
                        for (uint32_t s = 0; s < nbSegs; s++) {
                            std::fill(QueryBuf.begin(), QueryBuf.end(), 0);
                            int32_t qSeg = 3;
                            int32_t segId = (int32_t)s;
                            std::memcpy(QueryBuf.data() + 0, &qSeg, 4);
                            std::memcpy(QueryBuf.data() + 4, &info.AdapterLuid.LowPart, 4);
                            std::memcpy(QueryBuf.data() + 8, &info.AdapterLuid.HighPart, 4);
                            std::memcpy(QueryBuf.data() + HdrSize + ResultSize, &segId, 4);
                            if (pQueryStatistics(QueryBuf.data()) == 0) {
                                CT_QS_SEG_INFO segInfo{};
                                std::memcpy(&segInfo, QueryBuf.data() + HdrSize, sizeof(CT_QS_SEG_INFO));
                                if (segInfo.Aperture == 1) {
                                    entry.ApertureSegments.push_back(s);
                                }
                            }
                        }
                        if (!entry.ApertureSegments.empty()) {
                            CachedAdapters.push_back(std::move(entry));
                        }
                    }
                }
                CT_D3DKMT_CLOSEADAPTER cl{ info.hAdapter };
                pCloseAdapter(&cl);
            }
        }
    }
}

double SampleMaxSharedMB() {
    std::lock_guard<std::mutex> lock(D3dMutex);
    if (!HasCachedAdapters || !pQueryStatistics || QueryBuf.empty()) return 0.0;
    double maxMb = 0.0;
    for (size_t i = 0; i < CachedAdapters.size(); i++) {
        const auto& ad = CachedAdapters[i];
        uint64_t sharedBytes = 0;
        for (size_t j = 0; j < ad.ApertureSegments.size(); j++) {
            std::fill(QueryBuf.begin(), QueryBuf.end(), 0);
            int32_t qSeg = 3;
            int32_t segId = (int32_t)ad.ApertureSegments[j];
            std::memcpy(QueryBuf.data() + 0, &qSeg, 4);
            std::memcpy(QueryBuf.data() + 4, &ad.Luid.LowPart, 4);
            std::memcpy(QueryBuf.data() + 8, &ad.Luid.HighPart, 4);
            std::memcpy(QueryBuf.data() + HdrSize + ResultSize, &segId, 4);
            if (pQueryStatistics(QueryBuf.data()) == 0) {
                CT_QS_SEG_INFO segInfo{};
                std::memcpy(&segInfo, QueryBuf.data() + HdrSize, sizeof(CT_QS_SEG_INFO));
                sharedBytes += segInfo.BytesResident;
            }
        }
        double mb = std::round((double)sharedBytes / (1024.0 * 1024.0));
        if (mb > maxMb) maxMb = mb;
    }
    return maxMb;
}

struct PageFileAccum {
    uint64_t totalPages = 0;
    uint64_t usedPages = 0;
};

BOOL CALLBACK EnumPageFileCb(LPVOID pContext, PENUM_PAGE_FILE_INFORMATION pInfo, LPCWSTR) {
    auto* acc = reinterpret_cast<PageFileAccum*>(pContext);
    acc->totalPages += (uint64_t)pInfo->TotalSize;
    acc->usedPages += (uint64_t)pInfo->TotalInUse;
    return TRUE;
}

void SamplePageFile(double& usedGB, double& totalGB, double& pct) {
    usedGB = 0.0;
    totalGB = 0.0;
    pct = 0.0;
    PageFileAccum acc{};
    EnumPageFilesW(EnumPageFileCb, &acc);
    if (acc.totalPages > 0) {
        totalGB = std::round((((double)acc.totalPages * PageSizeBytes) / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
        usedGB = std::round((((double)acc.usedPages * PageSizeBytes) / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
        pct = std::round(((double)acc.usedPages * 100.0) / (double)acc.totalPages);
    }
}

void Shutdown() {
    std::lock_guard<std::mutex> lock(D3dMutex);
    CachedAdapters.clear();
    QueryBuf.clear();
}

} // namespace D3dKmtHost

// ============================================================================
// PDH Fallback RAPL Host
// ============================================================================
namespace PdhHost {

std::mutex PdhMutex;
std::atomic<bool> IsInitialized{false};
PDH_HQUERY Query = nullptr;
PDH_HCOUNTER cPkg = nullptr;
PDH_HCOUNTER cPp1 = nullptr;

void EnsureFallbackRaplInit() {
    if (IsInitialized.load()) return;
    std::lock_guard<std::mutex> lock(PdhMutex);
    if (IsInitialized.load()) return;
    PDH_HQUERY q = nullptr;
    if (PdhOpenQueryW(nullptr, 0, &q) == ERROR_SUCCESS) {
        PDH_HCOUNTER hPkg = nullptr, hPp1 = nullptr;
        if (PdhAddEnglishCounterW(q, L"\\Energy Meter(RAPL_Package0_PKG)\\Power", 0, &hPkg) != ERROR_SUCCESS) hPkg = nullptr;
        if (PdhAddEnglishCounterW(q, L"\\Energy Meter(RAPL_Package0_PP1)\\Power", 0, &hPp1) != ERROR_SUCCESS) hPp1 = nullptr;
        if (hPkg || hPp1) {
            PdhCollectQueryData(q);
            Query = q;
            cPkg = hPkg;
            cPp1 = hPp1;
            IsInitialized.store(true);
            return;
        }
        PdhCloseQuery(q);
    }
}

void SampleRaplFallback(double& pkgWatts, double& igpuWatts) {
    pkgWatts = 0.0;
    igpuWatts = 0.0;
    std::lock_guard<std::mutex> lock(PdhMutex);
    if (!IsInitialized.load() || !Query) return;
    PdhCollectQueryData(Query);
    PDH_FMT_COUNTERVALUE v{};
    if (cPkg && PdhGetFormattedCounterValue(cPkg, PDH_FMT_DOUBLE, nullptr, &v) == ERROR_SUCCESS && v.CStatus == 0) {
        pkgWatts = std::round((v.doubleValue / 1000.0) * 10.0) / 10.0;
    }
    if (cPp1 && PdhGetFormattedCounterValue(cPp1, PDH_FMT_DOUBLE, nullptr, &v) == ERROR_SUCCESS && v.CStatus == 0) {
        igpuWatts = std::round((v.doubleValue / 1000.0) * 10.0) / 10.0;
    }
}

void Shutdown() {
    std::lock_guard<std::mutex> lock(PdhMutex);
    IsInitialized.store(false);
    if (Query) {
        PdhCloseQuery(Query);
        Query = nullptr;
    }
}

} // namespace PdhHost

// ============================================================================
// Display Control, DDC/CI Empirical Probing & Telemetry Serialization
// ============================================================================
namespace MonitorController {

struct DisplayDeviceItem {
    std::string id;
    std::string pnpId;
    std::string gdiDevice;
    std::string name;
    int windowsDisplayNumber = 1;
    int width = 0;
    int height = 0;
    bool isInternal = false;
    int brightness = -1;
    int contrast = -1;
    int gainR = -1;
    int gainG = -1;
    int gainB = -1;
    int inputSource = -1;
    int colorPreset = -1;
    int overdrive = -1;
    int strobing = -1;
    int mprt = -1;
    int freeSync = -1;
    int vcpMask = -1;
};

struct BoundPhysicalMonitor {
    std::string id;
    HANDLE hPhys = nullptr;
    std::shared_ptr<std::vector<PHYSICAL_MONITOR>> monitorSet;
    std::string gdiDevice;
    std::string pnpId;
    std::string name;
    int windowsDisplayNumber = 1;
    int width = 0;
    int height = 0;
    bool isInternal = false;
    int initialBrightness = -1;
};

struct TelemetryUpdateItem {
    std::string id;
    bool isInternal = false;
    uint8_t curLcd = 50;
    int brightVal = -1;
    int contrastVal = -1;
    int rGain = -1, gGain = -1, bGain = -1;
    int preset = -1;
    int input = -1, strobing = -1, mprt = -1, od = -1, fs = -1;
    int vcpMask = -1;
    std::string friendlyName;
};

constexpr int VCP_MASK_COLOR_PRESET = 1 << 0;
constexpr int VCP_MASK_RGB_GAINS = 1 << 1;
constexpr int VCP_MASK_INPUT_SOURCE = 1 << 2;
constexpr int VCP_MASK_FREESYNC = 1 << 3;
constexpr int VCP_MASK_VRB_E5 = 1 << 4;
constexpr int VCP_MASK_VRB_EF = 1 << 5;
constexpr int VCP_MASK_OVERDRIVE = 1 << 6;

std::atomic<bool> IsRunning{true};
std::atomic<bool> HasProbed{false};
std::atomic<bool> IsProbing{false};
std::atomic<bool> ProbePending{false};
std::atomic<bool> ForceRebindPending{false};
std::atomic<bool> ForceFullVcpDiscovery{false};
std::atomic<int> PendingProbeId{0};
std::atomic<int> CompletedProbeId{0};
HANDLE WakeSignal = nullptr;
HANDLE ProbeReadyEvent = nullptr;

std::vector<DisplayDeviceItem> CurrentMonitors;
std::vector<BoundPhysicalMonitor> BoundMonitors;
std::map<std::string, std::string> SavedFriendlyNames;
std::unordered_map<std::string, int> SavedVcpMasks;
std::unordered_map<std::string, std::string> EdidNameCache;
std::string SavedInternalPnpId;
std::mutex SyncMutex;
std::mutex ProbeMutex;
std::thread ProbeThread;
std::thread StdinThread;

int internalContrast = 50;
int internalGainR = 50;
int internalGainG = 50;
int internalGainB = 50;

int ExtractGdiNumber(const std::string& dev) {
    if (dev.empty()) return 999;
    std::string lower = ToLowerAscii(dev);
    size_t idx = lower.find("display");
    if (idx != std::string::npos) {
        int val = std::atoi(dev.c_str() + idx + 7);
        if (val > 0) return val;
    }
    return 999;
}

void ReleaseBoundMonitorsLocked() {
    std::set<std::vector<PHYSICAL_MONITOR>*> destroyed;
    for (auto& b : BoundMonitors) {
        if (b.monitorSet && !b.monitorSet->empty() && destroyed.find(b.monitorSet.get()) == destroyed.end()) {
            destroyed.insert(b.monitorSet.get());
            DestroyPhysicalMonitors((DWORD)b.monitorSet->size(), b.monitorSet->data());
        }
        b.monitorSet.reset();
    }
    BoundMonitors.clear();
}

std::string GetMonitorPnpId(HMONITOR hMonitor, std::string& gdiDevName, int& width, int& height) {
    gdiDevName.clear();
    width = 0;
    height = 0;
    MONITORINFOEXW mi{};
    mi.cbSize = sizeof(MONITORINFOEXW);
    if (GetMonitorInfoW(hMonitor, &mi)) {
        gdiDevName = WideToUtf8(mi.szDevice);
        width = mi.rcMonitor.right - mi.rcMonitor.left;
        height = mi.rcMonitor.bottom - mi.rcMonitor.top;
        DISPLAY_DEVICEW dd{};
        dd.cb = sizeof(DISPLAY_DEVICEW);
        if (EnumDisplayDevicesW(mi.szDevice, 0, &dd, 0) && dd.DeviceID[0] != L'\0') {
            std::string devId = WideToUtf8(dd.DeviceID);
            size_t p1 = devId.find('\\');
            if (p1 != std::string::npos) {
                size_t p2 = devId.find('\\', p1 + 1);
                if (p2 != std::string::npos) return devId.substr(p1 + 1, p2 - p1 - 1);
                return devId.substr(p1 + 1);
            }
            return devId;
        }
    }
    return std::string();
}

std::string GetMonitorFriendlyNameFromEdid(const std::string& pnpId) {
    if (pnpId.empty()) return std::string();
    std::string lowerKey = ToLowerAscii(pnpId);
    {
        std::lock_guard<std::mutex> lock(SyncMutex);
        auto it = EdidNameCache.find(lowerKey);
        if (it != EdidNameCache.end()) return it->second;
    }

    std::wstring subKey = L"SYSTEM\\CurrentControlSet\\Enum\\DISPLAY\\" + Utf8ToWide(pnpId);
    HKEY hDisplay = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, subKey.c_str(), 0, KEY_READ, &hDisplay) == ERROR_SUCCESS) {
        WCHAR subName[256];
        for (DWORD idx = 0;; idx++) {
            DWORD len = 256;
            if (RegEnumKeyExW(hDisplay, idx, subName, &len, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
            std::wstring devParamPath = std::wstring(subName) + L"\\Device Parameters";
            HKEY hParam = nullptr;
            if (RegOpenKeyExW(hDisplay, devParamPath.c_str(), 0, KEY_READ, &hParam) == ERROR_SUCCESS) {
                BYTE edid[512]{};
                DWORD edidLen = sizeof(edid);
                DWORD type = 0;
                if (RegQueryValueExW(hParam, L"EDID", nullptr, &type, edid, &edidLen) == ERROR_SUCCESS && edidLen >= 128) {
                    for (DWORD off = 54; off <= 108; off += 18) {
                        if (off + 18 <= edidLen && edid[off] == 0 && edid[off + 1] == 0 && edid[off + 2] == 0 && edid[off + 3] == 0xFC) {
                            std::string name;
                            for (DWORD k = 0; k < 13; k++) {
                                char c = (char)edid[off + 5 + k];
                                if (c == '\n' || c == '\r' || c == '\0') break;
                                name.push_back(c);
                            }
                            while (!name.empty() && name.back() == ' ') name.pop_back();
                            while (!name.empty() && name.front() == ' ') name.erase(name.begin());
                            if (!name.empty()) {
                                RegCloseKey(hParam);
                                RegCloseKey(hDisplay);
                                std::lock_guard<std::mutex> lock(SyncMutex);
                                EdidNameCache[lowerKey] = name;
                                return name;
                            }
                        }
                    }
                }
                RegCloseKey(hParam);
            }
        }
        RegCloseKey(hDisplay);
    }
    return std::string();
}

#pragma pack(push, 1)
struct DISPLAY_BRIGHTNESS {
    uint8_t ucDisplayPolicy;
    uint8_t ucACBrightness;
    uint8_t ucDCBrightness;
};
#pragma pack(pop)

DWORD SetLcdBrightnessKernel(uint8_t level) {
    HANDLE hLcd = CreateFileW(L"\\\\.\\LCD", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (hLcd == INVALID_HANDLE_VALUE) {
        hLcd = CreateFileW(L"\\\\.\\LCD", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
        if (hLcd == INVALID_HANDLE_VALUE) return GetLastError();
    }
    DISPLAY_BRIGHTNESS db{ 3, level, level };
    DWORD retBytes = 0;
    BOOL ok = DeviceIoControl(hLcd, 0x23049Cu, &db, sizeof(db), nullptr, 0, &retBytes, nullptr);
    DWORD err = ok ? 0 : GetLastError();
    if (!ok) {
        db.ucDisplayPolicy = 1;
        ok = DeviceIoControl(hLcd, 0x23049Cu, &db, sizeof(db), nullptr, 0, &retBytes, nullptr);
        err = ok ? 0 : GetLastError();
    }
    CloseHandle(hLcd);
    return err;
}

DWORD QueryLcdBrightness(uint8_t& level) {
    level = 50;
    HANDLE hLcd = CreateFileW(L"\\\\.\\LCD", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (hLcd == INVALID_HANDLE_VALUE) {
        hLcd = CreateFileW(L"\\\\.\\LCD", 0, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
        if (hLcd == INVALID_HANDLE_VALUE) return GetLastError();
    }
    DISPLAY_BRIGHTNESS db{};
    DWORD retBytes = 0;
    BOOL ok = DeviceIoControl(hLcd, 0x230498u, nullptr, 0, &db, sizeof(db), &retBytes, nullptr);
    DWORD err = ok ? 0 : GetLastError();
    if (ok) {
        level = (db.ucDisplayPolicy == 2) ? db.ucDCBrightness : db.ucACBrightness;
    }
    CloseHandle(hLcd);
    return err;
}

bool ApplyInternalCalibrationRamp(const std::string& gdiDeviceName, int contrastVal, int rGain, int gGain, int bGain, int softwareBrightVal = 100) {
    std::wstring devW = gdiDeviceName.empty() ? L"\\\\.\\DISPLAY1" : Utf8ToWide(gdiDeviceName);
    HDC hdc = CreateDCW(L"DISPLAY", devW.c_str(), nullptr, nullptr);
    if (!hdc) hdc = CreateDCW(devW.c_str(), nullptr, nullptr, nullptr);
    if (!hdc) return false;

    uint16_t ramp[3 * 256]{};
    double bScale = std::max(0.10, std::min(1.0, softwareBrightVal / 100.0));
    double cMult = std::max(0.1, std::min(2.0, contrastVal / 50.0));
    double chScale[3] = {
        std::max(0.2, std::min(2.0, rGain / 50.0)),
        std::max(0.2, std::min(2.0, gGain / 50.0)),
        std::max(0.2, std::min(2.0, bGain / 50.0))
    };
    for (int c = 0; c < 3; c++) {
        for (int i = 0; i < 256; i++) {
            double norm = i / 255.0;
            double adjusted = ((norm - 0.5) * cMult + 0.5) * chScale[c] * bScale;
            if (adjusted < 0.0) adjusted = 0.0;
            if (adjusted > 1.0) adjusted = 1.0;
            ramp[c * 256 + i] = (uint16_t)(adjusted * 65535.0);
        }
    }
    BOOL ok = SetDeviceGammaRamp(hdc, ramp);
    DeleteDC(hdc);
    return ok != FALSE;
}

bool ApplyGammaBrightness(const std::string& gdiDeviceName, int val, int contrastVal = 50, int rGain = 50, int gGain = 50, int bGain = 50) {
    if (gdiDeviceName.empty()) return false;
    return ApplyInternalCalibrationRamp(gdiDeviceName, contrastVal, rGain, gGain, bGain, val);
}

void SetInternalDisplayCalibration(int contrast, int r, int g, int b) {
    std::string targetGdi;
    {
        std::lock_guard<std::mutex> lock(SyncMutex);
        if (contrast >= 0) internalContrast = std::max(0, std::min(100, contrast));
        if (r >= 0) internalGainR = std::max(0, std::min(100, r));
        if (g >= 0) internalGainG = std::max(0, std::min(100, g));
        if (b >= 0) internalGainB = std::max(0, std::min(100, b));
        for (auto& m : CurrentMonitors) {
            if (m.isInternal) {
                m.contrast = internalContrast;
                m.gainR = internalGainR;
                m.gainG = internalGainG;
                m.gainB = internalGainB;
                targetGdi = m.gdiDevice;
            }
        }
    }
    if (targetGdi.empty()) targetGdi = "\\\\.\\DISPLAY1";
    ApplyInternalCalibrationRamp(targetGdi, internalContrast, internalGainR, internalGainG, internalGainB, 100);
}

#ifdef GetObject
#undef GetObject
#endif

bool InvokeWmiSetBrightness(uint8_t val) {
    HRESULT hrCo = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool didCoInit = (hrCo == S_OK || hrCo == S_FALSE);
    bool result = false;

    IWbemLocator* pLoc = nullptr;
    IWbemServices* pSvc = nullptr;
    IEnumWbemClassObject* pEnum = nullptr;
    IWbemClassObject* pClass = nullptr;
    IWbemClassObject* pInSig = nullptr;

    BSTR ns = SysAllocString(L"ROOT\\WMI");
    BSTR cls = SysAllocString(L"WmiMonitorBrightnessMethods");
    BSTR mth = SysAllocString(L"WmiSetBrightness");
    BSTR wql = SysAllocString(L"WQL");
    BSTR qry = SysAllocString(L"SELECT __PATH FROM WmiMonitorBrightnessMethods");

    if (SUCCEEDED(CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER, IID_IWbemLocator, (void**)&pLoc)) && pLoc) {
        if (SUCCEEDED(pLoc->ConnectServer(ns, nullptr, nullptr, nullptr, 0, nullptr, nullptr, &pSvc)) && pSvc) {
            CoSetProxyBlanket(pSvc, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE);
            if (SUCCEEDED(pSvc->GetObject(cls, 0, nullptr, &pClass, nullptr)) && pClass) {
                if (SUCCEEDED(pClass->GetMethod(mth, 0, &pInSig, nullptr)) && pInSig) {
                    if (SUCCEEDED(pSvc->ExecQuery(wql, qry, WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, nullptr, &pEnum)) && pEnum) {
                        IWbemClassObject* pObj = nullptr;
                        ULONG uRet = 0;
                        if (pEnum->Next(WBEM_INFINITE, 1, &pObj, &uRet) == S_OK && pObj) {
                            VARIANT vPath{};
                            VariantInit(&vPath);
                            if (SUCCEEDED(pObj->Get(L"__PATH", 0, &vPath, nullptr, nullptr)) && vPath.vt == VT_BSTR) {
                                IWbemClassObject* pInParams = nullptr;
                                if (SUCCEEDED(pInSig->SpawnInstance(0, &pInParams)) && pInParams) {
                                    VARIANT vTimeout{};
                                    VariantInit(&vTimeout);
                                    vTimeout.vt = VT_I4;
                                    vTimeout.lVal = 1;
                                    pInParams->Put(L"Timeout", 0, &vTimeout, 0);
                                    VariantClear(&vTimeout);

                                    VARIANT vBright{};
                                    VariantInit(&vBright);
                                    vBright.vt = VT_UI1;
                                    vBright.bVal = val;
                                    pInParams->Put(L"Brightness", 0, &vBright, 0);
                                    VariantClear(&vBright);

                                    if (SUCCEEDED(pSvc->ExecMethod(vPath.bstrVal, mth, 0, nullptr, pInParams, nullptr, nullptr))) {
                                        result = true;
                                    }
                                    pInParams->Release();
                                }
                            }
                            VariantClear(&vPath);
                            pObj->Release();
                        }
                    }
                }
            }
        }
    }

    SysFreeString(ns);
    SysFreeString(cls);
    SysFreeString(mth);
    SysFreeString(wql);
    SysFreeString(qry);
    if (pEnum) pEnum->Release();
    if (pInSig) pInSig->Release();
    if (pClass) pClass->Release();
    if (pSvc) pSvc->Release();
    if (pLoc) pLoc->Release();
    if (didCoInit) CoUninitialize();
    return result;
}

void BindPhysicalMonitors(const std::map<std::string, std::string>* friendlyNames, bool signalWake = false) {
    if (friendlyNames && friendlyNames != &SavedFriendlyNames) {
        for (const auto& kvp : *friendlyNames) {
            SavedFriendlyNames[kvp.first] = kvp.second;
        }
    }

    struct RawEnumEntry {
        HMONITOR hMonitor;
        std::string gdiDev;
        std::string pnpId;
        int width;
        int height;
    };
    struct EnumState {
        std::vector<RawEnumEntry> items;
        std::vector<std::string> activeGdiDevices;
    } enumState;

    auto enumProc = [](HMONITOR hMonitor, HDC, LPRECT, LPARAM data) -> BOOL {
        auto* st = reinterpret_cast<EnumState*>(data);
        std::string gdiDev;
        int w = 0, h = 0;
        std::string pnpId = GetMonitorPnpId(hMonitor, gdiDev, w, h);
        st->items.push_back({ hMonitor, gdiDev, pnpId, w, h });
        if (!gdiDev.empty() && std::find(st->activeGdiDevices.begin(), st->activeGdiDevices.end(), gdiDev) == st->activeGdiDevices.end()) {
            st->activeGdiDevices.push_back(gdiDev);
        }
        return TRUE;
    };

    EnumDisplayMonitors(nullptr, nullptr, enumProc, reinterpret_cast<LPARAM>(&enumState));
    std::sort(enumState.activeGdiDevices.begin(), enumState.activeGdiDevices.end(),
        [](const std::string& a, const std::string& b) {
            return ExtractGdiNumber(a) < ExtractGdiNumber(b);
        });

    std::vector<BoundPhysicalMonitor> boundList;
    std::vector<std::shared_ptr<std::vector<PHYSICAL_MONITOR>>> allocatedSets;
    int ddcIndex = 0;

    {
        std::lock_guard<std::mutex> lock(SyncMutex);
        ReleaseBoundMonitorsLocked();
    }

    try {
        for (size_t mIdx = 0; mIdx < enumState.items.size(); mIdx++) {
            const auto& raw = enumState.items[mIdx];
            auto itGdi = std::find(enumState.activeGdiDevices.begin(), enumState.activeGdiDevices.end(), raw.gdiDev);
            int winNum = (!raw.gdiDev.empty() && itGdi != enumState.activeGdiDevices.end())
                ? (int)(itGdi - enumState.activeGdiDevices.begin()) + 1
                : (ddcIndex + 1);

            bool isInternalMatch = (!SavedInternalPnpId.empty() && EqualsCaseInsensitive(SavedInternalPnpId, raw.pnpId)) ||
                                   (!raw.gdiDev.empty() && ContainsCaseInsensitive(raw.gdiDev, "DISPLAY1"));

            uint8_t curLcd = 50;
            if (isInternalMatch && QueryLcdBrightness(curLcd) == 0) {
                if (SavedInternalPnpId.empty() && !raw.pnpId.empty()) {
                    SavedInternalPnpId = raw.pnpId;
                }
                std::string modelName = "Internal Display";
                if (!raw.pnpId.empty()) {
                    auto itFn = SavedFriendlyNames.find(raw.pnpId);
                    if (itFn != SavedFriendlyNames.end() && !itFn->second.empty()) modelName = itFn->second;
                }
                std::string canonicalId = !raw.pnpId.empty() ? raw.pnpId : (!raw.gdiDev.empty() ? raw.gdiDev : "internal");

                BoundPhysicalMonitor b;
                b.id = canonicalId;
                b.hPhys = nullptr;
                b.gdiDevice = raw.gdiDev;
                b.pnpId = raw.pnpId;
                b.name = modelName;
                b.windowsDisplayNumber = winNum;
                b.width = raw.width;
                b.height = raw.height;
                b.isInternal = true;
                b.initialBrightness = (int)curLcd;
                boundList.push_back(std::move(b));
                ddcIndex++;
                continue;
            }

            DWORD count = 0;
            if (GetNumberOfPhysicalMonitorsFromHMONITOR(raw.hMonitor, &count) && count > 0) {
                auto physSet = std::make_shared<std::vector<PHYSICAL_MONITOR>>(count);
                if (GetPhysicalMonitorsFromHMONITOR(raw.hMonitor, count, physSet->data())) {
                    allocatedSets.push_back(physSet);
                    for (DWORD i = 0; i < count; i++) {
                        HANDLE hPhys = (*physSet)[i].hPhysicalMonitor;
                        std::string modelName = "Monitor " + std::to_string(winNum);
                        if (!raw.pnpId.empty()) {
                            auto itFn = SavedFriendlyNames.find(raw.pnpId);
                            if (itFn != SavedFriendlyNames.end() && !itFn->second.empty()) modelName = itFn->second;
                        }
                        std::string canonicalId = !raw.pnpId.empty() ? raw.pnpId : (!raw.gdiDev.empty() ? raw.gdiDev : ("mon_" + std::to_string(ddcIndex)));

                        BoundPhysicalMonitor b;
                        b.id = canonicalId;
                        b.hPhys = hPhys;
                        b.monitorSet = physSet;
                        b.gdiDevice = raw.gdiDev;
                        b.pnpId = raw.pnpId;
                        b.name = modelName;
                        b.windowsDisplayNumber = winNum;
                        b.width = raw.width;
                        b.height = raw.height;
                        b.isInternal = false;
                        b.initialBrightness = -1;
                        boundList.push_back(std::move(b));
                        ddcIndex++;
                    }
                }
            }
        }

        bool hasInternalBound = false;
        for (const auto& b : boundList) {
            if (b.isInternal) { hasInternalBound = true; break; }
        }
        if (!hasInternalBound) {
            uint8_t curLcd = 50;
            if (QueryLcdBrightness(curLcd) == 0) {
                std::string intPnp = !SavedInternalPnpId.empty() ? SavedInternalPnpId : "Internal_Panel";
                std::string intModel = "Internal Display";
                if (!SavedInternalPnpId.empty()) {
                    auto itFn = SavedFriendlyNames.find(SavedInternalPnpId);
                    if (itFn != SavedFriendlyNames.end() && !itFn->second.empty()) intModel = itFn->second;
                }
                std::string intGdi = (!enumState.activeGdiDevices.empty() && ContainsCaseInsensitive(enumState.activeGdiDevices[0], "DISPLAY1"))
                    ? enumState.activeGdiDevices[0] : "\\\\.\\DISPLAY1";
                auto itInt = std::find(enumState.activeGdiDevices.begin(), enumState.activeGdiDevices.end(), intGdi);
                int winNum = (itInt != enumState.activeGdiDevices.end()) ? (int)(itInt - enumState.activeGdiDevices.begin()) + 1 : 1;
                int intWidth = GetSystemMetrics(0);
                int intHeight = GetSystemMetrics(1);
                for (const auto& raw : enumState.items) {
                    if (raw.gdiDev == intGdi) {
                        intWidth = raw.width;
                        intHeight = raw.height;
                        break;
                    }
                }

                BoundPhysicalMonitor b;
                b.id = intPnp;
                b.hPhys = nullptr;
                b.gdiDevice = intGdi;
                b.pnpId = intPnp;
                b.name = intModel;
                b.windowsDisplayNumber = winNum;
                b.width = intWidth;
                b.height = intHeight;
                b.isInternal = true;
                b.initialBrightness = (int)curLcd;
                boundList.push_back(std::move(b));
            }
        }

        std::sort(boundList.begin(), boundList.end(),
            [](const BoundPhysicalMonitor& a, const BoundPhysicalMonitor& b) {
                return a.windowsDisplayNumber < b.windowsDisplayNumber;
            });

        std::vector<DisplayDeviceItem> initialDevList;
        initialDevList.reserve(boundList.size());
        for (const auto& b : boundList) {
            DisplayDeviceItem item;
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
            initialDevList.push_back(std::move(item));
        }

        {
            std::lock_guard<std::mutex> lock(SyncMutex);
            BoundMonitors = std::move(boundList);
            CurrentMonitors = std::move(initialDevList);
        }
        allocatedSets.clear();
        if (signalWake && WakeSignal) SetEvent(WakeSignal);
    } catch (...) {
        std::set<std::vector<PHYSICAL_MONITOR>*> destroyed;
        for (auto& arr : allocatedSets) {
            if (arr && !arr->empty() && destroyed.find(arr.get()) == destroyed.end()) {
                destroyed.insert(arr.get());
                DestroyPhysicalMonitors((DWORD)arr->size(), arr->data());
            }
        }
    }
}

bool FindBoundTargetLocked(const std::string& monitorId, const std::string& pnpId, const std::string& gdiDev, bool isInt, BoundPhysicalMonitor& outTarget) {
    if (BoundMonitors.empty()) return false;
    for (const auto& b : BoundMonitors) {
        if (!monitorId.empty() && b.id == monitorId) { outTarget = b; return true; }
        if (!pnpId.empty() && b.pnpId == pnpId) { outTarget = b; return true; }
        if (!gdiDev.empty() && b.gdiDevice == gdiDev) { outTarget = b; return true; }
    }
    if (isInt || ContainsCaseInsensitive(monitorId, "internal") || ContainsCaseInsensitive(gdiDev, "DISPLAY1")) {
        for (const auto& b : BoundMonitors) {
            if (b.isInternal) { outTarget = b; return true; }
        }
    }
    if (monitorId.size() > 4 && monitorId.rfind("mon_", 0) == 0) {
        int idx = std::atoi(monitorId.c_str() + 4);
        if (idx >= 0 && idx < (int)BoundMonitors.size()) {
            outTarget = BoundMonitors[(size_t)idx];
            return true;
        }
    }
    return false;
}

template <typename Fn>
bool ExecuteWithReprobe(BoundPhysicalMonitor& target, bool& hasTarget, Fn&& action) {
    if (!hasTarget) return false;
    if (action(target.hPhys)) return true;

    std::string tId = target.id;
    std::string tPnp = target.pnpId;
    std::string tGdi = target.gdiDevice;
    bool tInt = target.isInternal;

    {
        std::lock_guard<std::mutex> pLock(ProbeMutex);
        BindPhysicalMonitors(&SavedFriendlyNames, false);
    }
    {
        std::lock_guard<std::mutex> sLock(SyncMutex);
        hasTarget = FindBoundTargetLocked(tId, tPnp, tGdi, tInt, target);
    }
    if (!hasTarget) return false;
    return action(target.hPhys);
}

bool WriteVcpWithRetry(BoundPhysicalMonitor& target, bool& hasTarget, uint8_t code, uint32_t val) {
    return ExecuteWithReprobe(target, hasTarget, [&](HANDLE hPhys) {
        return SetVCPFeature(hPhys, code, val) != FALSE;
    });
}

bool SetBrightnessTiered(BoundPhysicalMonitor& target, bool& hasTarget, int val) {
    DWORD v = (DWORD)std::max(0, std::min(100, val));
    return ExecuteWithReprobe(target, hasTarget, [&](HANDLE hPhys) {
        return (SetMonitorBrightness(hPhys, v) != FALSE) || (SetVCPFeature(hPhys, 0x10, v) != FALSE);
    });
}

bool SetContrastTiered(BoundPhysicalMonitor& target, bool& hasTarget, int val) {
    DWORD v = (DWORD)std::max(0, std::min(100, val));
    return ExecuteWithReprobe(target, hasTarget, [&](HANDLE hPhys) {
        return (SetMonitorContrast(hPhys, v) != FALSE) || (SetVCPFeature(hPhys, 0x12, v) != FALSE);
    });
}

bool SetGainTiered(BoundPhysicalMonitor& target, bool& hasTarget, MC_GAIN_TYPE gainType, uint8_t vcpCode, int val) {
    DWORD v = (DWORD)std::max(0, std::min(100, val));
    return ExecuteWithReprobe(target, hasTarget, [&](HANDLE hPhys) {
        return (SetMonitorRedGreenOrBlueGain(hPhys, gainType, v) != FALSE) || (SetVCPFeature(hPhys, vcpCode, v) != FALSE);
    });
}

bool ApplyControl(const std::string& monitorId, const std::string& control, int val,
                  const std::string& pnpId = "", const std::string& gdiDev = "", bool isInt = false) {
    BoundPhysicalMonitor target;
    bool hasTarget = false;
    {
        std::lock_guard<std::mutex> lock(SyncMutex);
        hasTarget = FindBoundTargetLocked(monitorId, pnpId, gdiDev, isInt, target);
    }
    if (!hasTarget) {
        {
            std::lock_guard<std::mutex> pLock(ProbeMutex);
            BindPhysicalMonitors(&SavedFriendlyNames, false);
        }
        std::lock_guard<std::mutex> sLock(SyncMutex);
        hasTarget = FindBoundTargetLocked(monitorId, pnpId, gdiDev, isInt, target);
    }

    std::string ctrl;
    for (char c : control) {
        if (c != '_') ctrl.push_back((c >= 'A' && c <= 'Z') ? (char)(c + ('a' - 'A')) : c);
    }

    if (hasTarget && target.isInternal) {
        if (ctrl == "brightness") {
            uint8_t bVal = (uint8_t)std::max(0, std::min(100, val));
            bool ok = (SetLcdBrightnessKernel(bVal) == 0);
            if (!ok) ok = InvokeWmiSetBrightness(bVal);
            if (!ok) ok = ApplyGammaBrightness(target.gdiDevice, (int)bVal, internalContrast, internalGainR, internalGainG, internalGainB);
            if (ok) {
                std::lock_guard<std::mutex> lock(SyncMutex);
                for (auto& m : CurrentMonitors) {
                    if (m.isInternal || m.id == target.id) {
                        m.brightness = val;
                        break;
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

    if (!hasTarget) return false;

    bool ddcOk = false;
    if (ctrl == "brightness") {
        ddcOk = SetBrightnessTiered(target, hasTarget, val);
        if (!ddcOk && hasTarget) ddcOk = ApplyGammaBrightness(target.gdiDevice, val);
        if (ddcOk && hasTarget) {
            std::lock_guard<std::mutex> lock(SyncMutex);
            for (auto& m : CurrentMonitors) if (m.id == target.id) { m.brightness = val; break; }
        }
    } else if (ctrl == "contrast") {
        ddcOk = SetContrastTiered(target, hasTarget, val);
        if (ddcOk && hasTarget) {
            std::lock_guard<std::mutex> lock(SyncMutex);
            for (auto& m : CurrentMonitors) if (m.id == target.id) { m.contrast = val; break; }
        }
    } else if (ctrl == "gainr") {
        ddcOk = SetGainTiered(target, hasTarget, MC_RED_GAIN, 0x16, val);
        if (ddcOk && hasTarget) {
            std::lock_guard<std::mutex> lock(SyncMutex);
            for (auto& m : CurrentMonitors) if (m.id == target.id) { m.gainR = val; break; }
        }
    } else if (ctrl == "gaing") {
        ddcOk = SetGainTiered(target, hasTarget, MC_GREEN_GAIN, 0x18, val);
        if (ddcOk && hasTarget) {
            std::lock_guard<std::mutex> lock(SyncMutex);
            for (auto& m : CurrentMonitors) if (m.id == target.id) { m.gainG = val; break; }
        }
    } else if (ctrl == "gainb") {
        ddcOk = SetGainTiered(target, hasTarget, MC_BLUE_GAIN, 0x1A, val);
        if (ddcOk && hasTarget) {
            std::lock_guard<std::mutex> lock(SyncMutex);
            for (auto& m : CurrentMonitors) if (m.id == target.id) { m.gainB = val; break; }
        }
    } else if (ctrl == "preset" || ctrl == "colorpreset") {
        ddcOk = WriteVcpWithRetry(target, hasTarget, 0x14, (uint32_t)val);
        if (ddcOk && hasTarget) {
            int rG = -1, gG = -1, bG = -1;
            if (val == 11 || val == 12) {
                MC_VCP_CODE_TYPE pv;
                DWORD cur = 0, mx = 0;
                HANDLE hp = target.hPhys;
                if (GetVCPFeatureAndVCPFeatureReply(hp, 0x16, &pv, &cur, &mx)) rG = (int)cur;
                if (GetVCPFeatureAndVCPFeatureReply(hp, 0x18, &pv, &cur, &mx)) gG = (int)cur;
                if (GetVCPFeatureAndVCPFeatureReply(hp, 0x1A, &pv, &cur, &mx)) bG = (int)cur;
            }
            std::lock_guard<std::mutex> lock(SyncMutex);
            for (auto& m : CurrentMonitors) {
                if (m.id == target.id) {
                    m.colorPreset = val;
                    if (rG >= 0) m.gainR = rG;
                    if (gG >= 0) m.gainG = gG;
                    if (bG >= 0) m.gainB = bG;
                    break;
                }
            }
        }
    } else if (ctrl == "input" || ctrl == "inputsource") {
        ddcOk = WriteVcpWithRetry(target, hasTarget, 0x60, (uint32_t)val);
        if (ddcOk && hasTarget) {
            std::lock_guard<std::mutex> lock(SyncMutex);
            for (auto& m : CurrentMonitors) if (m.id == target.id) { m.inputSource = val; break; }
        }
    } else if (ctrl == "overdrive") {
        ddcOk = WriteVcpWithRetry(target, hasTarget, 0xE8, (uint32_t)val);
        if (ddcOk && hasTarget) {
            std::lock_guard<std::mutex> lock(SyncMutex);
            for (auto& m : CurrentMonitors) if (m.id == target.id) { m.overdrive = val; break; }
        }
    } else if (ctrl == "strobing" || ctrl == "mprt") {
        uint8_t mprtCode = (hasTarget && StartsWithCaseInsensitive(target.pnpId, "ACR")) ? 0xE5 : 0xEF;
        ddcOk = WriteVcpWithRetry(target, hasTarget, mprtCode, (uint32_t)val);
        if (!ddcOk && hasTarget) {
            uint8_t altCode = (mprtCode == 0xE5) ? 0xEF : 0xE5;
            ddcOk = WriteVcpWithRetry(target, hasTarget, altCode, (uint32_t)val);
        }
        if (ddcOk && hasTarget) {
            std::lock_guard<std::mutex> lock(SyncMutex);
            for (auto& m : CurrentMonitors) {
                if (m.id == target.id) { m.strobing = val; m.mprt = val; break; }
            }
        }
    } else if (ctrl == "freesync") {
        ddcOk = WriteVcpWithRetry(target, hasTarget, 0xEA, (uint32_t)val);
        if (ddcOk && hasTarget) {
            std::lock_guard<std::mutex> lock(SyncMutex);
            for (auto& m : CurrentMonitors) if (m.id == target.id) { m.freeSync = val; break; }
        }
    }
    return ddcOk;
}

void ReadTelemetryFeatures(bool forceFullDiscovery = false) {
    std::vector<BoundPhysicalMonitor> snapshot;
    {
        std::lock_guard<std::mutex> lock(SyncMutex);
        snapshot = BoundMonitors;
    }

    std::vector<TelemetryUpdateItem> updates(snapshot.size());
    std::vector<std::thread> threads;

    for (size_t i = 0; i < snapshot.size(); i++) {
        size_t idx = i;
        const auto bound = snapshot[idx];
        updates[idx].id = bound.id;
        updates[idx].isInternal = bound.isInternal;
        if (bound.isInternal && bound.initialBrightness >= 0) {
            updates[idx].curLcd = (uint8_t)bound.initialBrightness;
        }

        if (bound.isInternal) {
            threads.emplace_back([&, idx, bound]() {
                auto& u = updates[idx];
                if (!bound.pnpId.empty()) {
                    u.friendlyName = GetMonitorFriendlyNameFromEdid(bound.pnpId);
                }
                uint8_t curLcd = u.curLcd > 0 ? u.curLcd : 50;
                if (QueryLcdBrightness(curLcd) == 0) {
                    u.curLcd = curLcd;
                }
                u.vcpMask = 0;
            });
            continue;
        }

        threads.emplace_back([&, idx, bound, forceFullDiscovery]() {
            auto& u = updates[idx];
            HANDLE hPhys = bound.hPhys;
            MC_VCP_CODE_TYPE pvct;
            DWORD vCur = 0, vMax = 0, hlMin = 0, hlCur = 0, hlMax = 0;
            bool hasBright = false; DWORD brightCur = 0, brightMax = 0;
            bool hasContrast = false; DWORD contrastCur = 0, contrastMax = 0;
            bool hasPreset = false; DWORD presetCur = 0, presetMax = 0;
            bool hasPrev = false; DWORD prevCur = 0, prevMax = 0;
            int discoveredMask = 0;

            // 1. Empirical Brightness (always probed; allows initial stdin config time to populate VCP mask cache)
            if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x10, &pvct, &vCur, &vMax)) {
                u.brightVal = (int)vCur;
                hasBright = true; brightCur = vCur; brightMax = vMax;
                hasPrev = true; prevCur = vCur; prevMax = vMax;
            } else if (GetMonitorBrightness(hPhys, &hlMin, &hlCur, &hlMax)) {
                u.brightVal = (int)hlCur;
                hasBright = true; brightCur = hlCur; brightMax = hlMax;
                hasPrev = true; prevCur = hlCur; prevMax = hlMax;
            }

            int cachedMask = -1;
            if (!forceFullDiscovery) {
                std::lock_guard<std::mutex> lock(SyncMutex);
                std::string cacheKey = ToLowerAscii(!bound.pnpId.empty() ? bound.pnpId : bound.id);
                auto itMask = SavedVcpMasks.find(cacheKey);
                if (!cacheKey.empty() && itMask != SavedVcpMasks.end() && itMask->second >= 0) {
                    cachedMask = itMask->second;
                }
            }
            bool hasMask = (cachedMask >= 0);

            // 2. Empirical Color Preset
            if (!hasMask || (cachedMask & VCP_MASK_COLOR_PRESET) != 0) {
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x14, &pvct, &vCur, &vMax)) {
                    u.preset = (int)vCur;
                    discoveredMask |= VCP_MASK_COLOR_PRESET;
                    hasPreset = true; presetCur = vCur; presetMax = vMax;
                    hasPrev = true; prevCur = vCur; prevMax = vMax;
                }
            }

            // 3. Empirical RGB Gains when User/Custom mode active (or preset unavailable)
            if ((!hasMask || (cachedMask & VCP_MASK_COLOR_PRESET) != 0) && (u.preset == 11 || u.preset == 12 || u.preset < 0)) {
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x16, &pvct, &vCur, &vMax)) {
                    u.rGain = (int)vCur; discoveredMask |= VCP_MASK_RGB_GAINS; hasPrev = true; prevCur = vCur; prevMax = vMax;
                } else if (GetMonitorRedGreenOrBlueGain(hPhys, MC_RED_GAIN, &hlMin, &hlCur, &hlMax)) {
                    u.rGain = (int)hlCur; discoveredMask |= VCP_MASK_RGB_GAINS; hasPrev = true; prevCur = hlCur; prevMax = hlMax;
                }

                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x18, &pvct, &vCur, &vMax)) {
                    u.gGain = (int)vCur; discoveredMask |= VCP_MASK_RGB_GAINS; hasPrev = true; prevCur = vCur; prevMax = vMax;
                } else if (GetMonitorRedGreenOrBlueGain(hPhys, MC_GREEN_GAIN, &hlMin, &hlCur, &hlMax)) {
                    u.gGain = (int)hlCur; discoveredMask |= VCP_MASK_RGB_GAINS; hasPrev = true; prevCur = hlCur; prevMax = hlMax;
                }

                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x1A, &pvct, &vCur, &vMax)) {
                    u.bGain = (int)vCur; discoveredMask |= VCP_MASK_RGB_GAINS; hasPrev = true; prevCur = vCur; prevMax = vMax;
                } else if (GetMonitorRedGreenOrBlueGain(hPhys, MC_BLUE_GAIN, &hlMin, &hlCur, &hlMax)) {
                    u.bGain = (int)hlCur; discoveredMask |= VCP_MASK_RGB_GAINS; hasPrev = true; prevCur = hlCur; prevMax = hlMax;
                }
            }

            if (!bound.pnpId.empty()) {
                u.friendlyName = GetMonitorFriendlyNameFromEdid(bound.pnpId);
            }

            // 4. Input Source (0x60) & FreeSync (0xEA)
            bool suspectInput = false;
            if (!hasMask || (cachedMask & VCP_MASK_INPUT_SOURCE) != 0) {
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x60, &pvct, &vCur, &vMax)) {
                    if (hasPrev && vCur == prevCur && vMax == prevMax) {
                        suspectInput = true;
                    } else {
                        u.input = (int)vCur;
                        discoveredMask |= VCP_MASK_INPUT_SOURCE;
                        hasPrev = true; prevCur = vCur; prevMax = vMax;
                    }
                }
            }

            bool suspectEa = false;
            if (!hasMask || (cachedMask & VCP_MASK_FREESYNC) != 0) {
                if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0xEA, &pvct, &vCur, &vMax)) {
                    if (hasPrev && vCur == prevCur && vMax == prevMax) {
                        suspectEa = true;
                    } else {
                        u.fs = (int)vCur;
                        discoveredMask |= VCP_MASK_FREESYNC;
                        hasPrev = true; prevCur = vCur; prevMax = vMax;
                    }
                }
            }

            // 5. Mandatory Contrast (0x12)
            if (GetVCPFeatureAndVCPFeatureReply(hPhys, 0x12, &pvct, &vCur, &vMax)) {
                u.contrastVal = (int)vCur;
                hasContrast = true; contrastCur = vCur; contrastMax = vMax;
                hasPrev = true; prevCur = vCur; prevMax = vMax;
            } else if (GetMonitorContrast(hPhys, &hlMin, &hlCur, &hlMax)) {
                u.contrastVal = (int)hlCur;
                hasContrast = true; contrastCur = hlCur; contrastMax = hlMax;
                hasPrev = true; prevCur = hlCur; prevMax = hlMax;
            }

            if (suspectInput && hasPrev && GetVCPFeatureAndVCPFeatureReply(hPhys, 0x60, &pvct, &vCur, &vMax)) {
                if (!(vCur == prevCur && vMax == prevMax)) {
                    u.input = (int)vCur;
                    discoveredMask |= VCP_MASK_INPUT_SOURCE;
                    prevCur = vCur; prevMax = vMax;
                }
            }

            if (suspectEa && hasPrev && GetVCPFeatureAndVCPFeatureReply(hPhys, 0xEA, &pvct, &vCur, &vMax)) {
                if (!(vCur == prevCur && vMax == prevMax)) {
                    u.fs = (int)vCur;
                    discoveredMask |= VCP_MASK_FREESYNC;
                    prevCur = vCur; prevMax = vMax;
                }
            }

            auto readVerifiedVcp = [&](uint8_t code) -> int {
                MC_VCP_CODE_TYPE rPvct;
                DWORD rCur = 0, rMax = 0;
                if (!GetVCPFeatureAndVCPFeatureReply(hPhys, code, &rPvct, &rCur, &rMax)) {
                    return -1;
                }
                if (hasPrev && rCur == prevCur && rMax == prevMax) {
                    uint8_t probeCode = 0;
                    if (hasContrast && !(prevCur == contrastCur && prevMax == contrastMax)) probeCode = 0x12;
                    else if (hasBright && !(prevCur == brightCur && prevMax == brightMax)) probeCode = 0x10;
                    else if (hasPreset && !(prevCur == presetCur && prevMax == presetMax)) probeCode = 0x14;
                    if (probeCode != 0) {
                        MC_VCP_CODE_TYPE pPvct, vPvct;
                        DWORD pCur = 0, pMax = 0, v2Cur = 0, v2Max = 0;
                        if (GetVCPFeatureAndVCPFeatureReply(hPhys, probeCode, &pPvct, &pCur, &pMax)) {
                            if (!GetVCPFeatureAndVCPFeatureReply(hPhys, code, &vPvct, &v2Cur, &v2Max)) {
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
            int strVal = -1;
            if (!hasMask || (cachedMask & VCP_MASK_VRB_E5) != 0) {
                strVal = readVerifiedVcp(0xE5);
                if (strVal >= 0) discoveredMask |= VCP_MASK_VRB_E5;
            }
            if (strVal < 0 && (!hasMask || (cachedMask & VCP_MASK_VRB_EF) != 0)) {
                strVal = readVerifiedVcp(0xEF);
                if (strVal >= 0) discoveredMask |= VCP_MASK_VRB_EF;
            }
            if (strVal >= 0) {
                u.strobing = strVal;
                u.mprt = strVal;
            }

            if (!hasMask || (cachedMask & VCP_MASK_OVERDRIVE) != 0) {
                int odVal = readVerifiedVcp(0xE8);
                if (odVal >= 0) {
                    u.od = odVal;
                    discoveredMask |= VCP_MASK_OVERDRIVE;
                }
            }

            u.vcpMask = discoveredMask;
        });
    }

    for (auto& t : threads) {
        if (t.joinable()) t.join();
    }

    if (EmiHost::ReadyEvent) WaitForSingleObject(EmiHost::ReadyEvent, INFINITE);
    if (NvmlHost::ReadyEvent) WaitForSingleObject(NvmlHost::ReadyEvent, INFINITE);

    {
        std::lock_guard<std::mutex> lock(SyncMutex);
        for (const auto& u : updates) {
            if (u.id.empty()) continue;
            for (auto& m : CurrentMonitors) {
                if (m.id == u.id || (u.isInternal && m.isInternal)) {
                    if (!u.friendlyName.empty()) {
                        m.name = u.friendlyName;
                        if (!m.pnpId.empty()) SavedFriendlyNames[m.pnpId] = u.friendlyName;
                    }
                    if (u.vcpMask >= 0) {
                        m.vcpMask = u.vcpMask;
                        if (!u.isInternal) {
                            std::string cacheKey = ToLowerAscii(!m.pnpId.empty() ? m.pnpId : m.id);
                            if (!cacheKey.empty()) SavedVcpMasks[cacheKey] = u.vcpMask;
                        }
                    }
                    if (u.isInternal) {
                        m.brightness = u.curLcd;
                        m.contrast = internalContrast;
                        m.gainR = internalGainR;
                        m.gainG = internalGainG;
                        m.gainB = internalGainB;
                    } else {
                        m.brightness = u.brightVal;
                        m.contrast = u.contrastVal;
                        m.gainR = u.rGain;
                        m.gainG = u.gGain;
                        m.gainB = u.bGain;
                        m.colorPreset = u.preset;
                        m.inputSource = u.input;
                        m.overdrive = u.od;
                        m.strobing = u.strobing;
                        m.mprt = u.mprt;
                        m.freeSync = u.fs;
                    }
                    break;
                }
            }
        }
        int pId = PendingProbeId.load();
        if (pId > CompletedProbeId.load()) CompletedProbeId.store(pId);
        HasProbed.store(true);
    }
    if (ProbeReadyEvent) SetEvent(ProbeReadyEvent);
    if (WakeSignal) SetEvent(WakeSignal);
}

void RequestEmpiricalProbe(int probeId = 0, bool forceRebind = false) {
    {
        std::lock_guard<std::mutex> lock(SyncMutex);
        if (probeId > PendingProbeId.load()) PendingProbeId.store(probeId);
        if (forceRebind) {
            ForceRebindPending.store(true);
            ForceFullVcpDiscovery.store(true);
        }
        if (IsProbing.load()) {
            ProbePending.store(true);
            return;
        }
        IsProbing.store(true);
    }

    if (ProbeThread.joinable()) ProbeThread.join();

    ProbeThread = std::thread([]() {
        while (IsRunning.load()) {
            bool rebindNow = false;
            bool fullDiscNow = false;
            int targetProbeId = 0;
            {
                std::lock_guard<std::mutex> lock(SyncMutex);
                ProbePending.store(false);
                rebindNow = ForceRebindPending.load() || BoundMonitors.empty();
                fullDiscNow = ForceFullVcpDiscovery.load();
                ForceRebindPending.store(false);
                ForceFullVcpDiscovery.store(false);
                targetProbeId = PendingProbeId.load();
            }

            if (rebindNow) {
                std::lock_guard<std::mutex> pLock(ProbeMutex);
                if (!IsRunning.load()) break;
                BindPhysicalMonitors(&SavedFriendlyNames, false);
            }
            if (!IsRunning.load()) break;
            ReadTelemetryFeatures(fullDiscNow);

            {
                std::lock_guard<std::mutex> lock(SyncMutex);
                int highestPending = PendingProbeId.load();
                if (highestPending > CompletedProbeId.load()) CompletedProbeId.store(highestPending);
                else if (targetProbeId > CompletedProbeId.load()) CompletedProbeId.store(targetProbeId);
                HasProbed.store(true);
                if (!ForceRebindPending.load() || !IsRunning.load()) {
                    ProbePending.store(false);
                    IsProbing.store(false);
                    break;
                }
            }
        }
        {
            std::lock_guard<std::mutex> lock(SyncMutex);
            IsProbing.store(false);
            HasProbed.store(true);
        }
        if (ProbeReadyEvent) SetEvent(ProbeReadyEvent);
    });
}

void ApplyVcpMasksFromJson(const std::string& json) {
    if (json.empty()) return;
    std::string search = "\"vcpMasks\"";
    size_t idx = json.find(search);
    if (idx == std::string::npos) return;
    size_t braceStart = json.find('{', idx + search.size());
    if (braceStart == std::string::npos) return;
    size_t braceEnd = json.find('}', braceStart + 1);
    if (braceEnd == std::string::npos || braceEnd <= braceStart) return;

    std::string body = json.substr(braceStart + 1, braceEnd - braceStart - 1);
    std::unordered_map<std::string, int> parsed;
    size_t i = 0;
    while (i < body.size()) {
        size_t q1 = body.find('"', i);
        if (q1 == std::string::npos) break;
        size_t q2 = body.find('"', q1 + 1);
        if (q2 == std::string::npos) break;
        std::string mapKey = body.substr(q1 + 1, q2 - q1 - 1);
        while (!mapKey.empty() && mapKey.front() == ' ') mapKey.erase(mapKey.begin());
        while (!mapKey.empty() && mapKey.back() == ' ') mapKey.pop_back();
        size_t colon = body.find(':', q2 + 1);
        if (colon == std::string::npos) break;
        size_t valStart = colon + 1;
        while (valStart < body.size() && (body[valStart] == ' ' || body[valStart] == '\t' || body[valStart] == '\r' || body[valStart] == '\n')) valStart++;
        size_t valEnd = valStart;
        while (valEnd < body.size() && ((body[valEnd] >= '0' && body[valEnd] <= '9') || body[valEnd] == '-')) valEnd++;
        if (!mapKey.empty() && valEnd > valStart) {
            int v = std::atoi(body.substr(valStart, valEnd - valStart).c_str());
            if (v >= 0) parsed[ToLowerAscii(mapKey)] = v;
        }
        i = (valEnd > q2) ? valEnd : (q2 + 1);
    }

    if (!parsed.empty()) {
        std::lock_guard<std::mutex> lock(SyncMutex);
        for (const auto& kvp : parsed) {
            SavedVcpMasks[kvp.first] = kvp.second;
        }
    }
}

bool ReadExactStdin(HANDLE hIn, void* buf, DWORD count) {
    DWORD total = 0;
    uint8_t* p = reinterpret_cast<uint8_t*>(buf);
    while (total < count) {
        DWORD got = 0;
        if (!ReadFile(hIn, p + total, count - total, &got, nullptr) || got == 0) return false;
        total += got;
    }
    return true;
}

void StartWorker() {
    StdinThread = std::thread([]() {
        HANDLE hIn = GetStdHandle(STD_INPUT_HANDLE);
        uint8_t lenBuf[4]{};
        bool isFirstPacket = true;
        while (IsRunning.load()) {
            if (!ReadExactStdin(hIn, lenBuf, 4)) break;
            if (isFirstPacket && lenBuf[0] == 0xEF && lenBuf[1] == 0xBB && lenBuf[2] == 0xBF) {
                lenBuf[0] = lenBuf[3];
                if (!ReadExactStdin(hIn, lenBuf + 1, 3)) break;
            }
            isFirstPacket = false;

            int32_t len = 0;
            std::memcpy(&len, lenBuf, 4);
            if (len <= 0 || len > 1024 * 1024) continue;

            std::string json((size_t)len, '\0');
            if (!ReadExactStdin(hIn, &json[0], (DWORD)len)) break;

            std::string action = ExtractJsonString(json, "action");
            if (action == "init_internal_display" || action == "set_internal_calibration" || action == "set_vcp_cache") {
                ApplyVcpMasksFromJson(json);
                if (action != "set_vcp_cache") {
                    int c = ExtractJsonInt(json, "contrast", -1);
                    int r = ExtractJsonInt(json, "gainR", -1);
                    if (r < 0) r = ExtractJsonInt(json, "gain_r", -1);
                    int g = ExtractJsonInt(json, "gainG", -1);
                    if (g < 0) g = ExtractJsonInt(json, "gain_g", -1);
                    int b = ExtractJsonInt(json, "gainB", -1);
                    if (b < 0) b = ExtractJsonInt(json, "gain_b", -1);
                    SetInternalDisplayCalibration(c, r, g, b);
                }
            } else if (action == "set_panel_control") {
                std::string monId = ExtractJsonString(json, "monitorId");
                std::string pnpId = ExtractJsonString(json, "pnpId");
                std::string gdiDev = ExtractJsonString(json, "gdiDevice");
                std::string control = ExtractJsonString(json, "control");
                int val = ExtractJsonInt(json, "value", 0);
                bool isInt = ExtractJsonBool(json, "isInternal", false);
                if (!control.empty()) {
                    ApplyControl(monId, control, val, pnpId, gdiDev, isInt);
                }
            } else if (action == "set_brightness") {
                std::string monId = ExtractJsonString(json, "monitorId");
                std::string pnpId = ExtractJsonString(json, "pnpId");
                std::string gdiDev = ExtractJsonString(json, "gdiDevice");
                int val = ExtractJsonInt(json, "value", 50);
                ApplyControl(monId, "brightness", val, pnpId, gdiDev);
            } else if (action == "wake" || action == "poll_now") {
                if (WakeSignal) SetEvent(WakeSignal);
            } else if (action == "probe_monitors" || action == "refresh_monitors" || action == "fetch_empirical") {
                ApplyVcpMasksFromJson(json);
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
        IsRunning.store(false);
        if (ProbeReadyEvent) SetEvent(ProbeReadyEvent);
        if (WakeSignal) SetEvent(WakeSignal);
    });

    RequestEmpiricalProbe(0, false);
}

void JoinWorkerThreads() {
    if (StdinThread.joinable()) {
        CancelSynchronousIo(reinterpret_cast<HANDLE>(StdinThread.native_handle()));
        StdinThread.join();
    }
    if (ProbeThread.joinable()) {
        ProbeThread.join();
    }
}

struct CT_PROCESSOR_POWER_INFORMATION {
    ULONG Number;
    ULONG MaxMhz;
    ULONG CurrentMhz;
    ULONG MhzLimit;
    ULONG MaxIdleState;
    ULONG CurrentIdleState;
};

using CallNtPowerInfoFn = LONG (WINAPI*)(ULONG, PVOID, ULONG, PVOID, ULONG);
CallNtPowerInfoFn pCallNtPowerInformation = nullptr;

std::vector<CT_PROCESSOR_POWER_INFORMATION> GetProcessorPowerInfo() {
    if (!pCallNtPowerInformation) {
        HMODULE hPowr = LoadLibraryW(L"powrprof.dll");
        if (hPowr) pCallNtPowerInformation = (CallNtPowerInfoFn)GetProcAddress(hPowr, "CallNtPowerInformation");
    }
    if (!pCallNtPowerInformation) return {};
    SYSTEM_INFO si{};
    GetSystemInfo(&si);
    DWORD count = si.dwNumberOfProcessors > 0 ? si.dwNumberOfProcessors : 1;
    std::vector<CT_PROCESSOR_POWER_INFORMATION> res(count);
    if (pCallNtPowerInformation(11, nullptr, 0, res.data(), count * (ULONG)sizeof(CT_PROCESSOR_POWER_INFORMATION)) == 0) {
        return res;
    }
    return {};
}

uint64_t FileTimeToUInt64(const FILETIME& ft) {
    return ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
}

uint64_t lastIdle = 0, lastKernel = 0, lastUser = 0;

int GetInstantCpuLoad() {
    FILETIME ftIdle{}, ftKernel{}, ftUser{};
    if (!GetSystemTimes(&ftIdle, &ftKernel, &ftUser)) return 0;
    uint64_t idle = FileTimeToUInt64(ftIdle);
    uint64_t kernel = FileTimeToUInt64(ftKernel);
    uint64_t user = FileTimeToUInt64(ftUser);
    if (lastKernel == 0 && lastUser == 0) {
        lastIdle = idle; lastKernel = kernel; lastUser = user;
        return 0;
    }
    uint64_t idDiff = idle - lastIdle;
    uint64_t sysDiff = (kernel - lastKernel) + (user - lastUser);
    lastIdle = idle; lastKernel = kernel; lastUser = user;
    if (sysDiff == 0) return 0;
    int util = (int)std::round((((double)(sysDiff - idDiff)) / (double)sysDiff) * 100.0);
    return std::max(0, std::min(100, util));
}

struct CT_PROCESS_BASIC_INFORMATION {
    void* Reserved1;
    void* PebBaseAddress;
    void* Reserved2[2];
    ULONG_PTR UniqueProcessId;
    ULONG_PTR InheritedFromUniqueProcessId;
};

using NtQueryInfoProcFn = LONG (WINAPI*)(HANDLE, int, PVOID, ULONG, PULONG);

int GetParentProcessId() {
    HMODULE hNtdll = GetModuleHandleW(L"ntdll.dll");
    if (!hNtdll) return -1;
    auto fn = (NtQueryInfoProcFn)GetProcAddress(hNtdll, "NtQueryInformationProcess");
    if (!fn) return -1;
    CT_PROCESS_BASIC_INFORMATION pbi{};
    ULONG retLen = 0;
    if (fn(GetCurrentProcess(), 0, &pbi, sizeof(pbi), &retLen) == 0) {
        return (int)pbi.InheritedFromUniqueProcessId;
    }
    return -1;
}

std::string BuildTelemetryJson(
    const std::string& timestamp, int cpuClock, int cpuLoad, const std::string& peClock, double cpuPower, int cpuTemp,
    double igpuPower, const std::string& igpuRam, int cpuLimit, const std::string& ramUsed, const std::string& pageUsed, const std::string& commitUsed,
    int gpuTemp, int coreClock, int memClock, double gpuPower, const std::string& vramUsed, int gpuLoad,
    const std::string& pState, const std::string& vrmBrake, const std::string& hwThermal)
{
    std::string sb;
    sb.reserve(2048);
    sb += "{\"timestamp\":"; AppendEscapedJson(sb, timestamp); sb.push_back(',');
    sb += "\"cpuClock\":" + std::to_string(cpuClock) + ",";
    sb += "\"cpuLoad\":" + std::to_string(cpuLoad) + ",";
    sb += "\"peClock\":"; AppendEscapedJson(sb, peClock); sb.push_back(',');
    sb += "\"cpuPower\":" + FormatFixed1(cpuPower) + ",";
    sb += "\"cpuTemp\":" + std::to_string(cpuTemp) + ",";
    sb += "\"igpuPower\":" + FormatFixed1(igpuPower) + ",";
    sb += "\"igpuRam\":"; AppendEscapedJson(sb, igpuRam); sb.push_back(',');
    sb += "\"cpuLimit\":" + std::to_string(cpuLimit) + ",";
    sb += "\"ramUsed\":"; AppendEscapedJson(sb, ramUsed); sb.push_back(',');
    sb += "\"pageUsed\":"; AppendEscapedJson(sb, pageUsed); sb.push_back(',');
    sb += "\"commitUsed\":"; AppendEscapedJson(sb, commitUsed); sb.push_back(',');
    sb += "\"gpuTemp\":" + std::to_string(gpuTemp) + ",";
    sb += "\"coreClock\":" + std::to_string(coreClock) + ",";
    sb += "\"memClock\":" + std::to_string(memClock) + ",";
    sb += "\"gpuPower\":" + FormatFixed1(gpuPower) + ",";
    sb += "\"vramUsed\":"; AppendEscapedJson(sb, vramUsed); sb.push_back(',');
    sb += "\"gpuLoad\":" + std::to_string(gpuLoad) + ",";
    sb += "\"pState\":"; AppendEscapedJson(sb, pState); sb.push_back(',');
    sb += "\"vrmBrake\":"; AppendEscapedJson(sb, vrmBrake); sb.push_back(',');
    sb += "\"hwThermal\":"; AppendEscapedJson(sb, hwThermal); sb.push_back(',');
    sb += std::string("\"hasProbed\":") + (HasProbed.load() ? "true," : "false,");
    sb += std::string("\"isProbing\":") + (IsProbing.load() ? "true," : "false,");
    sb += "\"probeId\":" + std::to_string(CompletedProbeId.load()) + ",";

    int monBrightness = -1;
    if (!HasProbed.load()) {
        sb += "\"monitors\":null,";
    } else {
        sb += "\"monitors\":[";
        std::lock_guard<std::mutex> lock(SyncMutex);
        for (size_t i = 0; i < CurrentMonitors.size(); i++) {
            if (i > 0) sb.push_back(',');
            const auto& m = CurrentMonitors[i];
            if (i == 0) monBrightness = m.brightness;
            sb += "{\"id\":"; AppendEscapedJson(sb, m.id); sb.push_back(',');
            sb += "\"pnpId\":"; AppendEscapedJson(sb, m.pnpId); sb.push_back(',');
            sb += "\"gdiDevice\":"; AppendEscapedJson(sb, m.gdiDevice); sb.push_back(',');
            sb += "\"name\":"; AppendEscapedJson(sb, m.name); sb.push_back(',');
            sb += "\"windowsDisplayNumber\":" + std::to_string(m.windowsDisplayNumber) + ",";
            sb += "\"width\":" + std::to_string(m.width) + ",";
            sb += "\"height\":" + std::to_string(m.height) + ",";
            sb += std::string("\"isInternal\":") + (m.isInternal ? "true," : "false,");
            sb += "\"brightness\":" + std::to_string(m.brightness) + ",";
            sb += "\"contrast\":" + std::to_string(m.contrast) + ",";
            sb += "\"gainR\":" + std::to_string(m.gainR) + ",";
            sb += "\"gainG\":" + std::to_string(m.gainG) + ",";
            sb += "\"gainB\":" + std::to_string(m.gainB) + ",";
            sb += "\"volume\":-1,";
            sb += "\"inputSource\":" + std::to_string(m.inputSource) + ",";
            sb += "\"colorPreset\":" + std::to_string(m.colorPreset) + ",";
            sb += "\"powerMode\":-1,";
            sb += "\"gamma\":-1,";
            sb += "\"blackBoost\":-1,";
            sb += "\"darkBoost\":-1,";
            sb += "\"blackLevel\":-1,";
            sb += "\"overdrive\":" + std::to_string(m.overdrive) + ",";
            sb += "\"strobing\":" + std::to_string(m.strobing) + ",";
            sb += "\"mprt\":" + std::to_string(m.mprt) + ",";
            sb += "\"freeSync\":" + std::to_string(m.freeSync) + ",";
            sb += "\"gameMode\":-1,";
            sb += "\"superSharpness\":-1,";
            sb += "\"blueLight\":-1,";
            sb += "\"vcpMask\":" + std::to_string(m.vcpMask);
            sb.push_back('}');
        }
        sb += "],";
    }
    sb += "\"monitorBrightness\":" + std::to_string(monBrightness) + "}";
    return sb;
}

} // namespace MonitorController

static bool TryNvidiaSmiFallback(
    double& gpuTemp, int& coreClk, int& memClk, double& gpuWatt,
    double& vramUsedGB, double& vramTotalGB, int& vramPct, int& gpuLoad,
    std::string& pState, std::string& vrmBrake, std::string& hwThermal)
{
    gpuTemp = 0.0; coreClk = 0; memClk = 0; gpuWatt = 0.0;
    vramUsedGB = 0.0; vramTotalGB = 0.0; vramPct = 0; gpuLoad = 0;
    pState = "Unknown"; vrmBrake = "Unknown"; hwThermal = "Unknown";

    SECURITY_ATTRIBUTES sa{ sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
    HANDLE hRead = nullptr, hWrite = nullptr;
    if (!CreatePipe(&hRead, &hWrite, &sa, 0)) return false;
    SetHandleInformation(hRead, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = hWrite;
    si.hStdError = hWrite;

    wchar_t cmdLine[] = L"nvidia-smi --query-gpu=temperature.gpu,clocks.current.graphics,clocks.current.memory,power.draw,memory.used,memory.total,utilization.gpu,pstate,clocks_event_reasons.hw_power_brake_slowdown,clocks_event_reasons.hw_thermal_slowdown --format=csv,noheader,nounits";
    PROCESS_INFORMATION pi{};
    BOOL started = CreateProcessW(nullptr, cmdLine, nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
    CloseHandle(hWrite);

    if (!started) {
        CloseHandle(hRead);
        return false;
    }

    std::string output;
    char buf[512];
    DWORD got = 0;
    while (ReadFile(hRead, buf, sizeof(buf) - 1, &got, nullptr) && got > 0) {
        output.append(buf, got);
    }
    CloseHandle(hRead);

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exitCode = 1;
    GetExitCodeProcess(pi.hProcess, &exitCode);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    if (exitCode != 0 || output.empty()) return false;
    size_t eol = output.find_first_of("\r\n");
    std::string line = (eol != std::string::npos) ? output.substr(0, eol) : output;

    std::vector<std::string> parts;
    size_t start = 0;
    while (start <= line.size()) {
        size_t comma = line.find(',', start);
        std::string item = (comma == std::string::npos) ? line.substr(start) : line.substr(start, comma - start);
        while (!item.empty() && item.front() == ' ') item.erase(item.begin());
        while (!item.empty() && item.back() == ' ') item.pop_back();
        parts.push_back(std::move(item));
        if (comma == std::string::npos) break;
        start = comma + 1;
    }

    if (parts.size() >= 10) {
        gpuTemp = std::atof(parts[0].c_str());
        coreClk = std::atoi(parts[1].c_str());
        memClk = std::atoi(parts[2].c_str());
        gpuWatt = std::atof(parts[3].c_str());
        double uMb = std::atof(parts[4].c_str());
        double tMb = std::atof(parts[5].c_str());
        vramUsedGB = std::round((uMb / 1024.0) * 10.0) / 10.0;
        vramTotalGB = std::round((tMb / 1024.0) * 10.0) / 10.0;
        vramPct = (tMb > 0.0) ? (int)std::round((uMb / tMb) * 100.0) : 0;
        gpuLoad = std::atoi(parts[6].c_str());
        pState = parts[7];
        vrmBrake = parts[8];
        hwThermal = parts[9];
        return true;
    }
    return false;
}

static bool WriteStdoutFrame(HANDLE hOut, const std::string& json) {
    uint32_t len = (uint32_t)json.size();
    std::vector<uint8_t> frame(4 + len);
    std::memcpy(frame.data(), &len, 4);
    if (len > 0) std::memcpy(frame.data() + 4, json.data(), len);
    DWORD writtenTotal = 0;
    while (writtenTotal < (DWORD)frame.size()) {
        DWORD w = 0;
        if (!WriteFile(hOut, frame.data() + writtenTotal, (DWORD)frame.size() - writtenTotal, &w, nullptr) || w == 0) {
            return false;
        }
        writtenTotal += w;
    }
    return true;
}

int main() {
    MonitorController::WakeSignal = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    MonitorController::ProbeReadyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);

    SYSTEM_INFO sysInfo{};
    GetSystemInfo(&sysInfo);
    int numThreads = (int)(sysInfo.dwNumberOfProcessors > 0 ? sysInfo.dwNumberOfProcessors : 1);
    int numPThreads = (numThreads > 16) ? (int)(numThreads * 0.6) : ((numThreads > 8) ? (int)(numThreads * 0.5) : numThreads);

    MonitorController::GetInstantCpuLoad();
    MonitorController::StartWorker();

    wchar_t sysDir[MAX_PATH]{};
    GetSystemDirectoryW(sysDir, MAX_PATH);
    std::wstring nvmlPath = std::wstring(sysDir) + L"\\nvml.dll";
    bool hasNvmlDll = (GetFileAttributesW(nvmlPath.c_str()) != INVALID_FILE_ATTRIBUTES);
    if (hasNvmlDll) {
        NvmlHost::StartInitAsync();
    } else {
        NvmlHost::ReadyEvent = CreateEventW(nullptr, TRUE, TRUE, nullptr);
    }
    EmiHost::StartInitAsync();

    std::thread d3dInitThread([]() { D3dKmtHost::Init(); });

    HANDLE hParent = nullptr;
    int parentPid = MonitorController::GetParentProcessId();
    if (parentPid > 0) {
        hParent = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)parentPid);
    }

    double totalRamGB = 16.0, ramUsedGB = 0.0;
    int ramPct = 0;
    double commitLimitGB = 16.0, commitUsedGB = 0.0, commitPct = 0.0;
    double totalPageGB = 8.5, pageUsedGB = 0.0, pagePct = 0.0;
    double igpuSharedMB = 0.0;

    MEMORYSTATUSEX memStat{};
    memStat.dwLength = sizeof(MEMORYSTATUSEX);
    if (GlobalMemoryStatusEx(&memStat)) {
        if (memStat.ullTotalPhys > 0) {
            totalRamGB = std::round(((double)memStat.ullTotalPhys / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
            ramUsedGB = std::round(((double)(memStat.ullTotalPhys - memStat.ullAvailPhys) / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
            ramPct = (int)memStat.dwMemoryLoad;
        }
        if (memStat.ullTotalPageFile > 0) {
            commitLimitGB = std::round(((double)memStat.ullTotalPageFile / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
            commitUsedGB = std::round(((double)(memStat.ullTotalPageFile - memStat.ullAvailPageFile) / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
            if (commitLimitGB > 0.0) commitPct = std::round((commitUsedGB / commitLimitGB) * 100.0);
        }
        if (memStat.ullTotalPageFile > memStat.ullTotalPhys) {
            totalPageGB = std::round(((double)(memStat.ullTotalPageFile - memStat.ullTotalPhys) / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
        }
    }

    HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
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

    WaitForSingleObject(MonitorController::ProbeReadyEvent, INFINITE);
    ResetEvent(MonitorController::WakeSignal);

    while (MonitorController::IsRunning.load()) {
        if (hParent && WaitForSingleObject(hParent, 0) == WAIT_OBJECT_0) {
            MonitorController::IsRunning.store(false);
            break;
        }

        // 1. GPU telemetry (NVML 0ms or nvidia-smi fallback)
        double rawGpuTemp = 0.0, rawGpuWatt = 0.0, vramUsedGB = 0.0, vramTotalGB = 0.0;
        int gpuCoreClk = 0, gpuMemClk = 0, gpuLoad = 0, vramPct = 0;
        std::string pStateStr = "Unknown", vrmBrakeStr = "Not Active", hwThermalStr = "Not Active";

        if (NvmlHost::IsReady.load()) {
            unsigned int temp = 0, pwr = 0, core = 0, memC = 0, pStateVal = 0;
            unsigned long long throttleMask = 0;
            NvmlHost::NvmlUtilization util{};
            NvmlHost::NvmlMemory memInfo{};
            if (NvmlHost::GetTemperature) NvmlHost::GetTemperature(NvmlHost::DeviceHandle, 0, &temp);
            if (NvmlHost::GetPowerUsage) NvmlHost::GetPowerUsage(NvmlHost::DeviceHandle, &pwr);
            if (NvmlHost::GetUtilizationRates) NvmlHost::GetUtilizationRates(NvmlHost::DeviceHandle, &util);
            if (NvmlHost::GetMemoryInfo) NvmlHost::GetMemoryInfo(NvmlHost::DeviceHandle, &memInfo);
            if (NvmlHost::GetClockInfo) {
                NvmlHost::GetClockInfo(NvmlHost::DeviceHandle, 0, &core);
                NvmlHost::GetClockInfo(NvmlHost::DeviceHandle, 2, &memC);
            }
            if (NvmlHost::GetPerformanceState) NvmlHost::GetPerformanceState(NvmlHost::DeviceHandle, &pStateVal);
            if (NvmlHost::GetClocksThrottleReasons) NvmlHost::GetClocksThrottleReasons(NvmlHost::DeviceHandle, &throttleMask);

            rawGpuTemp = (double)temp;
            rawGpuWatt = std::round((pwr / 1000.0) * 10.0) / 10.0;
            gpuCoreClk = (int)core;
            gpuMemClk = (int)memC;
            gpuLoad = (int)util.gpu;
            pStateStr = "P" + std::to_string(pStateVal);
            vramUsedGB = std::round(((double)memInfo.used / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
            vramTotalGB = std::round(((double)memInfo.total / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
            vramPct = (memInfo.total > 0) ? (int)std::round(((double)memInfo.used / (double)memInfo.total) * 100.0) : 0;
            hwThermalStr = ((throttleMask & 0x60ULL) != 0) ? "Active" : "Not Active";
            vrmBrakeStr = ((throttleMask & 0x80ULL) != 0) ? "Active" : "Not Active";
        } else if (warmupTicks >= 3 && !hasNvmlDll) {
            TryNvidiaSmiFallback(rawGpuTemp, gpuCoreClk, gpuMemClk, rawGpuWatt,
                vramUsedGB, vramTotalGB, vramPct, gpuLoad, pStateStr, vrmBrakeStr, hwThermalStr);
        }

        // 2. CPU load and P/E core clocks (<1ms)
        int instantCpuLoad = MonitorController::GetInstantCpuLoad();
        if (instantCpuLoad > 0 || cpuUtil == 0) {
            cpuUtil = instantCpuLoad;
        }

        double maxP = 0.0, maxE = 0.0;
        std::string peClock = "P: 0.0 GHz";
        auto ntCores = MonitorController::GetProcessorPowerInfo();
        if (!ntCores.empty()) {
            int lim = std::min(numThreads, (int)ntCores.size());
            for (int th = 0; th < lim; th++) {
                double mhz = (double)ntCores[(size_t)th].CurrentMhz;
                if (th < numPThreads) {
                    if (mhz > maxP) maxP = mhz;
                } else {
                    if (mhz > maxE) maxE = mhz;
                }
            }
            if (maxP > 0.0) cpuClock = (int)std::round(maxP);
            std::string pGhz = FormatFixed1(maxP / 1000.0);
            std::string eGhz = FormatFixed1(maxE / 1000.0);
            peClock = (maxE > 0.0) ? ("P: " + pGhz + " GHz | E: " + eGhz + " GHz") : ("P: " + pGhz + " GHz");
            if (ntCores[0].MaxMhz > 0 && ntCores[0].MhzLimit > 0) {
                cpuLimit = std::min(100, (int)std::round(((double)ntCores[0].MhzLimit / (double)ntCores[0].MaxMhz) * 100.0));
            }
        }

        // 3. Direct EMI RAPL + D3DKMT Shared GPU Memory + EnumPageFilesW
        if (EmiHost::IsReady.load()) {
            double pkgW = 0.0, pp1W = 0.0;
            if (EmiHost::Sample(pkgW, pp1W)) {
                if (pkgW > 0.0) cpuPower = pkgW;
                igpuPower = pp1W;
            }
        } else if (EmiHost::ReadyEvent && WaitForSingleObject(EmiHost::ReadyEvent, 0) == WAIT_OBJECT_0) {
            if (!emiFallbackChecked) {
                emiFallbackChecked = true;
                PdhHost::EnsureFallbackRaplInit();
            }
            double pkgW = 0.0, pp1W = 0.0;
            PdhHost::SampleRaplFallback(pkgW, pp1W);
            if (pkgW > 0.0) cpuPower = pkgW;
            igpuPower = pp1W;
        }

        double shMb = D3dKmtHost::SampleMaxSharedMB();
        if (shMb > 0.0 || igpuSharedMB == 0.0) igpuSharedMB = shMb;

        double pfUsed = 0.0, pfTotal = 0.0, pfPct = 0.0;
        D3dKmtHost::SamplePageFile(pfUsed, pfTotal, pfPct);
        if (pfTotal > 0.0) {
            pageUsedGB = pfUsed;
            totalPageGB = pfTotal;
            pagePct = pfPct;
        }

        // 4. Physical & commit memory (<0.1ms)
        if (GlobalMemoryStatusEx(&memStat)) {
            ramUsedGB = std::round(((double)(memStat.ullTotalPhys - memStat.ullAvailPhys) / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
            ramPct = (int)memStat.dwMemoryLoad;
            if (memStat.ullTotalPageFile > 0 && commitLimitGB > 0.0) {
                commitUsedGB = std::round(((double)(memStat.ullTotalPageFile - memStat.ullAvailPageFile) / (1024.0 * 1024.0 * 1024.0)) * 10.0) / 10.0;
                commitPct = std::round((commitUsedGB / commitLimitGB) * 100.0);
            }
        }

        std::string igpuRamStr = (igpuSharedMB >= 1024.0)
            ? (FormatFixed1(igpuSharedMB / 1024.0) + " GB")
            : (FormatFixed0(igpuSharedMB) + " MB");

        if (cpuPower <= 0.0) {
            cpuPower = std::round((15.0 + (35.0 * (cpuUtil / 100.0))) * 10.0) / 10.0;
        }

        // 5. Lumped-Parameter Continuous Thermal Observer
        double pTotal = cpuPower + rawGpuWatt;
        double rConv = 0.22 + (0.58 / (1.0 + std::pow(pTotal / 46.0, 1.4)));
        double sinkConv = 24.0 + (pTotal * rConv);
        double sinkGpu = (rawGpuTemp >= 28.0) ? std::max(24.0, rawGpuTemp - (rawGpuWatt * 0.14) + (cpuPower * 0.06)) : sinkConv;
        double sinkTarget = (rawGpuTemp >= 28.0) ? sinkGpu : sinkConv;

        sinkTemp = isFirstTick ? sinkTarget : (sinkTemp + 0.080 * (sinkTarget - sinkTemp));

        double boostFactor = std::max(0.0, std::min(1.0, (maxP - 3200.0) / 1500.0));
        double utilFactor = 1.0 - std::max(0.0, std::min(1.0, cpuUtil / 100.0));
        double rDie = 0.32 + (0.14 * boostFactor * utilFactor);

        double cpuTarget = sinkTemp + (cpuPower * rDie);
        if (cpuLimit < 100 && cpuPower > 35.0) {
            double prochotFloor = 98.0 + std::min(2.0, (100.0 - cpuLimit) * 0.1);
            if (cpuTarget < prochotFloor) cpuTarget = prochotFloor;
        }

        double dP = isFirstTick ? 0.0 : (cpuPower - prevCpuP);
        prevCpuP = cpuPower;
        double alphaCool = (dP < -5.0) ? std::max(0.12, 0.33 + (dP * 0.012)) : 0.33;

        if (isFirstTick) {
            cpuEstTemp = cpuTarget;
            isFirstTick = false;
        } else {
            double alphaDie = (cpuTarget > cpuEstTemp) ? 0.86 : alphaCool;
            cpuEstTemp += alphaDie * (cpuTarget - cpuEstTemp);
        }

        cpuEstTemp = std::max(std::max(24.0, sinkTemp), std::min(101.0, cpuEstTemp));
        int cpuTempInt = (int)std::round(cpuEstTemp);

        SYSTEMTIME st{};
        GetLocalTime(&st);
        char tsBuf[16];
        std::snprintf(tsBuf, sizeof(tsBuf), "%02u:%02u:%02u", st.wHour, st.wMinute, st.wSecond);

        std::string payload = MonitorController::BuildTelemetryJson(
            tsBuf,
            cpuClock,
            cpuUtil,
            peClock,
            cpuPower,
            cpuTempInt,
            igpuPower,
            igpuRamStr,
            cpuLimit,
            FormatFixed1(ramUsedGB) + " / " + FormatFixed1(totalRamGB) + " GB (" + std::to_string(ramPct) + "%)",
            FormatFixed1(pageUsedGB) + " / " + FormatFixed1(totalPageGB) + " GB (" + FormatFixed0(pagePct) + "%)",
            FormatFixed1(commitUsedGB) + " / " + FormatFixed1(commitLimitGB) + " GB (" + FormatFixed0(commitPct) + "%)",
            (int)rawGpuTemp,
            gpuCoreClk,
            gpuMemClk,
            std::round(rawGpuWatt * 10.0) / 10.0,
            FormatFixed1(vramUsedGB) + " / " + FormatFixed1(vramTotalGB) + " GB (" + std::to_string(vramPct) + "%)",
            gpuLoad,
            pStateStr,
            vrmBrakeStr,
            hwThermalStr
        );

        if (!WriteStdoutFrame(hOut, payload)) {
            MonitorController::IsRunning.store(false);
            break;
        }

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

        DWORD sleepInterval = (!MonitorController::HasProbed.load()) ? 1800 : (isGamingLoad ? 800 : 1800);
        WaitForSingleObject(MonitorController::WakeSignal, sleepInterval);
    }

    MonitorController::IsRunning.store(false);
    if (d3dInitThread.joinable()) d3dInitThread.join();
    MonitorController::JoinWorkerThreads();
    {
        std::lock_guard<std::mutex> lock(MonitorController::SyncMutex);
        MonitorController::ReleaseBoundMonitorsLocked();
    }
    EmiHost::Shutdown();
    D3dKmtHost::Shutdown();
    PdhHost::Shutdown();
    NvmlHost::WaitShutdown();
    if (hParent) CloseHandle(hParent);
    if (NvmlHost::IsReady.load() && NvmlHost::Shutdown) NvmlHost::Shutdown();
    if (MonitorController::WakeSignal) CloseHandle(MonitorController::WakeSignal);
    if (MonitorController::ProbeReadyEvent) CloseHandle(MonitorController::ProbeReadyEvent);
    if (NvmlHost::ReadyEvent) CloseHandle(NvmlHost::ReadyEvent);
    if (EmiHost::ReadyEvent) CloseHandle(EmiHost::ReadyEvent);
    return 0;
}
