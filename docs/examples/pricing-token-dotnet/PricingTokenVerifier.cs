using System.Security.Claims;
using System.Text.Json;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

// Reuse one verifier per trusted SPACE deployment. HttpClient remains caller-owned.
public sealed class PricingTokenVerifier
{
    private readonly HttpClient http;
    private readonly Uri jwksUrl;
    private readonly string issuer;
    private readonly TimeProvider clock;
    private readonly SemaphoreSlim refreshLock = new(1, 1);
    private readonly JsonWebTokenHandler handler = new() { MapInboundClaims = false };
    private IReadOnlyList<JsonWebKey> keys = Array.Empty<JsonWebKey>();
    private DateTimeOffset expiresAt;
    private DateTimeOffset nextRefreshAt;

    public PricingTokenVerifier(HttpClient http, Uri jwksUrl, string issuer,
        TimeProvider? clock = null)
    {
        if (!jwksUrl.IsAbsoluteUri ||
            (jwksUrl.Scheme != Uri.UriSchemeHttps &&
             !(jwksUrl.Scheme == Uri.UriSchemeHttp && jwksUrl.IsLoopback)))
            throw new ArgumentException("Use a configured HTTPS JWKS URL (HTTP only on loopback).");
        ArgumentException.ThrowIfNullOrWhiteSpace(issuer);
        this.http = http;
        this.jwksUrl = jwksUrl;
        this.issuer = issuer;
        this.clock = clock ?? TimeProvider.System;
    }

    public async Task<ClaimsPrincipal> ValidateAsync(string token, string organizationId,
        string expectedUserId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(organizationId);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedUserId);
        // Reading is NOT validation: these untrusted values only select a configured public key.
        var untrusted = handler.ReadJsonWebToken(token);
        if (untrusted.Alg != SecurityAlgorithms.EcdsaSha256 || string.IsNullOrWhiteSpace(untrusted.Kid))
            throw new SecurityTokenException("Expected an ES256 token with a kid.");
        var key = await SelectKeyAsync(untrusted.Kid, cancellationToken);
        var result = await handler.ValidateTokenAsync(token, new TokenValidationParameters
        {
            RequireSignedTokens = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,
            TryAllIssuerSigningKeys = false,
            ValidAlgorithms = new[] { SecurityAlgorithms.EcdsaSha256 },
            ValidateIssuer = true,
            ValidIssuer = issuer,
            ValidateAudience = true,
            RequireAudience = true,
            ValidAudience = organizationId,
            IgnoreTrailingSlashWhenValidatingAudience = false,
            ValidateLifetime = true,
            RequireExpirationTime = true,
            ClockSkew = TimeSpan.FromSeconds(30)
        });
        // ValidateTokenAsync can return an invalid result without throwing.
        if (!result.IsValid)
            throw new SecurityTokenException("Pricing token validation failed.", result.Exception);
        var principal = new ClaimsPrincipal(result.ClaimsIdentity);
        if (!string.Equals(principal.FindFirst("organizationId")?.Value, organizationId, StringComparison.Ordinal) ||
            !string.Equals(principal.FindFirst("userId")?.Value, expectedUserId, StringComparison.Ordinal))
            throw new SecurityTokenException("Pricing token does not match the authenticated organization/user.");
        return principal; // sub is an opaque URN; use explicit organizationId/userId claims.
    }

    private async Task<JsonWebKey> SelectKeyAsync(string kid, CancellationToken cancellationToken)
    {
        await refreshLock.WaitAsync(cancellationToken);
        try
        {
            var now = clock.GetUtcNow();
            var key = MatchingKey(kid);
            if (now < expiresAt && key is not null) return key;
            // Bounds unknown-kid attacks and failures, including when the cache has expired.
            if (now < nextRefreshAt)
                throw new SecurityTokenException("JWKS refresh is temporarily throttled; retry later.");
            nextRefreshAt = now.AddSeconds(30);
            using var response = await http.GetAsync(jwksUrl, cancellationToken);
            response.EnsureSuccessStatusCode(); // No stale-cache or HS256 fallback on network failure.
            var json = await response.Content.ReadAsStringAsync(cancellationToken);
            using var document = JsonDocument.Parse(json);
            foreach (var jwk in document.RootElement.GetProperty("keys").EnumerateArray())
                foreach (var privateMember in new[] { "d", "p", "q", "dp", "dq", "qi", "oth", "k" })
                    if (jwk.TryGetProperty(privateMember, out _))
                        throw new SecurityTokenException("JWKS must contain public keys only.");
            var refreshed = new JsonWebKeySet(json).Keys;
            if (refreshed.Where(IsSigningKey).GroupBy(key => key.Kid).Any(group => group.Count() > 1))
                throw new SecurityTokenException("JWKS contains ambiguous signing key ids.");
            var maxAge = response.Headers.CacheControl?.MaxAge ?? TimeSpan.FromMinutes(5);
            var age = response.Headers.Age ?? TimeSpan.Zero;
            var seconds = Math.Clamp((maxAge - age).TotalSeconds, 0, 300);
            if (response.Headers.CacheControl is { NoStore: true } or { NoCache: true }) seconds = 0;
            keys = refreshed.ToArray();
            expiresAt = clock.GetUtcNow().AddSeconds(seconds);
            return MatchingKey(kid) ?? throw new SecurityTokenException("Unknown or unsuitable signing key.");
        }
        finally
        {
            refreshLock.Release();
        }
    }

    private JsonWebKey? MatchingKey(string kid)
    {
        var matching = keys.Where(key => key.Kid == kid && IsSigningKey(key)).ToArray();
        if (matching.Length > 1) throw new SecurityTokenException("Ambiguous signing key id.");
        return matching.SingleOrDefault();
    }

    private static bool IsSigningKey(JsonWebKey key) => key.Kty == "EC" && key.Crv == "P-256" &&
        key.Alg == SecurityAlgorithms.EcdsaSha256 && key.Use == "sig" && !string.IsNullOrWhiteSpace(key.Kid);
}
