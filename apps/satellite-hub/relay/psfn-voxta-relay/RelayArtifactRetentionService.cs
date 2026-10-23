using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

public sealed class RelayArtifactRetentionService(AudioArtifactStore store, ILogger<RelayArtifactRetentionService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(15));
        try
        {
            do
            {
                try { store.SweepExpired(); }
                catch (Exception)
                {
                    RelayLogging.Write(logger, RelayEvent.ArtifactRetentionFailed);
                    throw;
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
