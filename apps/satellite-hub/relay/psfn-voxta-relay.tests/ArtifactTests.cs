using System.Net;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Extensions.Logging.Abstractions;

public static class ArtifactTests
{
    public static async Task RunAsync()
    {
        var scratch = Directory.CreateTempSubdirectory("relay-artifact-tests-").FullName;
        var root = Path.Combine(scratch, "approved");
        var outside = Path.Combine(scratch, "invented-private-outside");
        var options = new RelayOptions("http://127.0.0.1:8789", new Uri("http://127.0.0.1:1/hub"),
            new Uri("http://127.0.0.1:1"), root, null);
        using var client = new HttpClient(new FixtureHandler());
        var store = new AudioArtifactStore(client, options, NullLogger<AudioArtifactStore>.Instance);
        var rejected = false;
        try
        {
            await store.EnsureLocalAsync("http://127.0.0.1:1/invented-private-audio.wav?token=invented-private-credential", outside);
        }
        catch (Exception error)
        {
            rejected = true;
            Require(!error.ToString().Contains("invented-private"), "Artifact error exposed private input");
        }
        Require(rejected, "Client audio folders outside the configured root must be rejected");
        Require(!Directory.Exists(outside), "Rejected paths must have no filesystem effects");
        Console.WriteLine("PASS: artifact writes remain inside the approved root");
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(outside);
        var linkedFolder = Path.Combine(root, "linked");
        Directory.CreateSymbolicLink(linkedFolder, outside);
        rejected = false;
        try { await store.EnsureLocalAsync("http://127.0.0.1:1/audio.wav", linkedFolder); }
        catch (Exception error)
        {
            rejected = true;
            Require(!error.ToString().Contains(scratch), "Symlink rejection exposed a filesystem path");
        }
        Require(rejected, "Artifact storage must refuse symlinked directories");
        Require(!Directory.EnumerateFileSystemEntries(outside).Any(), "Symlink rejection modified the outside directory");
        var uri = "http://127.0.0.1:1/invented-private-audio.wav?token=invented-private-credential";
        var final = await store.EnsureLocalAsync(uri, root);
        Require(File.ReadAllText(final) == "RIFF invented audio fixture", "Approved audio did not materialize");
        AssertPrivate(root, directory: true);
        AssertPrivate(final, directory: false);
        var nested = Path.Combine(root, "nested");
        await store.EnsureLocalAsync(uri, nested);
        AssertPrivate(nested, directory: true);
        var privateSource = Path.Combine(outside, "invented-private-source.wav");
        File.WriteAllText(privateSource, "invented-private-source-content");
        var before = Directory.GetFiles(root).Length;
        File.SetLastAccessTimeUtc(privateSource, DateTime.UtcNow.AddDays(-2));
        var lastAccess = File.GetLastAccessTimeUtc(privateSource);
        await Rejects(() => store.EnsureLocalAsync(privateSource, root), scratch);
        await Rejects(() => store.EnsureLocalAsync(new Uri(privateSource).AbsoluteUri, root), scratch);
        Require(File.GetLastAccessTimeUtc(privateSource) == lastAccess, "An outside source was opened");
        Require(Directory.GetFiles(root).Length == before, "An outside source was copied");
        var sourceLink = Path.Combine(root, "source-link.wav");
        File.CreateSymbolicLink(sourceLink, privateSource);
        await Rejects(() => store.EnsureLocalAsync(sourceLink, root), scratch);
        File.Delete(sourceLink);
        HardLink(privateSource, sourceLink);
        await Rejects(() => store.EnsureLocalAsync(sourceLink, root), scratch);
        File.Delete(sourceLink);
        File.Delete(final);
        File.CreateSymbolicLink(final, privateSource);
        await Rejects(() => store.EnsureLocalAsync(uri, root), scratch);
        Require(new FileInfo(final).LinkTarget is not null, "A symlink destination was replaced");
        File.Delete(final);
        HardLink(privateSource, final);
        await Rejects(() => store.EnsureLocalAsync(uri, root), scratch);
        Require(File.ReadAllText(privateSource) == "invented-private-source-content", "A linked target was modified");
        File.Delete(final);
        var insideSource = Path.Combine(root, "client.wav");
        File.WriteAllText(insideSource, "RIFF client fixture");
        var copied = await store.EnsureLocalAsync(insideSource, root);
        Require(File.ReadAllText(copied) == "RIFF client fixture", "Contained local audio stopped working");
        await TestTransfers(scratch);
        await TestRetention(scratch);
        await TestConfig(scratch);
        Console.WriteLine("PASS: real artifact containment, links, modes, bounded atomic transfers, retention and read-only config checks");
    }

    private static async Task TestTransfers(string scratch)
    {
        var root = Path.Combine(scratch, "transfers");
        var options = Options(root);
        var response = new Func<HttpResponseMessage>(() => Response(new ByteArrayContent("12345678"u8.ToArray())));
        using var client = new HttpClient(new FixtureHandler(() => response()));
        using var store = new AudioArtifactStore(client, options, NullLogger<AudioArtifactStore>.Instance,
            limits: new RelayArtifactLimits { MaximumBytes = 8, TransferTimeout = TimeSpan.FromMilliseconds(200) });
        const string uri = "http://127.0.0.1:1/invented-private-transfer.wav?token=invented-private-token";
        var final = await store.EnsureLocalAsync(uri, root);
        response = () => Response(new ByteArrayContent("123456789"u8.ToArray()));
        await Rejects(() => store.EnsureLocalAsync(uri, root), scratch);
        response = () => Response(new StreamContent(new UnknownLengthStream("123456789"u8.ToArray())));
        await Rejects(() => store.EnsureLocalAsync(uri, root), scratch);
        response = () => Response(new StreamContent(new FailingStream()));
        await Rejects(() => store.EnsureLocalAsync(uri, root), scratch);
        Require(File.ReadAllText(final) == "12345678", "A failed transfer replaced valid audio");
        Require(!Directory.GetFiles(root, "*.partial").Any(), "Failed transfers left partial artifacts");
        var stalled = new GatedStream();
        response = () => Response(new StreamContent(stalled));
        var transfer = store.EnsureLocalAsync(uri, root);
        await stalled.Waiting.Task;
        Require(File.ReadAllText(final) == "12345678", "An incomplete transfer became visible");
        var partial = Directory.GetFiles(root, "*.partial").Single();
        AssertPrivate(partial, directory: false);
        stalled.Complete.TrySetResult();
        await transfer;
        Require(File.ReadAllText(final) == "abcdefgh", "Completed transfer was not atomically finalized");
        response = () => Response(new StreamContent(new StalledStream()));
        var started = Stopwatch.StartNew();
        await Rejects(() => store.EnsureLocalAsync(uri, root), scratch);
        Require(started.Elapsed < TimeSpan.FromSeconds(2), "Transfer deadline did not bound the stalled body");
        Require(File.ReadAllText(final) == "abcdefgh", "Timed-out transfer replaced valid audio");
        Require(!Directory.GetFiles(root, "*.partial").Any(), "Timed-out transfer left a partial artifact");
        if (OperatingSystem.IsLinux())
        {
            var racing = new GatedStream();
            response = () => Response(new StreamContent(racing));
            var changedRoot = store.EnsureLocalAsync(uri, root);
            await racing.Waiting.Task;
            var moved = root + "-moved";
            var outside = root + "-outside";
            Directory.CreateDirectory(outside);
            Directory.Move(root, moved);
            Directory.CreateSymbolicLink(root, outside);
            racing.Complete.TrySetResult();
            await Rejects(() => changedRoot, scratch);
            Require(!Directory.EnumerateFileSystemEntries(outside).Any(), "A directory swap redirected a write");
            Require(!Directory.GetFiles(moved, "*.partial").Any(), "A directory swap stranded a temporary artifact");
        }
    }

    private static async Task TestRetention(string scratch)
    {
        var root = Path.Combine(scratch, "retention");
        using var client = new HttpClient(new FixtureHandler());
        using var store = new AudioArtifactStore(client, Options(root), NullLogger<AudioArtifactStore>.Instance);
        var expired = await store.EnsureLocalAsync("http://127.0.0.1:1/expired.wav", root);
        var fresh = await store.EnsureLocalAsync("http://127.0.0.1:1/fresh.wav", root);
        var nested = await store.EnsureLocalAsync("http://127.0.0.1:1/nested.wav", Path.Combine(root, "nested"));
        File.SetLastWriteTimeUtc(expired, DateTime.UtcNow.AddHours(-25));
        File.SetLastWriteTimeUtc(nested, DateTime.UtcNow.AddHours(-25));
        var temporary = Path.Combine(root, "psfn_" + new string('a', 32) + ".partial");
        File.WriteAllText(temporary, "incomplete fixture");
        File.SetLastWriteTimeUtc(temporary, DateTime.UtcNow.AddHours(-25));
        var unmanaged = Path.Combine(root, "client.wav");
        File.WriteAllText(unmanaged, "client owned");
        File.SetLastWriteTimeUtc(unmanaged, DateTime.UtcNow.AddDays(-2));
        var outside = Path.Combine(scratch, "retention-outside.wav");
        File.WriteAllText(outside, "outside owned");
        File.SetLastWriteTimeUtc(outside, DateTime.UtcNow.AddDays(-2));
        var symlink = Path.Combine(root, "psfn_" + new string('b', 24) + ".wav");
        var hardlink = Path.Combine(root, "psfn_" + new string('c', 24) + ".wav");
        File.CreateSymbolicLink(symlink, outside);
        HardLink(outside, hardlink);
        store.SweepExpired();
        AssertPrivate(fresh, directory: false);
        Require(!File.Exists(expired) && !File.Exists(nested) && !File.Exists(temporary), "Expired relay artifacts survived retention");
        Require(File.Exists(fresh) && File.Exists(unmanaged), "Retention removed fresh or unmanaged files");
        Require(File.Exists(outside) && File.Exists(hardlink) && new FileInfo(symlink).LinkTarget is not null,
            "Retention followed or deleted an unsafe link");
    }

    private static async Task TestConfig(string scratch)
    {
        var config = Path.Combine(scratch, "invented-private-config.json");
        File.WriteAllText(config, "{\"Remote\":\"http://example.test\"}");
        var attributes = File.GetAttributes(config);
        var modified = File.GetLastWriteTimeUtc(config);
        var mode = OperatingSystem.IsWindows() ? default : File.GetUnixFileMode(config);
        Require(RelayFileConfig.Load(config).Remote == "http://example.test", "Valid config stopped loading");
        Require(File.GetAttributes(config) == attributes && File.GetLastWriteTimeUtc(config) == modified,
            "Configuration inspection modified operator state");
        if (!OperatingSystem.IsWindows()) Require(File.GetUnixFileMode(config) == mode, "Configuration permissions were modified");
        var link = Path.Combine(scratch, "config-link.json");
        File.CreateSymbolicLink(link, config);
        await Rejects(() => Task.FromResult(RelayFileConfig.Load(link)), scratch);
        File.Delete(link);
        HardLink(config, link);
        await Rejects(() => Task.FromResult(RelayFileConfig.Load(link)), scratch);
        File.Delete(link);
        File.WriteAllText(config, new string(' ', 1024 * 1024 + 1));
        await Rejects(() => Task.FromResult(RelayFileConfig.Load(config)), scratch);
    }

    private static RelayOptions Options(string root) => new("http://127.0.0.1:8789", new Uri("http://127.0.0.1:1/hub"),
        new Uri("http://127.0.0.1:1"), root, null);
    private static HttpResponseMessage Response(HttpContent content) => new(HttpStatusCode.OK) { Content = content };
    private static async Task Rejects(Func<Task> action, string scratch)
    {
        try { await action(); }
        catch (IOException error)
        {
            Require(!error.ToString().Contains("invented-private") && !error.ToString().Contains(scratch)
                && !error.Message.Any(char.IsControl), "Artifact error exposed private data or controls");
            return;
        }
        throw new InvalidOperationException("Unsafe artifact operation was accepted");
    }

    private static void AssertPrivate(string path, bool directory)
    {
        if (OperatingSystem.IsWindows())
        {
            var security = directory ? (FileSystemSecurity)new DirectoryInfo(path).GetAccessControl()
                : new FileInfo(path).GetAccessControl();
            using var identity = WindowsIdentity.GetCurrent();
            Require(security.AreAccessRulesProtected, "Artifact DACL inherited access");
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                Require(rule.AccessControlType != AccessControlType.Allow || rule.IdentityReference == identity.User,
                    "Artifact ACL grants another identity access");
        }
        else
        {
            var expected = UnixFileMode.UserRead | UnixFileMode.UserWrite | (directory ? UnixFileMode.UserExecute : 0);
            Require(File.GetUnixFileMode(path) == expected, "Artifact permissions are not 0700/0600");
        }
    }

    private static void HardLink(string existing, string link)
    {
        var created = OperatingSystem.IsWindows() ? CreateHardLink(link, existing, IntPtr.Zero) : Link(existing, link) == 0;
        Require(created, "Hardlink regression fixture could not be created");
    }
    [DllImport("libc", EntryPoint = "link", SetLastError = true)] private static extern int Link(string existing, string link);
    [DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateHardLink(string link, string existing, IntPtr security);

    private static void Require(bool condition, string failure)
    {
        if (!condition) throw new InvalidOperationException(failure);
    }

    private sealed class FixtureHandler(Func<HttpResponseMessage>? response = null) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return Task.FromResult(response?.Invoke() ?? Response(new ByteArrayContent("RIFF invented audio fixture"u8.ToArray())));
        }
    }

    private sealed class UnknownLengthStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override bool CanSeek => false;
    }

    private sealed class FailingStream : MemoryStream
    {
        private bool _read;
        public override bool CanSeek => false;
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_read) throw new IOException("invented-private-exception\r\n\t\u001b[31m");
            _read = true;
            "1234"u8.CopyTo(buffer.Span);
            return ValueTask.FromResult(4);
        }
    }

    private sealed class GatedStream : MemoryStream
    {
        private bool _read;
        public override bool CanSeek => false;
        public TaskCompletionSource Waiting { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Complete { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (!_read) { _read = true; "abcdefgh"u8.CopyTo(buffer.Span); return 8; }
            Waiting.TrySetResult();
            await Complete.Task.WaitAsync(cancellationToken);
            return 0;
        }
    }

    private sealed class StalledStream : MemoryStream
    {
        public override bool CanSeek => false;
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
    }
}
