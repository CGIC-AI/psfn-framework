using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Logging;

return await RelayApplication.RunAsync(args);

public sealed class VoxtaRelayHub(
    RelaySessionRegistry sessions,
    RelayOptions options,
    AudioArtifactStore audioStore,
    ILogger<VoxtaRelayHub> logger) : Hub
{
    public override async Task OnConnectedAsync()
    {
        var session = new BridgeSession(
            Clients.Client(Context.ConnectionId),
            options,
            audioStore,
            logger);
        sessions.Add(Context.ConnectionId, session);
        try
        {
            await session.ConnectAsync(Context.ConnectionAborted);
        }
        catch (Exception)
        {
            RelayLogging.Write(logger, RelayEvent.SessionConnectionFailed, session.CorrelationId);
            throw;
        }
        RelayLogging.Write(logger, RelayEvent.ClientRegistered, session.CorrelationId);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (sessions.Remove(Context.ConnectionId, out var session))
        {
            await session.DisposeAsync();
        }
        RelayLogging.Write(logger, RelayEvent.ClientUnregistered, session?.CorrelationId);
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

    private readonly ISingleClientProxy _localClient;
    private readonly RelayOptions _options;
    private readonly AudioArtifactStore _audioStore;
    private readonly ILogger _logger;
    private readonly HubConnection _remote;
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    private MicrophoneStream? _microphone;
    private string? _audioFolder;

    public Guid CorrelationId { get; } = Guid.NewGuid();

    public BridgeSession(
        ISingleClientProxy localClient,
        RelayOptions options,
        AudioArtifactStore audioStore,
        ILogger logger)
    {
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
        _remote.ServerTimeout = TimeSpan.FromMinutes(5);
        _remote.KeepAliveInterval = TimeSpan.FromSeconds(15);
        _remote.On<JsonElement>("ReceiveMessage", message => ReceiveRemoteMessageAsync(message));
    }

    public async Task ConnectAsync(CancellationToken cancellationToken)
    {
        await _remote.StartAsync(cancellationToken);
        RelayLogging.Write(_logger, RelayEvent.SessionConnected, CorrelationId);
    }

    public async Task SendLocalMessageAsync(JsonElement message, CancellationToken cancellationToken)
    {
        var node = CloneObject(message);
        var type = ReadType(node);
        if (string.Equals(type, "authenticate", StringComparison.OrdinalIgnoreCase))
        {
            RewriteAuthenticate(node);
        }
        SanitizeLatin1Strings(node);

        await _sendLock.WaitAsync(cancellationToken);
        try
        {
            await _remote.SendAsync("SendMessage", node, cancellationToken);
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
        SanitizeLatin1Strings(node);

        await _localClient.SendAsync("ReceiveMessage", node);
    }

    private void RewriteAuthenticate(JsonObject message)
    {
        var capabilities = message["capabilities"] as JsonObject;
        var audioFolder = ReadString(capabilities?["audioFolder"]) ?? ReadString(message["audioFolder"]);
        if (!string.IsNullOrWhiteSpace(audioFolder))
        {
            _audioFolder = _audioStore.ApproveAudioFolder(audioFolder);
            RelayLogging.Write(_logger, RelayEvent.AudioFolderUpdated, CorrelationId);
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
        catch (Exception)
        {
            message.Remove(fieldName);
            RelayLogging.Write(_logger, RelayEvent.AudioLocalizationFailed, CorrelationId);
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
            RelayLogging.Write(_logger, RelayEvent.RecordingSessionMissing, CorrelationId);
            return;
        }

        if (_microphone is not null)
        {
            await _microphone.DisposeAsync();
        }
        _microphone = new MicrophoneStream(_options, sessionId, _logger, CorrelationId);
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

    private static void SanitizeLatin1Strings(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var property in obj.ToArray())
                {
                    if (property.Value?.GetValueKind() == JsonValueKind.String)
                    {
                        obj[property.Key] = SanitizeLatin1Text(property.Value.GetValue<string>());
                    }
                    else
                    {
                        SanitizeLatin1Strings(property.Value);
                    }
                }
                break;
            case JsonArray array:
                for (var index = 0; index < array.Count; index += 1)
                {
                    var item = array[index];
                    if (item?.GetValueKind() == JsonValueKind.String)
                    {
                        array[index] = SanitizeLatin1Text(item.GetValue<string>());
                    }
                    else
                    {
                        SanitizeLatin1Strings(item);
                    }
                }
                break;
        }
    }

    private static string SanitizeLatin1Text(string input)
    {
        var output = new StringBuilder(input.Length);
        foreach (var ch in input)
        {
            switch (ch)
            {
                case '\u2018':
                case '\u2019':
                case '\u201A':
                case '\u201B':
                    output.Append('\'');
                    break;
                case '\u201C':
                case '\u201D':
                case '\u201E':
                case '\u201F':
                    output.Append('"');
                    break;
                case '\u2013':
                case '\u2014':
                case '\u2015':
                case '\u2212':
                    output.Append('-');
                    break;
                case '\u2026':
                    output.Append("...");
                    break;
                case '\u00A0':
                    output.Append(' ');
                    break;
                default:
                    output.Append(ch <= '\u00ff' ? ch : '?');
                    break;
            }
        }
        return output.ToString();
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

        RelayAccess.Authenticate(request, options);
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
    public const string Usage = """
        PSFN Voxta Relay

        Usage:
          PsfnVoxtaRelay.exe
          PsfnVoxtaRelay.exe --config .\appsettings.json
          PsfnVoxtaRelay.exe --remote http://your-hub:8789 --audio-folder "E:\VAM\Custom\Sounds\Voxta"

        Options:
          --config <path>       JSON config file. Default: appsettings.json next to the executable.
          --remote <url>         Satellite hub base URL. Sets --remote-hub to <url>/hub and --api to <url>.
          --remote-hub <url>     Full upstream SignalR hub URL.
          --api <url>            Upstream REST/API base URL. Default: inferred from --remote-hub
          --listen <url>         Local VaM listen URL. Default: http://127.0.0.1:8789
          --audio-folder <path>  Approved VaM audio root. The plugin may select a contained subdirectory.
          --token <token>        Optional bearer token for the upstream hub.
          --help                 Print this help.

        Environment variable equivalents:
          PSFN_VOXTA_RELAY_CONFIG
          PSFN_VOXTA_RELAY_REMOTE_URL
          PSFN_VOXTA_RELAY_LISTEN_URL
          PSFN_VOXTA_RELAY_REMOTE_HUB_URL
          PSFN_VOXTA_RELAY_REMOTE_API_BASE_URL
          PSFN_VOXTA_RELAY_AUDIO_FOLDER
          PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN
        """;

    public static bool ShouldShowHelp(string[] args)
    {
        return args.Any(arg => arg is "--help" or "-h" or "/?");
    }

    public static RelayOptions FromArgs(string[] args)
    {
        var cli = ParseArgs(args);
        var configPath = ReadCli(cli, "config")
            ?? Environment.GetEnvironmentVariable("PSFN_VOXTA_RELAY_CONFIG")?.Trim()
            ?? Path.Combine(AppContext.BaseDirectory, "appsettings.json");
        var fileConfig = RelayFileConfig.Load(configPath);

        var remoteBaseRaw = ReadCli(cli, "remote", "server")
            ?? Environment.GetEnvironmentVariable("PSFN_VOXTA_RELAY_REMOTE_URL")?.Trim()
            ?? fileConfig.Remote;
        Uri? remoteBaseUrl = null;
        if (!string.IsNullOrWhiteSpace(remoteBaseRaw))
        {
            remoteBaseUrl = new Uri(remoteBaseRaw);
        }

        var listenUrl = Read(
            ReadCli(cli, "listen", "listen-url"),
            "PSFN_VOXTA_RELAY_LISTEN_URL",
            fileConfig.ListenUrl,
            "http://127.0.0.1:8789");
        var remoteHubRaw = ReadCli(cli, "remote-hub", "hub")
            ?? Environment.GetEnvironmentVariable("PSFN_VOXTA_RELAY_REMOTE_HUB_URL")?.Trim()
            ?? fileConfig.RemoteHubUrl
            ?? (remoteBaseUrl is not null
                ? InferHubUrl(remoteBaseUrl).ToString()
                : null);
        if (string.IsNullOrWhiteSpace(remoteHubRaw))
        {
            throw new ArgumentException(
                "Remote hub URL is required. Set PsfnVoxtaRelay.Remote, PsfnVoxtaRelay.RemoteHubUrl, --remote, --remote-hub, PSFN_VOXTA_RELAY_REMOTE_URL, or PSFN_VOXTA_RELAY_REMOTE_HUB_URL.");
        }
        var remoteHubUrl = new Uri(remoteHubRaw);
        var remoteApiBaseUrl = new Uri(
            ReadCli(cli, "api", "remote-api")
            ?? Environment.GetEnvironmentVariable("PSFN_VOXTA_RELAY_REMOTE_API_BASE_URL")?.Trim()
            ?? fileConfig.RemoteApiBaseUrl
            ?? (remoteBaseUrl is not null
                ? InferApiBaseUrl(remoteBaseUrl).ToString()
                : null)
            ?? InferApiBaseUrl(remoteHubUrl).ToString());
        var fallbackAudioFolder = Read(
            ReadCli(cli, "audio-folder", "audio"),
            "PSFN_VOXTA_RELAY_AUDIO_FOLDER",
            fileConfig.AudioFolder,
            Path.Combine(Path.GetTempPath(), "psfn-voxta-relay-audio"));
        var token = ReadCli(cli, "token", "bearer-token")
            ?? Environment.GetEnvironmentVariable("PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN")
            ?? fileConfig.RemoteBearerToken;
        return new RelayOptions(listenUrl, remoteHubUrl, remoteApiBaseUrl, fallbackAudioFolder, token);
    }

    private static string Read(string? cliValue, string environmentName, string? configValue, string fallback)
    {
        if (!string.IsNullOrWhiteSpace(cliValue))
        {
            return cliValue.Trim();
        }
        var environmentValue = Environment.GetEnvironmentVariable(environmentName);
        if (!string.IsNullOrWhiteSpace(environmentValue))
        {
            return environmentValue.Trim();
        }
        return string.IsNullOrWhiteSpace(configValue) ? fallback : configValue.Trim();
    }

    private static string? ReadCli(Dictionary<string, string> cli, params string[] names)
    {
        foreach (var name in names)
        {
            if (cli.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }
        return null;
    }

    private static Dictionary<string, string> ParseArgs(string[] args)
    {
        var parsed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index += 1)
        {
            var arg = args[index];
            if (!arg.StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException("Unexpected relay argument. Use --help for usage.");
            }

            var keyValue = arg[2..];
            var equals = keyValue.IndexOf('=');
            if (equals >= 0)
            {
                parsed[keyValue[..equals]] = keyValue[(equals + 1)..];
                continue;
            }

            if (index + 1 >= args.Length || args[index + 1].StartsWith("--", StringComparison.Ordinal))
            {
                parsed[keyValue] = "true";
                continue;
            }

            parsed[keyValue] = args[index + 1];
            index += 1;
        }
        return parsed;
    }

    private static Uri InferHubUrl(Uri remoteBaseUrl)
    {
        if (remoteBaseUrl.AbsolutePath.TrimEnd('/').EndsWith("/hub", StringComparison.OrdinalIgnoreCase))
        {
            return remoteBaseUrl;
        }
        var builder = new UriBuilder(remoteBaseUrl)
        {
            Path = JoinPath(remoteBaseUrl.AbsolutePath, "/hub"),
            Query = "",
            Fragment = "",
        };
        return builder.Uri;
    }

    private static Uri InferApiBaseUrl(Uri remoteHubUrl)
    {
        var builder = new UriBuilder(remoteHubUrl)
        {
            Path = remoteHubUrl.AbsolutePath.TrimEnd('/').EndsWith("/hub", StringComparison.OrdinalIgnoreCase)
                ? remoteHubUrl.AbsolutePath.TrimEnd('/')[..^4]
                : remoteHubUrl.AbsolutePath,
            Query = "",
            Fragment = "",
        };
        return builder.Uri;
    }

    private static string JoinPath(string basePath, string path)
    {
        var normalizedBase = basePath == "/" ? "" : basePath.TrimEnd('/');
        return $"{normalizedBase}/{path.TrimStart('/')}";
    }
}

public sealed record RelayFileConfig(
    string? Remote,
    string? ListenUrl,
    string? RemoteHubUrl,
    string? RemoteApiBaseUrl,
    string? AudioFolder,
    string? RemoteBearerToken)
{
    public static RelayFileConfig Empty { get; } = new(null, null, null, null, null, null);

    public static RelayFileConfig Load(string path)
    {
        using var document = RelayConfigReader.Read(path);
        if (document is null)
        {
            return Empty;
        }

        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return Empty;
        }
        var section = TryGetProperty(root, "PsfnVoxtaRelay", "psfnVoxtaRelay") ?? root;
        return new RelayFileConfig(
            ReadString(section, "Remote", "remote", "Server", "server"),
            ReadString(section, "ListenUrl", "listenUrl", "Listen", "listen"),
            ReadString(section, "RemoteHubUrl", "remoteHubUrl", "RemoteHub", "remoteHub", "Hub", "hub"),
            ReadString(section, "RemoteApiBaseUrl", "remoteApiBaseUrl", "Api", "api", "RemoteApi", "remoteApi"),
            ReadString(section, "AudioFolder", "audioFolder", "Audio", "audio"),
            ReadString(section, "RemoteBearerToken", "remoteBearerToken", "Token", "token", "BearerToken", "bearerToken"));
    }

    private static JsonElement? TryGetProperty(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.TryGetProperty(name, out var value))
            {
                return value;
            }
        }
        return null;
    }

    private static string? ReadString(JsonElement element, params string[] names)
    {
        var value = TryGetProperty(element, names);
        return value?.ValueKind == JsonValueKind.String ? value.Value.GetString() : null;
    }
}
