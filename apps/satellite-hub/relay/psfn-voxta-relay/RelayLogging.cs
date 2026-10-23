using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

public enum RelayEvent
{
    Starting,
    Running,
    Stopped,
    Failed,
    RequestCompleted,
    RequestFailed,
    ClientRegistered,
    ClientUnregistered,
    SessionConnected,
    SessionConnectionFailed,
    AudioFolderUpdated,
    AudioDownloaded,
    AudioLocalizationFailed,
    RecordingSessionMissing,
    MicrophoneUnsupported,
    MicrophoneFailed,
    AudioSocketOpened,
    AudioSocketSendFailed,
    ArtifactExpired,
    ArtifactCleanupRejected,
    ArtifactRetentionFailed,
    MicrophoneOverflow,
    MicrophoneSendTimedOut,
    MicrophoneShutdownTimedOut,
}

// Only this closed event schema may cross a log transport. Framework log state,
// categories, scopes, formatters and exceptions can all contain private data.
public static class RelayLogging
{
    private static readonly object OutputLock = new();
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static void Configure(ILoggingBuilder logging)
    {
        logging.ClearProviders();
        logging.AddProvider(new PrivateEventProvider());
    }

    public static void Write(
        ILogger logger,
        RelayEvent relayEvent,
        Guid? correlation = null,
        long? bytes = null,
        int? status = null,
        double? elapsedMs = null)
    {
        var (name, level) = relayEvent switch
        {
            RelayEvent.Starting => ("relay.starting", LogLevel.Information),
            RelayEvent.Running => ("relay.running", LogLevel.Information),
            RelayEvent.Stopped => ("relay.stopped", LogLevel.Information),
            RelayEvent.Failed => ("relay.failed", LogLevel.Error),
            RelayEvent.RequestCompleted => ("request.completed", LogLevel.Information),
            RelayEvent.RequestFailed => ("request.failed", LogLevel.Error),
            RelayEvent.ClientRegistered => ("client.registered", LogLevel.Information),
            RelayEvent.ClientUnregistered => ("client.unregistered", LogLevel.Information),
            RelayEvent.SessionConnected => ("session.connected", LogLevel.Information),
            RelayEvent.SessionConnectionFailed => ("session.connection_failed", LogLevel.Error),
            RelayEvent.AudioFolderUpdated => ("audio.folder_updated", LogLevel.Information),
            RelayEvent.AudioDownloaded => ("audio.downloaded", LogLevel.Information),
            RelayEvent.AudioLocalizationFailed => ("audio.localization_failed", LogLevel.Error),
            RelayEvent.RecordingSessionMissing => ("recording.session_missing", LogLevel.Warning),
            RelayEvent.MicrophoneUnsupported => ("microphone.unsupported", LogLevel.Warning),
            RelayEvent.MicrophoneFailed => ("microphone.failed", LogLevel.Error),
            RelayEvent.AudioSocketOpened => ("audio.socket_opened", LogLevel.Information),
            RelayEvent.AudioSocketSendFailed => ("audio.socket_send_failed", LogLevel.Warning),
            RelayEvent.ArtifactExpired => ("artifact.expired", LogLevel.Information),
            RelayEvent.ArtifactCleanupRejected => ("artifact.cleanup_rejected", LogLevel.Warning),
            RelayEvent.ArtifactRetentionFailed => ("artifact.retention_failed", LogLevel.Error),
            RelayEvent.MicrophoneOverflow => ("microphone.overflow", LogLevel.Warning),
            RelayEvent.MicrophoneSendTimedOut => ("microphone.send_timed_out", LogLevel.Warning),
            RelayEvent.MicrophoneShutdownTimedOut => ("microphone.shutdown_timed_out", LogLevel.Warning),
            _ => throw new ArgumentOutOfRangeException(nameof(relayEvent)),
        };
        var entry = new Entry(DateTimeOffset.UtcNow, level.ToString(), name,
            correlation?.ToString("N"), bytes, status, elapsedMs);
        logger.Log(level, new EventId((int)relayEvent), entry, null, static (state, _) => state.Event);
    }

    private sealed record Entry(
        DateTimeOffset Timestamp,
        string Level,
        string Event,
        string? Correlation,
        long? Bytes,
        int? Status,
        double? ElapsedMs);

    private sealed class PrivateEventProvider : ILoggerProvider
    {
        public ILogger CreateLogger(string categoryName) => new PrivateEventLogger();
        public void Dispose() { }
    }

    private sealed class PrivateEventLogger : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
            Exception? exception, Func<TState, Exception?, string> formatter)
        {
            // Reject before invoking any formatter, enumerating any scope/state,
            // serializing an exception, or handing data to a console provider.
            if (state is not Entry entry) return;
            var line = JsonSerializer.Serialize(entry, JsonOptions);
            lock (OutputLock)
            {
                (logLevel >= LogLevel.Error ? Console.Error : Console.Out).Write(line + "\n");
            }
        }
    }
}
