using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

if (args is ["--self-test", var fixturePath])
{
    await SelfTest.RunAsync(fixturePath);
    return;
}
if (args.Length != 4)
    throw new ArgumentException("Usage: <JWKS URL> <issuer> <organizationId> <userId>; read JWT from stdin. Or --self-test <fixtures.json>.");
using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) })
{
    var verifier = new PricingTokenVerifier(http, new Uri(args[0]), args[1]);
    var principal = await verifier.ValidateAsync((await Console.In.ReadToEndAsync()).Trim(), args[2], args[3]);
    Console.WriteLine($"Valid pricing token for {principal.FindFirst("organizationId")!.Value}/{principal.FindFirst("userId")!.Value}.");
}

static class SelfTest
{
    public static async Task RunAsync(string path)
    {
        using var fixture = JsonDocument.Parse(await File.ReadAllTextAsync(path));
        var data = fixture.RootElement;
        var org = data.GetProperty("organizationId").GetString()!;
        var user = data.GetProperty("userId").GetString()!;
        var issuer = data.GetProperty("issuer").GetString()!;
        var jwks = data.GetProperty("jwks").GetRawText();
        var rotatedJwks = data.GetProperty("rotatedJwks").GetRawText();
        var tokens = data.GetProperty("tokens");
        string Token(string name) => tokens.GetProperty(name).GetString()!;
        var count = 0;
        foreach (var entry in tokens.EnumerateObject())
        {
            using var transport = new FixtureTransport(_ => Json(entry.Name == "rotated" ? rotatedJwks : jwks));
            using var http = new HttpClient(transport);
            var verifier = new PricingTokenVerifier(http, new Uri("https://trusted.example/api/v1/.well-known/jwks.json"), issuer);
            var expected = entry.Name is "valid" or "rotated";
            bool accepted;
            try { await verifier.ValidateAsync(entry.Value.GetString()!, org, user); accepted = true; }
            catch { accepted = false; }
            if (accepted != expected) throw new Exception($"Unexpected validation result: {entry.Name}");
            Console.WriteLine($"PASS {entry.Name}");
            count++;
        }
        var clock = new TestClock();
        using var cacheTransport = new FixtureTransport(n => Json(n == 1 ? jwks : rotatedJwks));
        using var cacheHttp = new HttpClient(cacheTransport);
        var cached = new PricingTokenVerifier(cacheHttp, new Uri("https://trusted.example/api/v1/.well-known/jwks.json"), issuer, clock);
        await cached.ValidateAsync(Token("valid"), org, user);
        await cached.ValidateAsync(Token("valid"), org, user);
        if (cacheTransport.Requests != 1) throw new Exception("JWKS cache not reused.");
        await Reject(() => cached.ValidateAsync(Token("unknownKid"), org, user));
        if (cacheTransport.Requests != 1) throw new Exception("Unknown kid bypassed refresh cooldown.");
        await cached.ValidateAsync(Token("valid"), org, user); // An attacker must not invalidate known cached keys.
        clock.Advance(TimeSpan.FromSeconds(31));
        await cached.ValidateAsync(Token("rotated"), org, user);
        await cached.ValidateAsync(Token("valid"), org, user); // Old custom kid survives rotation.
        if (cacheTransport.Requests != 2) throw new Exception("Rotation did not refresh exactly once.");
        Console.WriteLine("PASS cache, bounded unknown-kid refresh, and old/new custom-kid rotation");
        count += 3;
        clock.Advance(TimeSpan.FromSeconds(301));
        cacheTransport.Respond = _ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
        await Reject(() => cached.ValidateAsync(Token("valid"), org, user));
        await Reject(() => cached.ValidateAsync(Token("rotated"), org, user));
        if (cacheTransport.Requests != 3) throw new Exception("Network failure was not throttled.");
        Console.WriteLine("PASS expired cache fails closed on network errors");
        count++;
        Console.WriteLine($"{count} interoperability checks passed.");
    }
    private static async Task Reject(Func<Task<System.Security.Claims.ClaimsPrincipal>> action)
    {
        try { await action(); } catch { return; }
        throw new Exception("Expected validation to reject the token.");
    }
    private static HttpResponseMessage Json(string content)
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(content) };
        response.Headers.CacheControl = new CacheControlHeaderValue { Public = true, MaxAge = TimeSpan.FromSeconds(300) };
        return response;
    }
    private sealed class TestClock : TimeProvider
    {
        private DateTimeOffset now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan duration) => now += duration;
    }
    private sealed class FixtureTransport(Func<int, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public int Requests { get; private set; }
        public Func<int, HttpResponseMessage> Respond { get; set; } = respond;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsoluteUri != "https://trusted.example/api/v1/.well-known/jwks.json")
                throw new Exception("Verifier fetched an untrusted URL.");
            return Task.FromResult(Respond(++Requests));
        }
    }
}
