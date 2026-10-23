using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Linux uses descriptor-relative operations. Windows pins every ancestor
// without delete sharing and uses no-follow handles for files and directories.
internal static class RelayNativeFiles
{
    private const int NoFollow = 0x20000;
    private const int CloseOnExec = 0x80000;
    private const int DirectoryFlag = 0x10000;
    private const uint ReparsePoint = 0x400;
    private const uint DirectoryAttribute = 0x10;

    public static SafeFileHandle OpenDirectory(SafeFileHandle? parent, string name, string path, bool create, bool privateAccess = false)
    {
        if (OperatingSystem.IsLinux())
        {
            var parentFd = parent is null ? -100 : parent.DangerousGetHandle().ToInt32();
            var fd = OpenAt(parentFd, name, NoFollow | CloseOnExec | DirectoryFlag, 0);
            if (fd < 0 && create && Marshal.GetLastPInvokeError() == 2)
            {
                if (MkdirAt(parentFd, name, 0x1c0) != 0 && Marshal.GetLastPInvokeError() != 17) Reject();
                fd = OpenAt(parentFd, name, NoFollow | CloseOnExec | DirectoryFlag, 0);
            }
            if (fd < 0) RejectOpen();
            return new SafeFileHandle(new IntPtr(fd), ownsHandle: true);
        }
        if (OperatingSystem.IsWindows())
        {
            var access = 0x80u | 1u | (privateAccess ? 0x00060000u : 0u);
            var handle = CreateFile(path, access, 3, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
            if (handle.IsInvalid && create && Marshal.GetLastPInvokeError() is 2 or 3)
            {
                handle.Dispose();
                using var security = new OwnerSecurity();
                var attributes = security.Attributes;
                if (!CreateDirectory(path, ref attributes) && Marshal.GetLastPInvokeError() != 183) RejectOpen();
                handle = CreateFile(path, access, 3, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
            }
            if (handle.IsInvalid) { handle.Dispose(); RejectOpen(); }
            var info = WindowsInfo(handle);
            if ((info.Attributes & (ReparsePoint | DirectoryAttribute)) != DirectoryAttribute)
            {
                handle.Dispose();
                Reject();
            }
            return handle;
        }
        throw new PlatformNotSupportedException("Secure relay files require Linux or Windows");
    }

    public static void MakePrivateDirectory(SafeFileHandle handle)
    {
        if (OperatingSystem.IsLinux())
        {
            var info = LinuxInfo(handle);
            if ((info.Mode & 0xf000) != 0x4000 || info.User != GetEffectiveUserId()
                || Fchmod(handle, 0x1c0) != 0) Reject();
        }
        else if (OperatingSystem.IsWindows())
        {
            SetOwnerOnlyAccess(handle);
        }
        else Reject();
    }

    public static SafeFileHandle OpenFile(SafeFileHandle parent, string name, string path, bool create, bool deletable)
    {
        SafeFileHandle handle;
        if (OperatingSystem.IsLinux())
        {
            var flags = NoFollow | CloseOnExec | 0x800; // O_NONBLOCK rejects blocking special files before fstat.
            if (create) flags |= 1 | 0x40 | 0x80; // O_WRONLY | O_CREAT | O_EXCL
            var fd = OpenAt(parent.DangerousGetHandle().ToInt32(), name, flags, 0x180);
            if (fd < 0) RejectOpen();
            handle = new SafeFileHandle(new IntPtr(fd), ownsHandle: true);
        }
        else if (OperatingSystem.IsWindows())
        {
            using var security = new OwnerSecurity();
            var attributes = security.Attributes;
            handle = CreatePrivateFile(path, create ? 0x40010080u : 0x80000080u | (deletable ? 0x70000u : 0u),
                create ? 0u : 1u, ref attributes, create ? 1u : 3u, 0x00200000, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); RejectOpen(); }
        }
        else throw new PlatformNotSupportedException("Secure relay files require Linux or Windows");
        try
        {
            ValidateFile(handle);
            if (create && OperatingSystem.IsLinux() && Fchmod(handle, 0x180) != 0) Reject();
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }

    public static DateTimeOffset ValidateFile(SafeFileHandle handle)
    {
        if (OperatingSystem.IsLinux())
        {
            var info = LinuxInfo(handle);
            if ((info.Mode & 0xf000) != 0x8000 || info.Links != 1) Reject();
            return DateTimeOffset.FromUnixTimeSeconds(info.ModifiedSeconds);
        }
        if (OperatingSystem.IsWindows())
        {
            var info = WindowsInfo(handle);
            if ((info.Attributes & (ReparsePoint | DirectoryAttribute)) != 0 || info.Links != 1
                || GetFileType(handle) != 1) Reject();
            var time = ((long)info.Modified.dwHighDateTime << 32) | (uint)info.Modified.dwLowDateTime;
            return DateTimeOffset.FromFileTime(time);
        }
        throw new PlatformNotSupportedException("Secure relay files require Linux or Windows");
    }

    public static void MakePrivateFile(SafeFileHandle handle)
    {
        ValidateFile(handle);
        if (OperatingSystem.IsLinux())
        {
            if (LinuxInfo(handle).User != GetEffectiveUserId() || Fchmod(handle, 0x180) != 0) Reject();
        }
        else if (OperatingSystem.IsWindows()) SetOwnerOnlyAccess(handle);
        else Reject();
    }

    [SupportedOSPlatform("windows")]
    private static void SetOwnerOnlyAccess(SafeFileHandle handle)
    {
        using var security = new OwnerSecurity();
        if (GetSecurityInfo(handle, 1, 1, out var owner, out _, out _, out _, out var descriptor) != 0) Reject();
        try
        {
            if (owner == IntPtr.Zero || new SecurityIdentifier(owner).Value != security.Sid) Reject();
        }
        finally { LocalFree(descriptor); }
        if (!GetSecurityDescriptorDacl(security.Pointer, out var present, out var acl, out _)
            || !present || SetSecurityInfo(handle, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, acl, IntPtr.Zero) != 0) Reject();
    }

    public static bool SameIdentity(SafeFileHandle left, SafeFileHandle right)
    {
        if (OperatingSystem.IsLinux())
        {
            var a = LinuxInfo(left);
            var b = LinuxInfo(right);
            return a.Inode == b.Inode && a.DeviceMajor == b.DeviceMajor && a.DeviceMinor == b.DeviceMinor;
        }
        if (OperatingSystem.IsWindows())
        {
            var a = WindowsInfo(left);
            var b = WindowsInfo(right);
            return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow;
        }
        throw new PlatformNotSupportedException("Secure relay files require Linux or Windows");
    }

    public static void Rename(SafeFileHandle file, SafeFileHandle parent, string sourceName, string targetName, string targetPath)
    {
        ValidateFile(file);
        if (OperatingSystem.IsLinux())
        {
            var fd = parent.DangerousGetHandle().ToInt32();
            if (RenameAt(fd, sourceName, fd, targetName) != 0) Reject();
        }
        else if (OperatingSystem.IsWindows())
        {
            var name = Encoding.Unicode.GetBytes(targetPath);
            var lengthOffset = IntPtr.Size == 8 ? 16 : 8;
            var nameOffset = lengthOffset + 4;
            var buffer = Marshal.AllocHGlobal(nameOffset + name.Length);
            try
            {
                Marshal.WriteInt32(buffer, 1); // Replace the directory entry, never follow it.
                Marshal.WriteIntPtr(buffer, IntPtr.Size == 8 ? 8 : 4, IntPtr.Zero);
                Marshal.WriteInt32(buffer, lengthOffset, name.Length);
                Marshal.Copy(name, 0, buffer + nameOffset, name.Length);
                if (!SetFileInformation(file, 3, buffer, (uint)(nameOffset + name.Length))) Reject();
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        else Reject();
    }

    public static void Delete(SafeFileHandle file, SafeFileHandle parent, string name)
    {
        ValidateFile(file);
        if (OperatingSystem.IsLinux())
        {
            if (UnlinkAt(parent.DangerousGetHandle().ToInt32(), name, 0) != 0) Reject();
        }
        else if (OperatingSystem.IsWindows())
        {
            var delete = Marshal.AllocHGlobal(1);
            try
            {
                Marshal.WriteByte(delete, 1);
                if (!SetFileInformation(file, 4, delete, 1)) Reject();
            }
            finally { Marshal.FreeHGlobal(delete); }
        }
        else Reject();
    }

    private static LinuxStat LinuxInfo(SafeFileHandle handle)
    {
        if (Statx(handle, "", 0x1000, 0x7ff, out var info) != 0 || (info.Mask & 0x7ff) != 0x7ff) Reject();
        return info;
    }

    private static WindowsStat WindowsInfo(SafeFileHandle handle)
    {
        if (!GetFileInformation(handle, out var info)) Reject();
        return info;
    }

    private static void Reject() => throw new IOException("Relay filesystem operation rejected");
    private static void RejectOpen()
    {
        var error = Marshal.GetLastPInvokeError();
        if ((OperatingSystem.IsLinux() && error == 2) || (OperatingSystem.IsWindows() && error is 2 or 3))
            throw new FileNotFoundException("Relay file is unavailable");
        Reject();
    }

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct LinuxStat
    {
        [FieldOffset(0)] public uint Mask;
        [FieldOffset(16)] public uint Links;
        [FieldOffset(20)] public uint User;
        [FieldOffset(28)] public ushort Mode;
        [FieldOffset(32)] public ulong Inode;
        [FieldOffset(112)] public long ModifiedSeconds;
        [FieldOffset(136)] public uint DeviceMajor;
        [FieldOffset(140)] public uint DeviceMinor;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowsStat
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Modified;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public uint Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }

    [SupportedOSPlatform("windows")]
    private sealed class OwnerSecurity : IDisposable
    {
        public IntPtr Pointer { get; }
        public string Sid { get; }
        public SecurityAttributes Attributes => new() { Length = (uint)Marshal.SizeOf<SecurityAttributes>(), Descriptor = Pointer };
        public OwnerSecurity()
        {
            using var identity = WindowsIdentity.GetCurrent();
            Sid = identity.User?.Value ?? throw new IOException("Relay file owner is unavailable");
            if (!ConvertDescriptor($"O:{Sid}D:P(A;OICI;FA;;;{Sid})", 1, out var pointer, out _)) Reject();
            Pointer = pointer;
        }
        public void Dispose() => LocalFree(Pointer);
    }

    [DllImport("libc", EntryPoint = "openat", SetLastError = true)] private static extern int OpenAt(int parent, string name, int flags, uint mode);
    [DllImport("libc", EntryPoint = "mkdirat", SetLastError = true)] private static extern int MkdirAt(int parent, string name, uint mode);
    [DllImport("libc", EntryPoint = "fchmod", SetLastError = true)] private static extern int Fchmod(SafeFileHandle file, uint mode);
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)] private static extern int Statx(SafeFileHandle file, string path, int flags, uint mask, out LinuxStat info);
    [DllImport("libc", EntryPoint = "geteuid")] private static extern uint GetEffectiveUserId();
    [DllImport("libc", EntryPoint = "renameat", SetLastError = true)] private static extern int RenameAt(int sourceParent, string source, int targetParent, string target);
    [DllImport("libc", EntryPoint = "unlinkat", SetLastError = true)] private static extern int UnlinkAt(int parent, string name, int flags);
    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateDirectory(string path, ref SecurityAttributes security);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreatePrivateFile(string path, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandle", SetLastError = true)] private static extern bool GetFileInformation(SafeFileHandle file, out WindowsStat info);
    [DllImport("kernel32.dll", EntryPoint = "GetFileType", SetLastError = true)] private static extern uint GetFileType(SafeFileHandle file);
    [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)] private static extern bool SetFileInformation(SafeFileHandle file, int infoClass, IntPtr buffer, uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertDescriptor(string descriptor, uint revision, out IntPtr security, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, [MarshalAs(UnmanagedType.Bool)] out bool present, out IntPtr acl, [MarshalAs(UnmanagedType.Bool)] out bool defaulted);
    [DllImport("advapi32.dll")] private static extern uint SetSecurityInfo(SafeFileHandle file, int kind, uint information, IntPtr owner, IntPtr group, IntPtr acl, IntPtr sacl);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityInfo(SafeFileHandle file, int kind, uint information, out IntPtr owner, out IntPtr group, out IntPtr acl, out IntPtr sacl, out IntPtr descriptor);
}
