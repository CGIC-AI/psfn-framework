using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;

var sentinels = new[]
{
    "invented-private-transcript-86e4", "invented-private-reply-4b13",
    "https://example.test/invented-private-filename.wav?token=invented-private-credential",
    "/tmp/invented-private-local-path", "invented-private-session-9d28",
    "invented-private-connection-127a", "invented-private-exception-91ac\r\n\t\u001b[31m",
};
var hostile = string.Join(" ", sentinels);
var stdout = new StringWriter();
var stderr = new StringWriter();
var originalOut = Console.Out;
var originalError = Console.Error;
var formatterCalled = false;
var correlation = Guid.Parse("684c180a-3056-4e9a-801a-27a2110e3139");
try
{
    Console.SetOut(stdout);
    Console.SetError(stderr);
    using var logs = LoggerFactory.Create(builder =>
    {
        builder.SetMinimumLevel(LogLevel.Trace);
        RelayLogging.Configure(builder);
    });
    var logger = logs.CreateLogger(hostile);
    using var scope = logger.BeginScope(new Dictionary<string, object> { [hostile] = hostile });
    foreach (var relayEvent in Enum.GetValues<RelayEvent>())
    {
        RelayLogging.Write(logger, relayEvent, correlation, bytes: 23, status: 502, elapsedMs: 3.5);
    }
    // Forged event IDs, categories, scope values, structured fields, exception
    // messages and formatters must never reach even a non-console transport.
    foreach (var level in Enum.GetValues<LogLevel>().Where(level => level != LogLevel.None))
    {
        logger.Log(level, new EventId((int)RelayEvent.Starting, hostile),
            hostile, new IOException(hostile), (_, _) =>
            {
                formatterCalled = true;
                return hostile;
            });
        logger.LogError(new IOException(hostile),
            "Session {SessionId} connection {ConnectionId} audio {AudioUrl} path {LocalPath}",
            sentinels[4], sentinels[5], sentinels[2], sentinels[3]);
    }
    var options = new RelayOptions("http://127.0.0.1:8789",
        new Uri("http://127.0.0.1:1/hub"), new Uri("http://127.0.0.1:1"), sentinels[3], sentinels[4]);
    var hub = new VoxtaRelayHub(new RelaySessionRegistry(), options,
        new AudioArtifactStore(new HttpClient(), options, logs.CreateLogger<AudioArtifactStore>()),
        logs.CreateLogger<VoxtaRelayHub>())
    {
        Context = new PrivateCallerContext(sentinels[5]),
    };
    await hub.OnDisconnectedAsync(new IOException(hostile));
}
finally
{
    Console.SetOut(originalOut);
    Console.SetError(originalError);
}

var output = stdout.ToString() + stderr.ToString();
Require(!formatterCalled, "An untrusted formatter was invoked");
foreach (var sentinel in sentinels) Require(!output.Contains(sentinel), "Private data crossed a log sink");
Require(!output.Any(ch => char.IsControl(ch) && ch != '\n'), "Raw control characters crossed a log sink");
var entries = output.Split('\n', StringSplitOptions.RemoveEmptyEntries)
    .Select(line => JsonDocument.Parse(line).RootElement.Clone()).ToArray();
Require(entries.Length == Enum.GetValues<RelayEvent>().Length + 1, "Untyped log entries were not discarded");
var expectedFields = new HashSet<string> { "timestamp", "level", "event", "correlation", "bytes", "status", "elapsedMs" };
foreach (var entry in entries)
{
    Require(entry.EnumerateObject().All(field => expectedFields.Contains(field.Name)), "Unexpected log field");
    Require(entry.GetProperty("event").GetString() is { Length: > 0 }, "Operational event was lost");
}
var download = entries.Single(entry => entry.GetProperty("event").GetString() == "audio.downloaded");
Require(download.GetProperty("bytes").GetInt64() == 23, "Audio byte count was lost");
Require(download.GetProperty("correlation").GetString() == correlation.ToString("N"), "Safe correlation was lost");
Require(stderr.ToString().Contains("audio.localization_failed"), "Errors did not reach stderr");
Console.WriteLine("PASS: actual relay logger rejects private fields, exceptions, scopes and formatters before its sinks");
await ArtifactTests.RunAsync();
await MicrophoneTests.RunAsync();

static void Require(bool condition, string failure)
{
    if (!condition) throw new InvalidOperationException(failure);
}

sealed class PrivateCallerContext(string connectionId) : HubCallerContext
{
    public override string ConnectionId => connectionId;
    public override string? UserIdentifier => null;
    public override ClaimsPrincipal? User => null;
    public override IDictionary<object, object?> Items { get; } = new Dictionary<object, object?>();
    public override IFeatureCollection Features { get; } = new FeatureCollection();
    public override CancellationToken ConnectionAborted => CancellationToken.None;
    public override void Abort() { }
}
