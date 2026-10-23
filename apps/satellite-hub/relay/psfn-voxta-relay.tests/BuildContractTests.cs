using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;

internal static class BuildContractTests
{
    internal static async Task RunAsync([CallerFilePath] string sourcePath = "")
    {
        var relay = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourcePath)!,
            "../psfn-voxta-relay/PsfnVoxtaRelay.csproj"));
        var start = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in new[]
        {
            "msbuild", relay, "-nologo", "-p:RuntimeIdentifier=win-x64",
            "-p:SelfContained=true", "-p:PublishSingleFile=true", "-p:PublishTrimmed=false",
            "-getProperty:TargetFramework,RuntimeIdentifier,RuntimeIdentifiers,RestoreLockedMode,EnableSingleFileAnalyzer,SelfContained,PublishSingleFile,PublishTrimmed",
        }) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("MSBuild query did not start");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30)); }
        catch (TimeoutException)
        {
            process.Kill(entireProcessTree: true);
            throw new InvalidOperationException("MSBuild publish property query timed out");
        }
        await error;
        Require(process.ExitCode == 0, "MSBuild publish property query failed");
        using var evaluation = JsonDocument.Parse(await output);
        var properties = evaluation.RootElement.GetProperty("Properties");
        string Property(string name) => properties.GetProperty(name).GetString()!;
        Require(Property("RuntimeIdentifier") == "win-x64", "Windows publish target was lost");
        Require(Property("RestoreLockedMode") == "true", "Windows publish disabled locked restore");
        Require(Property("EnableSingleFileAnalyzer") == "true", "Single-file analyzer is not included in ordinary restore");
        Require(Property("SelfContained") == "true" && Property("PublishSingleFile") == "true"
            && Property("PublishTrimmed") == "false", "Windows publish shape changed");
        var runtimes = Property("RuntimeIdentifiers").Split(';', StringSplitOptions.RemoveEmptyEntries);
        Require(runtimes.Contains("linux-x64") && runtimes.Contains("win-x64"),
            "Windows target selection replaced the multi-runtime restore graph");
        using var locked = JsonDocument.Parse(await File.ReadAllTextAsync(
            Path.Combine(Path.GetDirectoryName(relay)!, "packages.lock.json")));
        var framework = Property("TargetFramework");
        var runtimeGroups = locked.RootElement.GetProperty("dependencies").EnumerateObject()
            .Select(group => group.Name).Where(name => name.StartsWith(framework + "/", StringComparison.Ordinal))
            .Select(name => name[(framework.Length + 1)..]).ToHashSet(StringComparer.Ordinal);
        Require(runtimeGroups.SetEquals(runtimes), "MSBuild runtime graph disagrees with the committed lock");
        Console.WriteLine("PASS: Windows publish properties preserve the complete locked runtime graph");
    }

    private static void Require(bool condition, string failure)
    {
        if (!condition) throw new InvalidOperationException(failure);
    }
}
