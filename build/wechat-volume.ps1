param(
    [string]$Action,
    [float]$Volume
)

$procs = Get-Process -Name "*WeChat*" -ErrorAction SilentlyContinue
if (-not $procs) {
    Write-Error "未找到任何微信相关进程"
    Write-Output -1
    exit 1
}

$csCode = @'
using System;
using System.Runtime.InteropServices;

namespace AudioApi
{
    // ========== IMMDeviceEnumerator ==========
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    public interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    }

    // ========== IMMDevice ==========
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    public interface IMMDevice
    {
        [PreserveSig] int Activate(
            [MarshalAs(UnmanagedType.LPStruct)] Guid iid,
            uint dwClsCtx,
            IntPtr pActivationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    // ========== IAudioSessionManager2 ==========
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    public interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr AudioSessionGuid, uint StreamFlags, out IntPtr SessionControl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr AudioSessionGuid, uint StreamFlags, out ISimpleAudioVolume SimpleVolume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
    }

    // ========== IAudioSessionEnumerator ==========
    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    public interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int SessionCount);
        [PreserveSig] int GetSession(int SessionIndex, out IAudioSessionControl2 Session);
    }

    // ========== IAudioSessionControl2 (扁平化，包含 IAudioSessionControl 的所有方法 + 扩展方法) ==========
    // 注意：COM vtable 是扁平的，这里必须按顺序列出基接口的所有方法，再列扩展方法
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    public interface IAudioSessionControl2
    {
        // IAudioSessionControl 的 9 个方法
        [PreserveSig] int GetState(out uint pRetVal);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
        [PreserveSig] int GetGroupingParam(out Guid pRetVal);
        [PreserveSig] int SetGroupingParam(ref Guid Override, ref Guid EventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr Notify);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr Notify);

        // IAudioSessionControl2 扩展的 5 个方法
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int GetProcessId(out uint pRetVal);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool bOptOut);
    }

    // ========== ISimpleAudioVolume ==========
    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
    public interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float fLevel, ref Guid EventContext);
        [PreserveSig] int GetMasterVolume(out float pfLevel);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid EventContext);
        [PreserveSig] int GetMute(out bool pbMute);
    }

    public class AudioHelper
    {
        private const uint CLSCTX_ALL = 23; // CLSCTX_INPROC_SERVER | CLSCTX_INPROC_HANDLER | CLSCTX_LOCAL_SERVER | CLSCTX_REMOTE_SERVER

        private static ISimpleAudioVolume GetSimpleVolume(IAudioSessionControl2 session)
        {
            // 先尝试直接转换
            var vol = session as ISimpleAudioVolume;
            if (vol != null) return vol;

            // 兜底：显式 QueryInterface
            IntPtr pUnk = Marshal.GetIUnknownForObject(session);
            if (pUnk == IntPtr.Zero) return null;
            try
            {
                Guid volGuid = typeof(ISimpleAudioVolume).GUID;
                IntPtr pVol;
                int hr = Marshal.QueryInterface(pUnk, ref volGuid, out pVol);
                if (hr != 0 || pVol == IntPtr.Zero) return null;
                try
                {
                    return (ISimpleAudioVolume)Marshal.GetObjectForIUnknown(pVol);
                }
                finally { Marshal.Release(pVol); }
            }
            finally { Marshal.Release(pUnk); }
        }

        public static float GetVolumeForProcess(int pid)
        {
            try
            {
                Type devEnumType = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
                var devEnum = (IMMDeviceEnumerator)Activator.CreateInstance(devEnumType);
                IMMDevice defaultDevice;
                int hr = devEnum.GetDefaultAudioEndpoint(0, 1, out defaultDevice); // eRender=0, eMultimedia=1
                if (hr != 0 || defaultDevice == null) throw new Exception("GetDefaultAudioEndpoint failed: 0x" + hr.ToString("X"));

                object sessionManagerObj;
                Guid iid = typeof(IAudioSessionManager2).GUID;
                hr = defaultDevice.Activate(iid, CLSCTX_ALL, IntPtr.Zero, out sessionManagerObj);
                if (hr != 0 || sessionManagerObj == null) throw new Exception("Activate IAudioSessionManager2 failed: 0x" + hr.ToString("X"));

                var sessionManager = (IAudioSessionManager2)sessionManagerObj;
                IAudioSessionEnumerator enumerator;
                hr = sessionManager.GetSessionEnumerator(out enumerator);
                if (hr != 0 || enumerator == null) throw new Exception("GetSessionEnumerator failed: 0x" + hr.ToString("X"));

                int count;
                hr = enumerator.GetCount(out count);
                if (hr != 0) throw new Exception("GetCount failed: 0x" + hr.ToString("X"));

                for (int i = 0; i < count; i++)
                {
                    IAudioSessionControl2 session;
                    hr = enumerator.GetSession(i, out session);
                    if (hr != 0 || session == null) continue;

                    uint sessionPid;
                    hr = session.GetProcessId(out sessionPid);
                    if (hr != 0 || sessionPid != pid) continue;

                    var simpleVol = GetSimpleVolume(session);
                    if (simpleVol == null) continue;

                    float vol;
                    hr = simpleVol.GetMasterVolume(out vol);
                    if (hr != 0) continue;
                    return vol;
                }
                return -1;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("GetVolume Exception: " + ex.Message);
                return -1;
            }
        }

        public static bool SetVolumeForProcess(int pid, float targetVolume)
        {
            try
            {
                Type devEnumType = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
                var devEnum = (IMMDeviceEnumerator)Activator.CreateInstance(devEnumType);
                IMMDevice defaultDevice;
                int hr = devEnum.GetDefaultAudioEndpoint(0, 1, out defaultDevice);
                if (hr != 0 || defaultDevice == null) throw new Exception("GetDefaultAudioEndpoint failed: 0x" + hr.ToString("X"));

                object sessionManagerObj;
                Guid iid = typeof(IAudioSessionManager2).GUID;
                hr = defaultDevice.Activate(iid, CLSCTX_ALL, IntPtr.Zero, out sessionManagerObj);
                if (hr != 0 || sessionManagerObj == null) throw new Exception("Activate IAudioSessionManager2 failed: 0x" + hr.ToString("X"));

                var sessionManager = (IAudioSessionManager2)sessionManagerObj;
                IAudioSessionEnumerator enumerator;
                hr = sessionManager.GetSessionEnumerator(out enumerator);
                if (hr != 0 || enumerator == null) throw new Exception("GetSessionEnumerator failed: 0x" + hr.ToString("X"));

                int count;
                hr = enumerator.GetCount(out count);
                if (hr != 0) throw new Exception("GetCount failed: 0x" + hr.ToString("X"));

                for (int i = 0; i < count; i++)
                {
                    IAudioSessionControl2 session;
                    hr = enumerator.GetSession(i, out session);
                    if (hr != 0 || session == null) continue;

                    uint sessionPid;
                    hr = session.GetProcessId(out sessionPid);
                    if (hr != 0 || sessionPid != pid) continue;

                    var simpleVol = GetSimpleVolume(session);
                    if (simpleVol == null) continue;

                    Guid ctx = Guid.Empty;
                    hr = simpleVol.SetMasterVolume(targetVolume, ref ctx);
                    if (hr != 0) continue;
                    return true;
                }
                return false;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("SetVolume Exception: " + ex.Message);
                return false;
            }
        }
    }
}
'@

Add-Type -TypeDefinition $csCode

if ($Action -eq "get") {
    $foundVolume = -1
    foreach ($p in $procs) {
        $vol = [AudioApi.AudioHelper]::GetVolumeForProcess($p.Id)
        if ($vol -ge 0) {
            $foundVolume = $vol
            break
        }
    }
    if ($foundVolume -ge 0) {
        Write-Output $foundVolume
        exit 0
    } else {
        Write-Error "未找到微信进程的音频会话（微信可能未播放过声音）"
        exit 1
    }
}
elseif ($Action -eq "set") {
    if ($Volume -lt 0 -or $Volume -gt 1) {
        Write-Error "Volume must be between 0 and 1"
        exit 1
    }
    $success = $false
    foreach ($p in $procs) {
        if ([AudioApi.AudioHelper]::SetVolumeForProcess($p.Id, $Volume)) {
            $success = $true
            break
        }
    }
    if ($success) {
        exit 0
    } else {
        Write-Error "无法设置微信进程音量"
        exit 1
    }
}
else {
    Write-Error "Invalid action. Use 'get' or 'set'."
    exit 1
}
