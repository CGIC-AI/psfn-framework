using System.Net;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Http;

// The relay holds the remote Hub credential on behalf of a local native client.
// Keep its listener local and never attach that credential to model-chosen URLs.
public static class RelayAccess
{
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

    public static bool Allows(HttpRequest request, RelayOptions options)
    {
        var peer = request.HttpContext.Connection.RemoteIpAddress;
        if (peer is null || !IsLoopback(peer)) return false;
        var origin = request.Headers.Origin;
        return origin.Count == 0 || (origin.Count == 1
            && origin[0] == new Uri(options.ListenUrl).GetLeftPart(UriPartial.Authority));
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
