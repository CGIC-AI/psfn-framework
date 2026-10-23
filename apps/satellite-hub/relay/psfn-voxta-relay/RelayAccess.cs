using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

// The relay holds the remote Hub credential on behalf of a local native client.
// Keep its listener local and never attach that credential to model-chosen URLs.
public sealed class RelayAccess
{
    private readonly IPAddress _listenAddress;
    private readonly int _listenPort;

    public RelayAccess(RelayOptions options)
    {
        ValidateOptions(options);
        var listen = new Uri(options.ListenUrl);
        _listenAddress = IPAddress.Parse(listen.Host);
        _listenPort = listen.Port;
    }

    public static void ValidateOptions(RelayOptions options)
    {
        if (!Uri.TryCreate(options.ListenUrl, UriKind.Absolute, out var listen)
            || listen.Scheme != "http"
            || !IPAddress.TryParse(listen.Host, out var address)
            || !IsLoopback(address))
        {
            throw new ArgumentException("Voxta relay requires a literal loopback HTTP listen URL");
        }
        foreach (var uri in new[] { listen, options.RemoteHubUrl, options.RemoteApiBaseUrl })
        {
            if (uri.Scheme is not ("http" or "https")
                || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0)
            {
                throw new ArgumentException("Voxta relay URLs must be HTTP(S), credential-free and have no query or fragment");
            }
        }
    }

    public bool Allows(HttpRequest request)
    {
        var peer = request.HttpContext.Connection.RemoteIpAddress;
        if (peer is null || !IsLoopback(peer)) return false;
        // Kestrel can replace Host from an absolute-form target. Accept only
        // origin-form targets so two different authorities cannot be hidden here.
        var target = request.HttpContext.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (target is not null && !target.StartsWith('/')) return false;
        var host = request.Headers.Host;
        if (host.Count != 1 || !MatchesAuthority(host[0])) return false;
        var origin = request.Headers.Origin;
        return origin.Count == 0 || (origin.Count == 1
            && origin[0] is { } value
            && value.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            && MatchesAuthority(value["http://".Length..]));
    }

    private bool MatchesAuthority(string? authority)
    {
        if (string.IsNullOrEmpty(authority)) return false;
        string host;
        string port;
        IPAddress address;
        if (authority[0] == '[')
        {
            var end = authority.IndexOf(']');
            if (end < 0) return false;
            host = authority[1..end];
            port = authority[(end + 1)..];
            if (host.Contains('%') || !IPAddress.TryParse(host, out address!)
                || address.AddressFamily != AddressFamily.InterNetworkV6) return false;
        }
        else
        {
            var separator = authority.IndexOf(':');
            host = separator < 0 ? authority : authority[..separator];
            port = separator < 0 ? "" : authority[separator..];
            // IPAddress also accepts shortened, integer, octal and hexadecimal
            // IPv4 aliases. Require the literal dotted-decimal authority instead.
            if (!IPAddress.TryParse(host, out address!)
                || address.AddressFamily != AddressFamily.InterNetwork
                || address.ToString() != host) return false;
        }
        var effectivePort = 80;
        if (port.Length > 0 && (port[0] != ':'
            || !int.TryParse(port.AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture, out effectivePort)
            || effectivePort is < 1 or > 65535)) return false;
        return address.Equals(_listenAddress) && effectivePort == _listenPort;
    }

    public static void Authenticate(HttpRequestMessage request, RelayOptions options)
    {
        if (request.RequestUri is null || !SameOrigin(request.RequestUri, options.RemoteApiBaseUrl))
        {
            throw new InvalidOperationException("Voxta relay only sends credentials to its configured upstream API origin");
        }
        request.Headers.Authorization = string.IsNullOrWhiteSpace(options.RemoteBearerToken)
            ? null : new AuthenticationHeaderValue("Bearer", options.RemoteBearerToken);
    }

    private static bool IsLoopback(IPAddress address) =>
        IPAddress.IsLoopback(address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address);

    private static bool SameOrigin(Uri left, Uri right) =>
        left.Scheme == right.Scheme && left.IdnHost == right.IdnHost && left.Port == right.Port;
}
