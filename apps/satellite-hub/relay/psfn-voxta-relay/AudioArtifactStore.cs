using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;

public sealed record RelayArtifactLimits
{
    public long MaximumBytes { get; init; } = 32 * 1024 * 1024;
    public TimeSpan TransferTimeout { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan Retention { get; init; } = TimeSpan.FromHours(24);
}

public sealed class AudioArtifactStore : IDisposable
{
    private readonly HttpClient _http;
    private readonly RelayOptions _options;
    private readonly ILogger<AudioArtifactStore> _logger;
    private readonly string _root;
    private readonly TimeProvider _clock;
    private readonly RelayArtifactLimits _limits;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public AudioArtifactStore(HttpClient http, RelayOptions options, ILogger<AudioArtifactStore> logger,
        TimeProvider? clock = null, RelayArtifactLimits? limits = null)
    {
        _http = http;
        _options = options;
        _logger = logger;
        try { _root = RelayArtifactPaths.Approve(options.FallbackAudioFolder, Path.GetFullPath(options.FallbackAudioFolder)); }
        catch (Exception) { throw Rejected(); }
        _clock = clock ?? TimeProvider.System;
        _limits = limits ?? new RelayArtifactLimits();
        if (_limits.MaximumBytes <= 0 || _limits.TransferTimeout <= TimeSpan.Zero || _limits.Retention <= TimeSpan.Zero)
            throw new IOException("Relay artifact limits rejected");
    }

    public string ApproveAudioFolder(string audioFolder)
    {
        try { using var folder = OpenFolder(audioFolder, create: true); return folder.Directory.Path; }
        catch (Exception) { throw Rejected(); }
    }

    public async Task<string> EnsureLocalAsync(string audioUrl, string audioFolder, CancellationToken cancellationToken = default)
    {
        using var deadline = new CancellationTokenSource(_limits.TransferTimeout, _clock);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
        var admitted = false;
        try
        {
            await _gate.WaitAsync(linked.Token);
            admitted = true;
            using var folder = OpenFolder(audioFolder, create: true);
            SweepDirectory(folder.Directory, _clock.GetUtcNow() - _limits.Retention);
            if (Uri.TryCreate(audioUrl, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, uri);
                RelayAccess.Authenticate(request, _options);
                using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token);
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength > _limits.MaximumBytes) throw Rejected();
                await using var input = await response.Content.ReadAsStreamAsync(linked.Token);
                return await Materialize(input, folder.Directory, Hash(uri.ToString()),
                    Extension(uri.AbsolutePath, response.Content.Headers.ContentType), linked.Token);
            }

            var source = uri?.Scheme == "file" && !uri.IsUnc ? uri.LocalPath : audioUrl;
            source = RelayArtifactPaths.Approve(_root, source);
            var extension = Path.GetExtension(source).ToLowerInvariant();
            if (extension is not (".wav" or ".mp3")) throw Rejected();
            using var sourceFolder = OpenFolder(Path.GetDirectoryName(source)!, create: false);
            using var file = sourceFolder.Directory.File(Path.GetFileName(source));
            if (file.Stream.Length > _limits.MaximumBytes) throw Rejected();
            return await Materialize(file.Stream, folder.Directory, Hash(source), extension, linked.Token, file.Validate);
        }
        catch (Exception) { throw Rejected(); }
        finally { if (admitted) _gate.Release(); }
    }

    public void SweepExpired()
    {
        _gate.Wait();
        try
        {
            using var folder = OpenFolder(_root, create: true);
            SweepDirectory(folder.Directory, _clock.GetUtcNow() - _limits.Retention);
        }
        catch (Exception) { throw Rejected(); }
        finally { _gate.Release(); }
    }

    private async Task<string> Materialize(Stream input, SecureRelayDirectory folder, string hash, string extension,
        CancellationToken token, Action? validateSource = null)
    {
        var final = $"psfn_{hash}{extension}";
        var temporary = $"psfn_{Guid.NewGuid():N}.partial";
        folder.VerifyPath();
        using var output = folder.File(temporary, create: true);
        var committed = false;
        try
        {
            var buffer = new byte[64 * 1024];
            long total = 0;
            while (true)
            {
                var read = await input.ReadAsync(buffer, token);
                if (read == 0) break;
                if (read > _limits.MaximumBytes - total) throw Rejected();
                await output.Stream.WriteAsync(buffer.AsMemory(0, read), token);
                total += read;
            }
            token.ThrowIfCancellationRequested();
            await output.Stream.FlushAsync(token);
            output.Stream.Flush(flushToDisk: true);
            validateSource?.Invoke();
            output.Commit(final);
            committed = true;
            RelayLogging.Write(_logger, RelayEvent.AudioDownloaded, bytes: total);
            return Path.Combine(folder.Path, final);
        }
        finally
        {
            if (!committed) output.Delete(verifyPath: false);
        }
    }

    private void SweepDirectory(SecureRelayDirectory directory, DateTimeOffset cutoff, int depth = 0)
    {
        directory.VerifyPath();
        foreach (var name in directory.Names())
        {
            try
            {
                if (IsRelayFile(name))
                {
                    using var file = directory.File(name, deletable: true);
                    file.MakePrivate();
                    if (file.Modified <= cutoff)
                    {
                        file.Delete();
                        RelayLogging.Write(_logger, RelayEvent.ArtifactExpired);
                    }
                }
                else
                {
                    var attributes = File.GetAttributes(Path.Combine(directory.Path, name));
                    if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == FileAttributes.Directory)
                    {
                        if (depth >= 32) throw Rejected();
                        using var child = directory.Child(name, create: false, makePrivate: false);
                        SweepDirectory(child, cutoff, depth + 1);
                    }
                }
            }
            catch (FileNotFoundException) { }
            catch (Exception) { RelayLogging.Write(_logger, RelayEvent.ArtifactCleanupRejected); }
        }
    }

    private FolderLease OpenFolder(string candidate, bool create)
    {
        var approved = RelayArtifactPaths.Approve(_root, candidate);
        var directories = new List<SecureRelayDirectory>();
        try
        {
            directories.Add(SecureRelayDirectory.Open(_root, create, makePrivate: true));
            var relative = Path.GetRelativePath(_root, approved);
            if (relative != ".")
            {
                var parts = relative.Split(Path.DirectorySeparatorChar);
                if (parts.Length > 32) throw Rejected();
                foreach (var part in parts) directories.Add(directories[^1].Child(part, create));
            }
            return new FolderLease(directories);
        }
        catch { foreach (var directory in directories.AsEnumerable().Reverse()) directory.Dispose(); throw; }
    }

    private static bool IsRelayFile(string name)
    {
        var extension = Path.GetExtension(name);
        if (extension is not (".wav" or ".mp3" or ".partial")) return false;
        var stem = Path.GetFileNameWithoutExtension(name);
        return stem.StartsWith("psfn_", StringComparison.Ordinal) && stem.Length is 29 or 37
            && stem.AsSpan(5).IndexOfAnyExcept("0123456789abcdef") < 0;
    }

    private static string Extension(string path, MediaTypeHeaderValue? contentType) =>
        Path.GetExtension(path).ToLowerInvariant() == ".mp3" || contentType?.MediaType is "audio/mpeg" or "audio/mp3" ? ".mp3" : ".wav";
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..24].ToLowerInvariant();
    private static IOException Rejected() => new("Relay artifact operation rejected");
    public void Dispose() => _gate.Dispose();

    private sealed class FolderLease(List<SecureRelayDirectory> directories) : IDisposable
    {
        public SecureRelayDirectory Directory => directories[^1];
        public void Dispose() { foreach (var directory in directories.AsEnumerable().Reverse()) directory.Dispose(); }
    }
}
