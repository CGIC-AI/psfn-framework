using System.Net;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using NAudio.Wave;

[assembly: InternalsVisibleTo("PsfnVoxtaRelay.Tests")]

// The same owner handles Windows callbacks and injected cross-platform capture.
public sealed class MicrophoneStream : IAsyncDisposable
{
    private readonly object _gate = new();
    private readonly IMicrophoneInput _input;
    private readonly IMicrophoneTransport _transport;
    private readonly MicrophoneLimits _limits;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;
    private readonly Guid _correlationId;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly TaskCompletionSource _stop = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Channel<byte[]> _queue;
    private Task? _pump;
    private Task? _operation;
    private Task? _dispose;
    private RelayEvent? _failure;
    private bool _accepting;
    private int _chunks;
    private int _bytes;

    public MicrophoneStream(RelayOptions options, string sessionId, ILogger logger, Guid correlationId)
        : this(new WindowsMicrophoneInput(), new WebSocketMicrophoneTransport(options, sessionId),
            logger, correlationId, MicrophoneLimits.Default, TimeProvider.System)
    { }

    internal MicrophoneStream(IMicrophoneInput input, IMicrophoneTransport transport,
        ILogger logger, Guid correlationId, MicrophoneLimits limits, TimeProvider time)
    {
        if (limits.Chunks <= 0 || limits.Bytes <= 0 || limits.ChunkBytes <= 0
            || limits.SendTimeout <= TimeSpan.Zero || limits.ShutdownTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(limits));
        _input = input;
        _transport = transport;
        _logger = logger;
        _correlationId = correlationId;
        _limits = limits;
        _time = time;
        _queue = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(limits.Chunks)
        {
            SingleReader = true,
            AllowSynchronousContinuations = false,
        });
        _input.DataAvailable += OnDataAvailable;
        _input.RecordingFailed += OnRecordingFailed;
    }

    internal (int Chunks, int Bytes) Pending { get { lock (_gate) return (_chunks, _bytes); } }
    internal Task Completion { get { lock (_gate) return EnsurePump(); } }

    public Task StartAsync()
    {
        lock (_gate) EnsurePump();
        return _started.Task;
    }

    public ValueTask DisposeAsync()
    {
        lock (_gate)
        {
            StopLocked();
            // Every disposer awaits the same pump and the same cleanup.
            return new ValueTask(_dispose ??= EnsurePump());
        }
    }

    private Task EnsurePump() => _pump ??= Task.Run(RunAsync);

    private void OnDataAvailable(byte[] buffer, int count)
    {
        // NAudio reuses its buffer after this callback. Admission and copying
        // share one lock; capacity includes the active send until it completes.
        lock (_gate)
        {
            if (!_accepting) return;
            if (count <= 0) return;
            if (buffer is null || count > buffer.Length || count > _limits.ChunkBytes
                || _chunks >= _limits.Chunks || count > _limits.Bytes - _bytes)
            {
                StopLocked(RelayEvent.MicrophoneOverflow);
                return;
            }
            try
            {
                var owned = buffer.AsSpan(0, count).ToArray();
                if (!_queue.Writer.TryWrite(owned))
                {
                    CryptographicOperations.ZeroMemory(owned);
                    StopLocked(RelayEvent.MicrophoneOverflow);
                    return;
                }
                _chunks++;
                _bytes += count;
            }
            catch (Exception)
            {
                // No device data or exception can escape the callback/log sink.
                StopLocked(RelayEvent.MicrophoneFailed);
            }
        }
    }

    private void OnRecordingFailed() { lock (_gate) StopLocked(RelayEvent.MicrophoneFailed); }

    private void StopLocked(RelayEvent? failure = null)
    {
        _accepting = false;
        if (!_stop.Task.IsCompleted) _failure = failure;
        _stop.TrySetResult();
        _queue.Writer.TryComplete();
    }

    private async Task RunAsync()
    {
        byte[]? active = null;
        var startupFailed = false;
        try
        {
            if (_stop.Task.IsCompleted) return;
            if (!_input.Supported)
            {
                lock (_gate) StopLocked(RelayEvent.MicrophoneUnsupported);
                return;
            }
            await ExecuteAsync(() => _transport.ConnectAsync(_lifetime.Token));
            await ExecuteAsync(() => _transport.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new
            {
                sampleRate = 16000,
                channels = 1,
                bufferMilliseconds = 30,
                bitsPerSample = 16,
                contentType = "audio/wav",
            }), WebSocketMessageType.Text, _lifetime.Token));
            lock (_gate)
            {
                if (_stop.Task.IsCompleted) return;
                _accepting = true;
            }
            _input.Start();
            RelayLogging.Write(_logger, RelayEvent.AudioSocketOpened, _correlationId);
            _started.TrySetResult();
            while (!_stop.Task.IsCompleted && await _queue.Reader.WaitToReadAsync())
            {
                if (_stop.Task.IsCompleted) break;
                if (!_queue.Reader.TryRead(out active)) continue;
                await ExecuteAsync(() => _transport.SendAsync(active, WebSocketMessageType.Binary, _lifetime.Token));
                Release(active);
                active = null;
            }
        }
        catch (OperationCanceledException) when (_stop.Task.IsCompleted) { }
        catch (TimeoutException)
        {
            startupFailed = !_started.Task.IsCompleted;
            lock (_gate) StopLocked(RelayEvent.MicrophoneSendTimedOut);
        }
        catch (Exception)
        {
            startupFailed = !_started.Task.IsCompleted;
            lock (_gate) StopLocked(RelayEvent.AudioSocketSendFailed);
        }
        finally
        {
            lock (_gate) StopLocked();
            // Only the pump touches capture/transport lifetime. Late callbacks
            // see the permanent stopped flag, never disposed synchronization.
            Cleanup(_input.Stop);
            Cleanup(_lifetime.Cancel);
            Cleanup(_transport.Abort);
            var drained = await DrainAsync();
            if (active is not null) Release(active);
            while (_queue.Reader.TryRead(out var queued)) Release(queued);
            _input.DataAvailable -= OnDataAvailable;
            _input.RecordingFailed -= OnRecordingFailed;
            Cleanup(_input.Dispose);
            if (drained)
            {
                Cleanup(_transport.Dispose);
                _lifetime.Dispose();
            }
            else
            {
                // A transport that violates cancellation/abort cannot keep the
                // pump alive. Defer its disposal until its operation exits, so
                // it cannot race disposed dependencies. Audio is already zeroed.
                _ = DisposeTransportAfterOperationAsync(_operation!, _transport, _lifetime, _logger, _correlationId);
            }
            if (_failure is { } failure) Log(failure);
            if (startupFailed) _started.TrySetException(new IOException("Microphone stream could not start"));
            else _started.TrySetResult();
        }
    }

    private async Task ExecuteAsync(Func<Task> operation)
    {
        if (_stop.Task.IsCompleted) throw new OperationCanceledException();
        _operation = operation();
        var completed = await Task.WhenAny(_operation, _stop.Task)
            .WaitAsync(_limits.SendTimeout, _time);
        if (completed == _stop.Task) throw new OperationCanceledException();
        await _operation;
        _operation = null;
    }

    private async Task<bool> DrainAsync()
    {
        if (_operation is null) return true;
        try { await _operation.WaitAsync(_limits.ShutdownTimeout, _time); }
        catch (TimeoutException) { Log(RelayEvent.MicrophoneShutdownTimedOut); return false; }
        catch (OperationCanceledException) { }
        catch (Exception) { Log(RelayEvent.AudioSocketSendFailed); }
        return true;
    }

    private static async Task DisposeTransportAfterOperationAsync(Task operation,
        IMicrophoneTransport transport, CancellationTokenSource lifetime, ILogger logger, Guid correlationId)
    {
        try { await operation; }
        catch (Exception) { /* The pump already emitted a content-free failure. */ }
        finally
        {
            try { transport.Dispose(); }
            catch (Exception) { RelayLogging.Write(logger, RelayEvent.MicrophoneFailed, correlationId); }
            finally { lifetime.Dispose(); }
        }
    }

    private void Release(byte[] buffer)
    {
        CryptographicOperations.ZeroMemory(buffer);
        lock (_gate) { _chunks--; _bytes -= buffer.Length; }
    }

    private void Log(RelayEvent relayEvent) => RelayLogging.Write(_logger, relayEvent, _correlationId);

    private void Cleanup(Action action)
    {
        try { action(); }
        catch (Exception) { Log(RelayEvent.MicrophoneFailed); }
    }
}

internal sealed record MicrophoneLimits(int Chunks, int Bytes, int ChunkBytes,
    TimeSpan SendTimeout, TimeSpan ShutdownTimeout)
{
    // 16 x 30 ms frames, including the active send: at most 480 ms / 15 KiB PCM.
    internal static readonly MicrophoneLimits Default = new(16, 15360, 960,
        TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(2));
}

internal interface IMicrophoneInput : IDisposable
{
    bool Supported { get; }
    event Action<byte[], int> DataAvailable;
    event Action RecordingFailed;
    void Start();
    void Stop();
}

internal interface IMicrophoneTransport : IDisposable
{
    Task ConnectAsync(CancellationToken cancellationToken);
    Task SendAsync(ReadOnlyMemory<byte> bytes, WebSocketMessageType type, CancellationToken cancellationToken);
    void Abort();
}

internal sealed class WindowsMicrophoneInput : IMicrophoneInput
{
    private WaveInEvent? _wave;
    public bool Supported => OperatingSystem.IsWindows();
    public event Action<byte[], int>? DataAvailable;
    public event Action? RecordingFailed;

    public void Start()
    {
        _wave = new WaveInEvent { WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 30 };
        _wave.DataAvailable += (_, args) => DataAvailable?.Invoke(args.Buffer, args.BytesRecorded);
        _wave.RecordingStopped += (_, args) => { if (args.Exception is not null) RecordingFailed?.Invoke(); };
        _wave.StartRecording();
    }

    public void Stop() => _wave?.StopRecording();
    public void Dispose() => _wave?.Dispose();
}

internal sealed class WebSocketMicrophoneTransport : IMicrophoneTransport
{
    private readonly ClientWebSocket _socket = new();
    private readonly Uri _url;

    internal WebSocketMicrophoneTransport(RelayOptions options, string sessionId)
    {
        var api = options.RemoteApiBaseUrl;
        _url = new UriBuilder(api)
        {
            Scheme = api.Scheme == "https" ? "wss" : "ws",
            Path = $"{api.AbsolutePath.TrimEnd('/')}/ws/audio/input/stream",
            Query = $"sessionId={WebUtility.UrlEncode(sessionId)}",
        }.Uri;
        if (!string.IsNullOrWhiteSpace(options.RemoteBearerToken))
            _socket.Options.SetRequestHeader("Authorization", $"Bearer {options.RemoteBearerToken}");
    }

    public Task ConnectAsync(CancellationToken cancellationToken) => _socket.ConnectAsync(_url, cancellationToken);
    public Task SendAsync(ReadOnlyMemory<byte> bytes, WebSocketMessageType type, CancellationToken cancellationToken)
        => _socket.SendAsync(bytes, type, true, cancellationToken).AsTask();
    public void Abort() => _socket.Abort();
    public void Dispose() => _socket.Dispose();
}
