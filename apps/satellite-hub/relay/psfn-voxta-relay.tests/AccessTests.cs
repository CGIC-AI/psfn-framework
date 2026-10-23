using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Primitives;

internal static class AccessTests
{
    internal static void Run()
    {
        var checks = 0;
        var ipv4 = Options("http://127.0.0.1:8789");
        var ipv6 = Options("http://[::1]:8789");
        Check(ipv4, ["127.0.0.1:8789"], [], true);
        Check(ipv4, ["127.0.0.1:08789"], [], true);
        Check(ipv4, ["127.0.0.1:8789"], ["http://127.0.0.1:8789"], true);
        Check(ipv4, ["127.0.0.1:8789"], ["HTTP://127.0.0.1:8789"], true);
        Check(ipv4, ["127.0.0.1:8789"], [], true, "::ffff:127.0.0.1");
        Check(ipv6, ["[::1]:8789"], [], true, "::1");
        Check(ipv6, ["[0:0:0:0:0:0:0:1]:8789"], ["http://[::0001]:8789"], true, "::1");
        Check(Options("http://[::ffff:127.0.0.1]:8789"), ["[::ffff:7f00:1]:8789"], [], true);
        foreach (var listener in new[] { "http://127.0.0.1", "http://127.0.0.1:80" })
        {
            var options = Options(listener);
            Check(options, ["127.0.0.1"], ["http://127.0.0.1:80"], true);
            Check(options, ["127.0.0.1:80"], ["http://127.0.0.1"], true);
            Check(options, ["127.0.0.1:8789"], [], false);
        }
        Check(Options("http://[::1]"), ["[0:0:0:0:0:0:0:1]:80"], ["http://[::1]"], true);

        foreach (var host in new[]
        {
            "", "127.0.0.1", "127.0.0.1:80", "127.0.0.1:8790", "localhost:8789",
            "127.0.0.2:8789", "127.1:8789", "2130706433:8789", "0x7f000001:8789",
            "0177.0.0.1:8789", "127.000.000.001:8789", "127.0.0.1.:8789",
            "hostile.example.test:8789", "127.0.0.1.hostile.example.test:8789",
            "127.0.0.1:8789.hostile.example.test", "127.0.0.1:8789,127.0.0.1:8789",
            "127.0.0.1:8789 ", " 127.0.0.1:8789", "127.0.0.1:\t8789",
            "127.0.0.1:", "127.0.0.1:+8789", "127.0.0.1:-1", "127.0.0.1:0",
            "127.0.0.1:65536", "127.0.0.1:99999999999", "127.0.0.1:8789:80",
            "127.0.0.1:8789/", "127.0.0.1:8789?x", "127.0.0.1:8789#x",
            "http://127.0.0.1:8789", "user@127.0.0.1:8789", "127.0.0.1:8789\\hostile",
            "[::1]:8789", "[::ffff:127.0.0.1]:8789", "[127.0.0.1]:8789",
        }) Check(ipv4, [host], [], false);
        foreach (var host in new[]
        {
            "::1:8789", "[::1", "[::1]8789", "[::1]:", "[::1]:+8789", "[::1]:8789:80",
            "[::1]]:8789", "[[::1]:8789", "[::1%0]:8789", "[::1%25lo]:8789",
            "[::2]:8789", "[::ffff:127.0.0.1]:8789", "[::1]:8789/", "[::1]:80", "[::1]",
        }) Check(ipv6, [host], [], false, "::1");
        foreach (var origin in new[]
        {
            "", "null", "https://127.0.0.1:8789", "http://localhost:8789",
            "http://127.0.0.1:8790", "http://127.0.0.1", "http://[::1]:8789",
            "http://127.0.0.1.hostile.example.test:8789", "http://127.0.0.1:8789/",
            "http://127.0.0.1:8789/path", "http://127.0.0.1:8789?query",
            "http://user@127.0.0.1:8789", "http://127.0.0.1:8789#fragment",
            "http://127.0.0.1:8789 http://127.0.0.1:8789", " http://127.0.0.1:8789",
        }) Check(ipv4, ["127.0.0.1:8789"], [origin], false);
        Check(ipv4, [], [], false);
        Check(ipv4, ["127.0.0.1:8789", "127.0.0.1:8789"], [], false);
        Check(ipv4, ["127.0.0.1:8789"], ["http://127.0.0.1:8789", "http://127.0.0.1:8789"], false);
        Check(ipv4, ["hostile.example.test:8789"], ["http://127.0.0.1:8789"], false);
        Check(ipv4, ["127.0.0.1:8789"], [], false, "192.0.2.8");
        Check(ipv4, ["127.0.0.1:8789"], [], false, "::ffff:192.0.2.8");
        Check(ipv4, ["127.0.0.1:8789"], [], false, "192.0.2.8", forwarded: "127.0.0.1:8789");
        Check(ipv4, ["127.0.0.1:8789"], [], false, null);
        Check(ipv4, ["127.0.0.1:8789"], [], false, target: "http://127.0.0.1:8789/api/private-fixture");
        Check(ipv4, ["127.0.0.1:8789"], [], false, target: "http://hostile.example.test:8789/api/private-fixture");
        Check(ipv4, ["127.0.0.1:8789"], [], true, forwarded: "hostile.example.test:8789");
        Check(ipv4, ["hostile.example.test:8789"], [], false, forwarded: "127.0.0.1:8789");
        Console.WriteLine($"PASS: {checks} relay access cases enforce peer, exact Host, independent Origin and origin-form targets");

        void Check(RelayOptions options, string[] hosts, string[] origins, bool expected,
            string? peer = "127.0.0.1", string target = "/api/private-fixture", string? forwarded = null)
        {
            var context = new DefaultHttpContext();
            context.Connection.RemoteIpAddress = peer is null ? null : IPAddress.Parse(peer);
            context.Features.Get<IHttpRequestFeature>()!.RawTarget = target;
            context.Request.Headers.Host = new StringValues(hosts);
            context.Request.Headers.Origin = new StringValues(origins);
            if (forwarded is not null)
            {
                context.Request.Headers["Forwarded"] = $"host=\"{forwarded}\";proto=http";
                context.Request.Headers["X-Forwarded-Host"] = forwarded;
                context.Request.Headers["X-Forwarded-For"] = "127.0.0.1";
            }
            checks++;
            if (new RelayAccess(options).Allows(context.Request) != expected)
                throw new InvalidOperationException($"Relay access case {checks} disagrees with the configured local authority");
        }
    }

    private static RelayOptions Options(string listen) => new(listen,
        new Uri("http://127.0.0.1:1/hub"), new Uri("http://127.0.0.1:1"), Path.GetTempPath(), null);
}
