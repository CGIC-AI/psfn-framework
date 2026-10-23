using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;

internal static class MicrophoneTests
{
    private static readonly TimeSpan TestDeadline = TimeSpan.FromSeconds(5);
    private static readonly MicrophoneLimits Limits = new(3, 12, 6,
        TimeSpan.FromSeconds(30), TimeSpan.FromMilliseconds(100));

    internal static async Task RunAsync()
    {
        await CapacityAsync();
        await ByteCapacityAsync();
        await ConcurrentCallbacksAsync();
        await TimeoutAsync();
        await FailureAndRecoveryAsync();
        await DisposeAsync();
        await DisposalDeadlineAsync();
        await StartupAndCleanupFailureAsync();
        Console.WriteLine("PASS: microphone admission, active-send bounds, timeout, failure, recovery and bounded disposal");
    }

    private static async Task CapacityAsync()
    {
        using var fixture = new Fixture();
        var release = Signal();
        fixture.Sender.OnAudio = (_, token) => release.Task.WaitAsync(token);
        await fixture.Stream.StartAsync().WaitAsync(TestDeadline);
        var reused = new byte[] { 10, 11, 12, 13 };
        fixture.Input.Emit(reused);
        var active = await fixture.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        Array.Fill(reused, (byte)99);
        Require(active.ToArray().SequenceEqual(new byte[] { 10, 11, 12, 13 }), "NAudio callback buffer was not copied synchronously");
        fixture.Input.Emit([20, 21, 22, 23]);
        fixture.Input.Emit([30, 31, 32, 33]);
        Require(fixture.Stream.Pending == (3, 12), "Exact capacity must include the active send");
        Require(!fixture.Stream.Completion.IsCompleted, "Exact capacity incorrectly stopped the stream");
        release.SetResult();
        await fixture.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        await fixture.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        await fixture.Stream.DisposeAsync().AsTask().WaitAsync(TestDeadline);
        Require(fixture.Sender.MaximumActive == 1, "Audio sends overlapped");
        fixture.AssertReleased();

        using var overflowing = new Fixture();
        overflowing.Sender.OnAudio = (_, token) => Task.Delay(Timeout.InfiniteTimeSpan, token);
        await overflowing.Stream.StartAsync().WaitAsync(TestDeadline);
        overflowing.Input.Emit([1]);
        await overflowing.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        overflowing.Input.Emit([2]);
        overflowing.Input.Emit([3]);
        Require(overflowing.Stream.Pending == (3, 3), "Chunk capacity was not counted independently of bytes");
        overflowing.Input.Emit([4]);
        await overflowing.Stream.Completion.WaitAsync(TestDeadline);
        Require(overflowing.Log.Events.Count(evt => evt == RelayEvent.MicrophoneOverflow) == 1, "One-over chunk capacity did not fail closed once");
        overflowing.AssertReleased();
    }

    private static async Task ByteCapacityAsync()
    {
        using var fixture = new Fixture(Limits with { Chunks = 8 });
        fixture.Sender.OnAudio = (_, token) => Task.Delay(Timeout.InfiniteTimeSpan, token);
        await fixture.Stream.StartAsync().WaitAsync(TestDeadline);
        fixture.Input.Emit([1, 2, 3, 4, 5, 6]);
        await fixture.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        fixture.Input.Emit([7, 8, 9, 10, 11, 12]);
        Require(fixture.Stream.Pending == (2, 12), "Exact byte capacity did not include active audio");
        fixture.Input.Emit([13]);
        await fixture.Stream.Completion.WaitAsync(TestDeadline);
        Require(fixture.Log.Events.Contains(RelayEvent.MicrophoneOverflow), "One-over byte capacity did not stop the stream");
        fixture.AssertReleased();

        using var oversized = new Fixture();
        await oversized.Stream.StartAsync().WaitAsync(TestDeadline);
        oversized.Input.Emit(new byte[Limits.ChunkBytes + 1]);
        await oversized.Stream.Completion.WaitAsync(TestDeadline);
        Require(oversized.Sender.AudioCalls == 0, "Oversized callback reached the sender");
        oversized.AssertReleased();
    }

    private static async Task ConcurrentCallbacksAsync()
    {
        using var fixture = new Fixture();
        fixture.Sender.OnAudio = (_, token) => Task.Delay(Timeout.InfiniteTimeSpan, token);
        await fixture.Stream.StartAsync().WaitAsync(TestDeadline);
        fixture.Input.Emit([1, 2, 3, 4]);
        await fixture.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        await Task.WhenAll(Enumerable.Range(0, 64).Select(_ => Task.Run(() => fixture.Input.Emit([5, 6, 7, 8]))));
        await fixture.Stream.Completion.WaitAsync(TestDeadline);
        Require(fixture.Sender.MaximumActive == 1, "Concurrent callbacks launched concurrent sends");
        Require(fixture.Log.Events.Count(evt => evt == RelayEvent.MicrophoneOverflow) == 1, "Concurrent overflow was not terminal");
        fixture.AssertReleased();
    }

    private static async Task TimeoutAsync()
    {
        var clock = new DeadlineClock();
        using var fixture = new Fixture(time: clock);
        fixture.Sender.OnAudio = (_, token) => Task.Delay(Timeout.InfiniteTimeSpan, token);
        await fixture.Stream.StartAsync().WaitAsync(TestDeadline);
        fixture.Input.Emit(Encoding.UTF8.GetBytes("secret"));
        var active = await fixture.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        await clock.ExpireAsync(Limits.SendTimeout);
        await fixture.Stream.Completion.WaitAsync(TestDeadline);
        Require(fixture.Log.Events.Contains(RelayEvent.MicrophoneSendTimedOut), "Indefinitely stalled send had no deadline");
        Require(fixture.Sender.LastToken.IsCancellationRequested, "Timeout did not cancel the lifetime token");
        Require(active.Span.IndexOfAnyExcept((byte)0) < 0, "Stopped active audio was not cleared");
        fixture.AssertReleased();
    }

    private static async Task FailureAndRecoveryAsync()
    {
        using var failed = new Fixture();
        var fail = Signal();
        failed.Sender.OnAudio = async (_, _) => { await fail.Task; throw new IOException("invented-private-sender-failure"); };
        await failed.Stream.StartAsync().WaitAsync(TestDeadline);
        failed.Input.Emit([1, 2, 3]);
        await failed.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        failed.Input.Emit([4, 5, 6]);
        fail.SetResult();
        await failed.Stream.Completion.WaitAsync(TestDeadline);
        Require(failed.Sender.AudioCalls == 1, "Queued audio sent after a send failure");
        Require(failed.Log.Events.Contains(RelayEvent.AudioSocketSendFailed), "Send failure had no safe diagnostic");
        failed.AssertReleased();

        using var fresh = new Fixture();
        await fresh.Stream.StartAsync().WaitAsync(TestDeadline);
        fresh.Input.Emit([7, 8, 9]);
        await fresh.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        await fresh.Stream.DisposeAsync().AsTask().WaitAsync(TestDeadline);
        Require(fresh.Sender.AudioCalls == 1 && !fresh.Log.Events.Contains(RelayEvent.AudioSocketSendFailed), "Fresh stream could not recover after a previous failure");
        fresh.AssertReleased();
    }

    private static async Task DisposeAsync()
    {
        using var fixture = new Fixture();
        fixture.Sender.OnAudio = (_, token) => Task.Delay(Timeout.InfiniteTimeSpan, token);
        await fixture.Stream.StartAsync().WaitAsync(TestDeadline);
        fixture.Input.Emit([1, 2, 3]);
        await fixture.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        fixture.Input.Emit([4, 5, 6]);
        var lateCallback = fixture.Input.CaptureCallback();
        var disposals = Enumerable.Range(0, 32).Select(_ => Task.Run(async () => await fixture.Stream.DisposeAsync())).ToArray();
        await Task.WhenAll(disposals).WaitAsync(TestDeadline);
        lateCallback([9, 9, 9], 3);
        fixture.Input.Emit([8, 8, 8]);
        await fixture.Stream.DisposeAsync();
        Require(fixture.Input.Stops == 1 && fixture.Input.Disposals == 1 && fixture.Sender.Disposals == 1, "Concurrent/repeated disposal was not idempotent");
        Require(fixture.Sender.AudioCalls == 1, "Callback after stop sent audio");
        Require(fixture.Input.StoppedBeforeCancellation, "Input was not stopped before send cancellation");
        fixture.AssertReleased();
    }

    private static async Task DisposalDeadlineAsync()
    {
        var clock = new DeadlineClock();
        using var fixture = new Fixture(time: clock);
        var release = Signal();
        fixture.Sender.OnAudio = (_, _) => release.Task; // deliberately ignores cancellation and abort
        await fixture.Stream.StartAsync().WaitAsync(TestDeadline);
        fixture.Input.Emit([1, 2, 3]);
        var active = await fixture.Sender.Sends.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
        var elapsed = Stopwatch.StartNew();
        var disposal = fixture.Stream.DisposeAsync().AsTask();
        await clock.ExpireAsync(Limits.ShutdownTimeout);
        await disposal.WaitAsync(TestDeadline);
        Require(elapsed.Elapsed < TimeSpan.FromSeconds(2), "Disposal waited indefinitely for an uncooperative transport");
        Require(fixture.Stream.Completion.IsCompleted, "Shutdown deadline returned with a live pump");
        Require(fixture.Stream.Pending == (0, 0) && active.Span.IndexOfAnyExcept((byte)0) < 0, "Shutdown deadline retained audio contents");
        Require(fixture.Sender.Disposals == 0, "An unfinished operation raced disposed transport dependencies");
        Require(fixture.Log.Events.Contains(RelayEvent.MicrophoneShutdownTimedOut), "Shutdown deadline had no safe diagnostic");
        release.SetResult();
        await fixture.Sender.Disposed.Task.WaitAsync(TestDeadline);
        fixture.AssertReleased();
    }

    private static async Task StartupAndCleanupFailureAsync()
    {
        using var startup = new Fixture();
        startup.Sender.OnConnect = _ => Task.FromException(new IOException("invented-private-connect-failure"));
        var rejected = false;
        try { await startup.Stream.StartAsync().WaitAsync(TestDeadline); }
        catch (IOException error) { rejected = true; Require(!error.ToString().Contains("invented-private"), "Startup failure exposed private input"); }
        Require(rejected, "Connect failure appeared to start recording successfully");
        startup.AssertReleased();

        using var cleanup = new Fixture();
        cleanup.Input.ThrowDuringCleanup = true;
        cleanup.Sender.ThrowDuringCleanup = true;
        await cleanup.Stream.StartAsync().WaitAsync(TestDeadline);
        await cleanup.Stream.DisposeAsync().AsTask().WaitAsync(TestDeadline);
        Require(cleanup.Input.Disposals == 1 && cleanup.Sender.Disposals == 1, "A cleanup exception skipped subsequent owned cleanup");
        Require(cleanup.Log.Events.Contains(RelayEvent.MicrophoneFailed), "Cleanup failures were silently discarded");
    }

    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static void Require(bool condition, string failure) { if (!condition) throw new InvalidOperationException(failure); }

    private sealed class Fixture : IDisposable
    {
        internal readonly Input Input = new();
        internal readonly Sender Sender = new();
        internal readonly EventLog Log = new();
        internal readonly MicrophoneStream Stream;

        internal Fixture(MicrophoneLimits? limits = null, TimeProvider? time = null)
        {
            Stream = new MicrophoneStream(Input, Sender, Log, Guid.NewGuid(), limits ?? Limits, time ?? TimeProvider.System);
            Sender.BeforeCancellation = () => Input.StoppedBeforeCancellation = Input.Stops > 0;
        }

        internal void AssertReleased()
        {
            Require(Stream.Pending == (0, 0), "Stopped stream retained queue capacity");
            Require(Input.Stops == 1 && Input.Disposals == 1 && Sender.Disposals == 1, "Stopped stream retained owned dependencies");
            Require(Sender.Active == 0 && !Sender.DisposedWhileActive, "Transport was disposed while a sender could still access it");
            Require(Log.Exceptions == 0, "Raw exception reached the diagnostic sink");
        }

        public void Dispose() => Stream.DisposeAsync().AsTask().GetAwaiter().GetResult();
    }

    private sealed class Input : IMicrophoneInput
    {
        public bool Supported => true;
        public event Action<byte[], int>? DataAvailable;
        public event Action? RecordingFailed;
        internal int Stops;
        internal int Disposals;
        internal bool StoppedBeforeCancellation;
        internal bool ThrowDuringCleanup;
        public void Start() { }
        public void Stop() { Interlocked.Increment(ref Stops); if (ThrowDuringCleanup) throw new IOException("invented-private-stop-failure"); }
        public void Dispose() { Interlocked.Increment(ref Disposals); if (ThrowDuringCleanup) throw new IOException("invented-private-dispose-failure"); }
        internal void Emit(byte[] bytes) => DataAvailable?.Invoke(bytes, bytes.Length);
        internal Action<byte[], int> CaptureCallback() => DataAvailable!;
        internal void Fail() => RecordingFailed?.Invoke();
    }

    private sealed class Sender : IMicrophoneTransport
    {
        internal readonly Channel<ReadOnlyMemory<byte>> Sends = Channel.CreateUnbounded<ReadOnlyMemory<byte>>();
        internal readonly TaskCompletionSource Disposed = Signal();
        internal Func<CancellationToken, Task> OnConnect = _ => Task.CompletedTask;
        internal Func<ReadOnlyMemory<byte>, CancellationToken, Task> OnAudio = (_, _) => Task.CompletedTask;
        internal Action BeforeCancellation = () => { };
        internal CancellationToken LastToken;
        internal int AudioCalls;
        internal int Active;
        internal int MaximumActive;
        internal int Disposals;
        internal bool DisposedWhileActive;
        internal bool ThrowDuringCleanup;
        public Task ConnectAsync(CancellationToken token) => OnConnect(token);

        public async Task SendAsync(ReadOnlyMemory<byte> bytes, WebSocketMessageType type, CancellationToken token)
        {
            if (type == WebSocketMessageType.Text)
            {
                using var spec = JsonDocument.Parse(bytes);
                Require(spec.RootElement.GetProperty("sampleRate").GetInt32() == 16000, "Microphone format changed");
                return;
            }
            LastToken = token;
            using var registration = token.Register(() => BeforeCancellation());
            Interlocked.Increment(ref AudioCalls);
            var active = Interlocked.Increment(ref Active);
            MaximumActive = Math.Max(MaximumActive, active);
            Sends.Writer.TryWrite(bytes);
            try { await OnAudio(bytes, token); }
            finally { Interlocked.Decrement(ref Active); }
        }

        public void Abort() { if (ThrowDuringCleanup) throw new IOException("invented-private-abort-failure"); }
        public void Dispose()
        {
            DisposedWhileActive |= Active != 0;
            Interlocked.Increment(ref Disposals);
            Disposed.TrySetResult();
            if (ThrowDuringCleanup) throw new IOException("invented-private-transport-dispose-failure");
        }
    }

    private sealed class EventLog : ILogger
    {
        internal readonly ConcurrentQueue<RelayEvent> Events = new();
        internal int Exceptions;
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            Events.Enqueue((RelayEvent)eventId.Id);
            if (exception is not null) Interlocked.Increment(ref Exceptions);
            Require(!formatter(state, exception).Contains("invented-private"), "Private input crossed a microphone log sink");
        }
    }

    // Only expire an armed, live timer. Waiting for its creation uses real time,
    // so an implementation that forgets the time seam fails instead of hanging.
    private sealed class DeadlineClock : TimeProvider
    {
        private readonly Channel<DeadlineTimer> _timers = Channel.CreateUnbounded<DeadlineTimer>();
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new DeadlineTimer(callback, state, dueTime);
            _timers.Writer.TryWrite(timer);
            return timer;
        }

        internal async Task ExpireAsync(TimeSpan expected)
        {
            while (true)
            {
                var timer = await _timers.Reader.ReadAsync().AsTask().WaitAsync(TestDeadline);
                if (timer.Disposed || timer.Due != expected) continue;
                timer.Expire();
                return;
            }
        }

        private sealed class DeadlineTimer(TimerCallback callback, object? state, TimeSpan due) : ITimer
        {
            internal TimeSpan Due = due;
            private int _disposed;
            internal bool Disposed => Volatile.Read(ref _disposed) != 0;
            public bool Change(TimeSpan dueTime, TimeSpan period) { Due = dueTime; return !Disposed; }
            public void Dispose() => Interlocked.Exchange(ref _disposed, 1);
            public ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
            internal void Expire() { if (!Disposed) callback(state); }
        }
    }
}
