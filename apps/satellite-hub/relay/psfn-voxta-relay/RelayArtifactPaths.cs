public static class RelayArtifactPaths
{
    public static string Approve(string configuredRoot, string candidate)
    {
        try
        {
            var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(configuredRoot));
            if (root == Path.GetPathRoot(root) || !Path.IsPathFullyQualified(candidate)
                || root.Any(char.IsControl) || candidate.Any(char.IsControl))
            {
                throw new IOException();
            }
            var path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(candidate));
            var relative = Path.GetRelativePath(root, path);
            if (Path.IsPathRooted(relative) || relative == ".."
                || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                throw new IOException();
            }
            return path;
        }
        catch (Exception)
        {
            throw new IOException("Relay artifact path rejected");
        }
    }
}
