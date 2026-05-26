using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using NAudio.Wave;

var builder = WebApplication.CreateBuilder(args);
var options = RelayOptions.FromEnvironment();

builder.WebHost.UseUrls(options.ListenUrl);
builder.Services.AddSignalR(options =>
{
    options.MaximumReceiveMessageSize = 1024 * 1024 * 32;
});
builder.Services.AddSingleton(options);
builder.Services.AddSingleton(new HttpClient());
builder.Services.AddSingleton<RelaySessionRegistry>();
builder.Services.AddSingleton<AudioArtifactStore>();
builder.Services.AddSingleton<RemoteApiProxy>();

var app = builder.Build();

app.MapHub<VoxtaRelayHub>("/hub", signalr =>
{
    signalr.Transports = HttpTransportType.WebSockets;
});

app.Map("/{**path}", async (
    HttpContext context,
    RemoteApiProxy proxy,
    RelayOptions relayOptions,
    ILoggerFactory loggerFactory) =>
{
    if (context.Request.Path.StartsWithSegments("/api"))
    {
        await proxy.ProxyAsync(context);
        return;
    }

    loggerFactory.CreateLogger("Relay").LogInformation(
        "PSFN Voxta relay running. Local={LocalUrl} RemoteHub={RemoteHubUrl}",
        relayOptions.ListenUrl,
        relayOptions.RemoteHubUrl);
    context.Response.ContentType = "text/plain";
    await context.Response.WriteAsync("psfn-voxta-relay\n");
});

app.Logger.LogInformation(
    "PSFN Voxta relay starting. Local={LocalUrl} RemoteHub={RemoteHubUrl} RemoteApi={RemoteApiBaseUrl}",
    options.ListenUrl,
    options.RemoteHubUrl,
    options.RemoteApiBaseUrl);
app.Logger.LogInformation("Audio fallback folder: {AudioFolder}", options.FallbackAudioFolder);

await app.RunAsync();

public sealed class VoxtaRelayHub(
    RelaySessionRegistry sessions,
    RelayOptions options,
    AudioArtifactStore audioStore,
    ILogger<VoxtaRelayHub> logger) : Hub
{
    public override async Task OnConnectedAsync()
    {
        var session = new BridgeSession(
            Context.ConnectionId,
            Clients.Client(Context.ConnectionId),
            options,
            audioStore,
            logger);
        sessions.Add(Context.ConnectionId, session);
        await session.ConnectAsync(Context.ConnectionAborted);
        logger.LogInformation("Registered VaM client {ConnectionId}", Context.ConnectionId);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (sessions.Remove(Context.ConnectionId, out var session))
        {
            await session.DisposeAsync();
        }
        logger.LogInformation("Unregistered VaM client {ConnectionId}", Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    public async Task SendMessage(JsonElement message)
    {
        if (!sessions.TryGet(Context.ConnectionId, out var session))
        {
            throw new HubException("Relay session is not registered");
        }
        await session.SendLocalMessageAsync(message, Context.ConnectionAborted);
    }
}

public sealed class BridgeSession : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly string _localConnectionId;
    private readonly ISingleClientProxy _localClient;
    private readonly RelayOptions _options;
    private readonly AudioArtifactStore _audioStore;
    private readonly ILogger _logger;
    private readonly HubConnection _remote;
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    private MicrophoneStream? _microphone;
    private string? _audioFolder;

    public BridgeSession(
        string localConnectionId,
        ISingleClientProxy localClient,
        RelayOptions options,
        AudioArtifactStore audioStore,
        ILogger logger)
    {
        _localConnectionId = localConnectionId;
        _localClient = localClient;
        _options = options;
        _audioStore = audioStore;
        _logger = logger;
        _remote = new HubConnectionBuilder()
            .WithUrl(options.RemoteHubUrl, connection =>
            {
                if (!string.IsNullOrWhiteSpace(options.RemoteBearerToken))
                {
                    connection.AccessTokenProvider = () => Task.FromResult<string?>(options.RemoteBearerToken);
                }
            })
            .WithAutomaticReconnect()
            .Build();
        _remote.On<JsonElement>("ReceiveMessage", message => ReceiveRemoteMessageAsync(message));
    }

    public async Task ConnectAsync(CancellationToken cancellationToken)
    {
        await _remote.StartAsync(cancellationToken);
        _logger.LogInformation(
            "Session {ConnectionId} connected to remote {RemoteHubUrl}",
            _localConnectionId,
            _options.RemoteHubUrl);
    }

    public async Task SendLocalMessageAsync(JsonElement message, CancellationToken cancellationToken)
    {
        var node = CloneObject(message);
        var type = ReadType(node);
        if (string.Equals(type, "authenticate", StringComparison.OrdinalIgnoreCase))
        {
            RewriteAuthenticate(node);
        }

        await _sendLock.WaitAsync(cancellationToken);
        try
        {
            await _remote.InvokeAsync("SendMessage", node, cancellationToken);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_microphone is not null)
        {
            await _microphone.DisposeAsync();
            _microphone = null;
        }
        await _remote.DisposeAsync();
        _sendLock.Dispose();
    }

    private async Task ReceiveRemoteMessageAsync(JsonElement message)
    {
        var node = CloneObject(message);
        var type = ReadType(node);

        if (string.Equals(type, "recordingRequest", StringComparison.OrdinalIgnoreCase))
        {
            await HandleRecordingRequestAsync(node);
            return;
        }

        await RewriteAudioFieldAsync(node, "audioUrl");
        await RewriteAudioFieldAsync(node, "thinkingSpeechUrl");

        await _localClient.SendAsync("ReceiveMessage", node);
    }

    private void RewriteAuthenticate(JsonObject message)
    {
        var capabilities = message["capabilities"] as JsonObject;
        var audioFolder = ReadString(capabilities?["audioFolder"]) ?? ReadString(message["audioFolder"]);
        if (!string.IsNullOrWhiteSpace(audioFolder))
        {
            _audioFolder = audioFolder;
            Directory.CreateDirectory(_audioFolder);
            _logger.LogInformation(
                "Session {ConnectionId} audio folder updated to {AudioFolder}",
                _localConnectionId,
                _audioFolder);
        }

        capabilities ??= new JsonObject();
        message["capabilities"] = capabilities;
        capabilities["audioInput"] = "WebSocketStream";
        capabilities["audioOutput"] = "Url";
        if (_audioFolder is not null)
        {
            capabilities["audioFolder"] = _audioFolder;
        }
        capabilities["acceptedAudioContentTypes"] ??= new JsonArray("audio/x-wav");
    }

    private async Task RewriteAudioFieldAsync(JsonObject message, string fieldName)
    {
        var audioUrl = ReadString(message[fieldName]);
        if (string.IsNullOrWhiteSpace(audioUrl) || audioUrl.StartsWith("silence:", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var localAudioFolder = _audioFolder ?? _options.FallbackAudioFolder;
        try
        {
            message[fieldName] = await _audioStore.EnsureLocalAsync(audioUrl, localAudioFolder);
        }
        catch (Exception error)
        {
            _logger.LogError(error, "Failed to localize {FieldName} {AudioUrl}", fieldName, audioUrl);
        }
    }

    private async Task HandleRecordingRequestAsync(JsonObject message)
    {
        var enabled = ReadBoolean(message["enabled"]);
        if (!enabled)
        {
            if (_microphone is not null)
            {
                await _microphone.DisposeAsync();
                _microphone = null;
            }
            return;
        }

        var sessionId = ReadString(message["sessionId"]);
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            _logger.LogWarning("Ignoring recordingRequest without sessionId");
            return;
        }

        if (_microphone is not null)
        {
            await _microphone.DisposeAsync();
        }
        _microphone = new MicrophoneStream(_options, sessionId, _logger);
        await _microphone.StartAsync();
    }

    private static JsonObject CloneObject(JsonElement element)
    {
        return JsonNode.Parse(element.GetRawText(), documentOptions: default, nodeOptions: default) as JsonObject
            ?? throw new HubException("Voxta message must be a JSON object");
    }

    private static string? ReadType(JsonObject node)
    {
        return ReadString(node["$type"]);
    }

    private static string? ReadString(JsonNode? node)
    {
        return node?.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : null;
    }

    private static bool ReadBoolean(JsonNode? node)
    {
        return node?.GetValueKind() == JsonValueKind.True
            || (node?.GetValueKind() == JsonValueKind.String
                && bool.TryParse(node.GetValue<string>(), out var value)
                && value);
    }
}

public sealed class AudioArtifactStore(HttpClient httpClient, ILogger<AudioArtifactStore> logger)
{
    public async Task<string> EnsureLocalAsync(string audioUrl, string audioFolder)
    {
        Directory.CreateDirectory(audioFolder);

        if (Uri.TryCreate(audioUrl, UriKind.Absolute, out var uri))
        {
            if (uri.Scheme is "http" or "https")
            {
                return await DownloadAsync(uri, audioFolder);
            }
            if (uri.Scheme == "file")
            {
                return await CopyLocalAsync(uri.LocalPath, audioFolder);
            }
        }

        if (File.Exists(audioUrl))
        {
            return await CopyLocalAsync(audioUrl, audioFolder);
        }

        throw new FileNotFoundException("Audio URL is not a reachable HTTP/file/local path", audioUrl);
    }

    private async Task<string> DownloadAsync(Uri uri, string audioFolder)
    {
        using var response = await httpClient.GetAsync(uri);
        response.EnsureSuccessStatusCode();
        var extension = InferExtension(uri, response.Content.Headers.ContentType);
        var localPath = Path.Combine(audioFolder, $"psfn_{Hash(uri.ToString())}{extension}");
        await using var output = File.Create(localPath);
        await response.Content.CopyToAsync(output);
        logger.LogInformation("Downloaded remote audio {AudioUrl} -> {LocalPath}", uri, localPath);
        return localPath;
    }

    private static async Task<string> CopyLocalAsync(string sourcePath, string audioFolder)
    {
        var extension = Path.GetExtension(sourcePath);
        if (string.IsNullOrWhiteSpace(extension))
        {
            extension = ".wav";
        }
        var localPath = Path.Combine(audioFolder, $"psfn_{Hash(Path.GetFullPath(sourcePath))}{extension}");
        if (!Path.GetFullPath(sourcePath).Equals(Path.GetFullPath(localPath), StringComparison.OrdinalIgnoreCase))
        {
            await using var input = File.OpenRead(sourcePath);
            await using var output = File.Create(localPath);
            await input.CopyToAsync(output);
        }
        return localPath;
    }

    private static string InferExtension(Uri uri, MediaTypeHeaderValue? contentType)
    {
        var extension = Path.GetExtension(uri.LocalPath);
        if (!string.IsNullOrWhiteSpace(extension))
        {
            return extension;
        }
        return contentType?.MediaType?.ToLowerInvariant() switch
        {
            "audio/wav" or "audio/x-wav" or "audio/wave" => ".wav",
            "audio/mpeg" or "audio/mp3" => ".mp3",
            _ => ".wav",
        };
    }

    private static string Hash(string value)
    {
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..24].ToLowerInvariant();
    }
}

public sealed class MicrophoneStream : IAsyncDisposable
{
    private readonly RelayOptions _options;
    private readonly string _sessionId;
    private readonly ILogger _logger;
    private readonly ClientWebSocket _socket = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private WaveInEvent? _waveIn;
    private bool _disposed;

    public MicrophoneStream(RelayOptions options, string sessionId, ILogger logger)
    {
        _options = options;
        _sessionId = sessionId;
        _logger = logger;
    }

    public async Task StartAsync()
    {
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogWarning("Microphone streaming requires Windows; recordingRequest ignored on this platform");
            return;
        }

        var wsUrl = BuildAudioStreamUrl(_options.RemoteApiBaseUrl, _sessionId);
        await _socket.ConnectAsync(wsUrl, CancellationToken.None);
        await SendJsonAsync(new
        {
            sampleRate = 16000,
            channels = 1,
            bufferMilliseconds = 30,
            bitsPerSample = 16,
            contentType = "audio/wav",
        });

        _waveIn = new WaveInEvent
        {
            WaveFormat = new WaveFormat(16000, 16, 1),
            BufferMilliseconds = 30,
        };
        _waveIn.DataAvailable += (_, args) => _ = SendAudioAsync(args.Buffer.AsMemory(0, args.BytesRecorded));
        _waveIn.RecordingStopped += (_, args) =>
        {
            if (args.Exception is not null)
            {
                _logger.LogError(args.Exception, "Microphone recording stopped with error");
            }
        };
        _waveIn.StartRecording();
        _logger.LogInformation("Audio websocket opened for session {SessionId}: {Url}", _sessionId, wsUrl);
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        _waveIn?.StopRecording();
        _waveIn?.Dispose();
        _sendLock.Dispose();
        if (_socket.State == WebSocketState.Open)
        {
            await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "recording stopped", CancellationToken.None);
        }
        _socket.Dispose();
    }

    private async Task SendJsonAsync(object payload)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        await _socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
    }

    private async Task SendAudioAsync(ReadOnlyMemory<byte> pcm)
    {
        if (_disposed || _socket.State != WebSocketState.Open)
        {
            return;
        }
        await _sendLock.WaitAsync();
        try
        {
            if (!_disposed && _socket.State == WebSocketState.Open)
            {
                await _socket.SendAsync(pcm, WebSocketMessageType.Binary, true, CancellationToken.None);
            }
        }
        catch (Exception error)
        {
            _logger.LogWarning(error, "Audio websocket send failed");
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private static Uri BuildAudioStreamUrl(Uri remoteApiBaseUrl, string sessionId)
    {
        var builder = new UriBuilder(remoteApiBaseUrl)
        {
            Scheme = remoteApiBaseUrl.Scheme == "https" ? "wss" : "ws",
            Path = JoinPath(remoteApiBaseUrl.AbsolutePath, "/ws/audio/input/stream"),
            Query = $"sessionId={WebUtility.UrlEncode(sessionId)}",
        };
        return builder.Uri;
    }

    private static string JoinPath(string basePath, string path)
    {
        var normalizedBase = basePath == "/" ? "" : basePath.TrimEnd('/');
        return $"{normalizedBase}/{path.TrimStart('/')}";
    }
}

public sealed class RemoteApiProxy(HttpClient httpClient, RelayOptions options)
{
    private static readonly HashSet<string> HopByHopHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
    };

    public async Task ProxyAsync(HttpContext context)
    {
        var target = BuildTargetUri(context.Request);
        using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), target);
        foreach (var header in context.Request.Headers)
        {
            if (HopByHopHeaders.Contains(header.Key))
            {
                continue;
            }
            request.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
        }
        if (context.Request.ContentLength > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding"))
        {
            request.Content = new StreamContent(context.Request.Body);
            foreach (var header in context.Request.Headers)
            {
                if (!HopByHopHeaders.Contains(header.Key))
                {
                    request.Content.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
                }
            }
        }

        using var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, context.RequestAborted);
        context.Response.StatusCode = (int)response.StatusCode;
        foreach (var header in response.Headers)
        {
            if (!HopByHopHeaders.Contains(header.Key))
            {
                context.Response.Headers[header.Key] = header.Value.ToArray();
            }
        }
        foreach (var header in response.Content.Headers)
        {
            if (!HopByHopHeaders.Contains(header.Key))
            {
                context.Response.Headers[header.Key] = header.Value.ToArray();
            }
        }
        await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
    }

    private Uri BuildTargetUri(HttpRequest request)
    {
        var builder = new UriBuilder(options.RemoteApiBaseUrl)
        {
            Path = JoinPath(options.RemoteApiBaseUrl.AbsolutePath, request.Path.Value ?? "/"),
            Query = request.QueryString.HasValue ? request.QueryString.Value!.TrimStart('?') : "",
        };
        return builder.Uri;
    }

    private static string JoinPath(string basePath, string path)
    {
        var normalizedBase = basePath == "/" ? "" : basePath.TrimEnd('/');
        return $"{normalizedBase}/{path.TrimStart('/')}";
    }
}

public sealed class RelaySessionRegistry
{
    private readonly ConcurrentDictionary<string, BridgeSession> _sessions = new();

    public void Add(string connectionId, BridgeSession session)
    {
        _sessions[connectionId] = session;
    }

    public bool TryGet(string connectionId, out BridgeSession session)
    {
        return _sessions.TryGetValue(connectionId, out session!);
    }

    public bool Remove(string connectionId, out BridgeSession session)
    {
        return _sessions.TryRemove(connectionId, out session!);
    }
}

public sealed record RelayOptions(
    string ListenUrl,
    Uri RemoteHubUrl,
    Uri RemoteApiBaseUrl,
    string FallbackAudioFolder,
    string? RemoteBearerToken)
{
    public static RelayOptions FromEnvironment()
    {
        var listenUrl = Read("PSFN_VOXTA_RELAY_LISTEN_URL", "http://127.0.0.1:8789");
        var remoteHubUrl = new Uri(Read("PSFN_VOXTA_RELAY_REMOTE_HUB_URL", "http://purrsephone.local.vega.nyc:8789/hub"));
        var remoteApiBaseUrl = new Uri(
            Environment.GetEnvironmentVariable("PSFN_VOXTA_RELAY_REMOTE_API_BASE_URL")
            ?? InferApiBaseUrl(remoteHubUrl).ToString());
        var fallbackAudioFolder = Read(
            "PSFN_VOXTA_RELAY_AUDIO_FOLDER",
            Path.Combine(Path.GetTempPath(), "psfn-voxta-relay-audio"));
        var token = Environment.GetEnvironmentVariable("PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN");
        return new RelayOptions(listenUrl, remoteHubUrl, remoteApiBaseUrl, fallbackAudioFolder, token);
    }

    private static string Read(string name, string fallback)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }

    private static Uri InferApiBaseUrl(Uri remoteHubUrl)
    {
        var builder = new UriBuilder(remoteHubUrl)
        {
            Path = "",
            Query = "",
            Fragment = "",
        };
        return builder.Uri;
    }
}
