using System.Text.Json;

internal static class RelayConfigReader
{
    private const int MaximumBytes = 1024 * 1024;

    public static JsonDocument? Read(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        try
        {
            var full = Path.GetFullPath(path);
            using var directory = SecureRelayDirectory.Open(Path.GetDirectoryName(full)!, create: false, makePrivate: false);
            using var file = directory.File(Path.GetFileName(full));
            if (file.Stream.Length > MaximumBytes) throw new IOException();
            using var content = new MemoryStream();
            var buffer = new byte[16 * 1024];
            int read;
            while ((read = file.Stream.Read(buffer)) != 0)
            {
                if (read > MaximumBytes - content.Length) throw new IOException();
                content.Write(buffer, 0, read);
            }
            file.Validate();
            return JsonDocument.Parse(content.ToArray());
        }
        catch (FileNotFoundException) { return null; }
        catch (Exception) { throw new IOException("Relay configuration rejected"); }
    }
}
