using System.Diagnostics;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

public static class RelayApplication
{
    public static async Task<int> RunAsync(string[] args)
    {
        using var startupLogs = LoggerFactory.Create(RelayLogging.Configure);
        var startupLogger = startupLogs.CreateLogger("Relay");
        try
        {
            if (RelayOptions.ShouldShowHelp(args))
            {
                Console.WriteLine(RelayOptions.Usage);
                return 0;
            }

            var options = RelayOptions.FromArgs(args);
            RelayAccess.ValidateOptions(options);
            var builder = WebApplication.CreateBuilder(args);
            RelayLogging.Configure(builder.Logging);
            builder.WebHost.UseUrls(options.ListenUrl);
            builder.Services.AddSignalR(signalr =>
            {
                signalr.MaximumReceiveMessageSize = 1024 * 1024 * 32;
            });
            builder.Services.AddSingleton(options);
            builder.Services.AddSingleton(new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }));
            builder.Services.AddSingleton<RelaySessionRegistry>();
            builder.Services.AddSingleton<AudioArtifactStore>();
            builder.Services.AddHostedService<RelayArtifactRetentionService>();
            builder.Services.AddSingleton<RemoteApiProxy>();

            await using var app = builder.Build();
            app.Services.GetRequiredService<AudioArtifactStore>().ApproveAudioFolder(options.FallbackAudioFolder);
            app.Use(async (context, next) =>
            {
                var started = Stopwatch.GetTimestamp();
                try
                {
                    if (!RelayAccess.Allows(context.Request, options))
                    {
                        context.Response.StatusCode = StatusCodes.Status403Forbidden;
                        return;
                    }
                    await next(context);
                }
                catch (Exception)
                {
                    RelayLogging.Write(app.Logger, RelayEvent.RequestFailed);
                    if (context.Response.HasStarted)
                    {
                        context.Abort();
                    }
                    else
                    {
                        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
                    }
                }
                finally
                {
                    RelayLogging.Write(app.Logger, RelayEvent.RequestCompleted,
                        status: context.Response.StatusCode,
                        elapsedMs: Stopwatch.GetElapsedTime(started).TotalMilliseconds);
                }
            });

            app.MapHub<VoxtaRelayHub>("/hub", signalr =>
            {
                signalr.Transports = HttpTransportType.WebSockets;
            });
            app.Map("/{**path}", async (HttpContext context, RemoteApiProxy proxy) =>
            {
                if (context.Request.Path.StartsWithSegments("/api"))
                {
                    await proxy.ProxyAsync(context);
                    return;
                }

                context.Response.ContentType = "text/plain";
                await context.Response.WriteAsync("psfn-voxta-relay\n");
            });

            app.Lifetime.ApplicationStarted.Register(() => RelayLogging.Write(app.Logger, RelayEvent.Running));
            app.Lifetime.ApplicationStopped.Register(() => RelayLogging.Write(app.Logger, RelayEvent.Stopped));
            RelayLogging.Write(app.Logger, RelayEvent.Starting);
            await app.RunAsync();
            return 0;
        }
        catch (Exception)
        {
            // Configuration, paths and runtime exception text are private too.
            RelayLogging.Write(startupLogger, RelayEvent.Failed);
            return 1;
        }
    }
}
