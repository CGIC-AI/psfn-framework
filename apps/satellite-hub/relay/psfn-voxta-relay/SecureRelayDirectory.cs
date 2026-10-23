using Microsoft.Win32.SafeHandles;

internal sealed class SecureRelayDirectory : IDisposable
{
    private readonly List<SafeFileHandle> _ancestors;
    public string Path { get; }
    public SafeFileHandle Handle => _ancestors[^1];

    private SecureRelayDirectory(string path, List<SafeFileHandle> ancestors)
    {
        Path = path;
        _ancestors = ancestors;
    }

    public static SecureRelayDirectory Open(string path, bool create, bool makePrivate)
    {
        var full = System.IO.Path.GetFullPath(path);
        var root = System.IO.Path.GetPathRoot(full) ?? throw new IOException("Relay directory rejected");
        if (OperatingSystem.IsWindows() && (root.StartsWith(@"\\", StringComparison.Ordinal) || root.Length != 3))
            throw new IOException("Relay directory rejected");
        var handles = new List<SafeFileHandle>();
        try
        {
            handles.Add(RelayNativeFiles.OpenDirectory(null, root, root, create: false));
            var current = root;
            var parts = full[root.Length..].Split(System.IO.Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
            foreach (var part in parts)
            {
                ValidateName(part);
                current = System.IO.Path.Combine(current, part);
                handles.Add(RelayNativeFiles.OpenDirectory(handles[^1], part, current, create,
                    privateAccess: makePrivate && current == full));
            }
            if (makePrivate) RelayNativeFiles.MakePrivateDirectory(handles[^1]);
            return new SecureRelayDirectory(full, handles);
        }
        catch { foreach (var handle in handles) handle.Dispose(); throw; }
    }

    public SecureRelayDirectory Child(string name, bool create, bool makePrivate = true)
    {
        ValidateName(name);
        var path = System.IO.Path.Combine(Path, name);
        var handle = RelayNativeFiles.OpenDirectory(Handle, name, path, create, privateAccess: makePrivate);
        try
        {
            if (makePrivate) RelayNativeFiles.MakePrivateDirectory(handle);
            return new SecureRelayDirectory(path, [handle]);
        }
        catch { handle.Dispose(); throw; }
    }

    public SecureRelayFile File(string name, bool create = false, bool deletable = false)
    {
        ValidateName(name);
        var handle = RelayNativeFiles.OpenFile(Handle, name, System.IO.Path.Combine(Path, name), create, deletable);
        try { return new SecureRelayFile(this, name, new FileStream(handle, create ? FileAccess.Write : FileAccess.Read)); }
        catch { handle.Dispose(); throw; }
    }

    public IEnumerable<string> Names() => Directory.EnumerateFileSystemEntries(Path).Select(System.IO.Path.GetFileName).OfType<string>();

    public void VerifyPath()
    {
        using var current = Open(Path, create: false, makePrivate: false);
        if (!RelayNativeFiles.SameIdentity(Handle, current.Handle)) throw new IOException("Relay directory identity changed");
    }

    private static void ValidateName(string name)
    {
        if (name is "" or "." or ".." || System.IO.Path.GetFileName(name) != name || name.Any(char.IsControl)
            || (OperatingSystem.IsWindows() && (name.Contains(':') || name.EndsWith('.') || name.EndsWith(' '))))
            throw new IOException("Relay filename rejected");
    }

    public void Dispose() { foreach (var handle in _ancestors.AsEnumerable().Reverse()) handle.Dispose(); }
}

internal sealed class SecureRelayFile(SecureRelayDirectory directory, string name, FileStream stream) : IDisposable
{
    public FileStream Stream { get; } = stream;
    public DateTimeOffset Modified => RelayNativeFiles.ValidateFile(Stream.SafeFileHandle);
    public void Validate() => RelayNativeFiles.ValidateFile(Stream.SafeFileHandle);
    public void MakePrivate() => RelayNativeFiles.MakePrivateFile(Stream.SafeFileHandle);
    public void Delete(bool verifyPath = true)
    {
        if (verifyPath) directory.VerifyPath();
        if (OperatingSystem.IsLinux())
        {
            using var current = directory.File(name);
            if (!RelayNativeFiles.SameIdentity(Stream.SafeFileHandle, current.Stream.SafeFileHandle))
                throw new IOException("Relay file identity changed");
        }
        RelayNativeFiles.Delete(Stream.SafeFileHandle, directory.Handle, name);
    }
    public void Commit(string target)
    {
        directory.VerifyPath();
        // Refuse an existing symlink, hardlink, special file or directory. Atomic
        // rename replaces a directory entry even if an attacker races this check.
        try { using var existing = directory.File(target); }
        catch (FileNotFoundException) { }
        RelayNativeFiles.Rename(Stream.SafeFileHandle, directory.Handle, name, target, System.IO.Path.Combine(directory.Path, target));
    }
    public void Dispose() => Stream.Dispose();
}
