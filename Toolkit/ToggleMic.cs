using System;
using System.Runtime.InteropServices;

namespace ToggleMicApp {
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume {
        int f(); int g(); int h(); int i();
        int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
        int j();
        int GetMasterVolumeLevelScalar(out float pfLevel);
        int k(); int l(); int m(); int n();
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
        int GetMute(out bool pbMute);
    }
    
    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
    }
    
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        int f();
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }
    
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject {}

    public class Program {
        [STAThread]
        public static void Main() {
            IMMDeviceEnumerator enumerator = null;
            IMMDevice dev = null;
            IAudioEndpointVolume epv = null;
            
            try {
                enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
                Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(1, 0, out dev));
                var epvid = typeof(IAudioEndpointVolume).GUID;
                Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 23, 0, out epv));
                
                bool currentMute;
                Marshal.ThrowExceptionForHR(epv.GetMute(out currentMute));
                Marshal.ThrowExceptionForHR(epv.SetMute(!currentMute, System.Guid.Empty));
            } finally {
                if (epv != null) Marshal.ReleaseComObject(epv);
                if (dev != null) Marshal.ReleaseComObject(dev);
                if (enumerator != null) Marshal.ReleaseComObject(enumerator);
            }
        }
    }
}
