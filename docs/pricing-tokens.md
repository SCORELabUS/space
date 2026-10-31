# Pricing tokens: signing and verification

`POST /api/v1/features/{userId}/pricing-token` returns a JWT with the evaluated features, the pricing and
subscription contexts and the subscription of a contract. SPACE signs it with **ES256** (ECDSA on P-256 with
SHA-256) and publishes the public keys, so an organization verifies tokens with public material only: nothing it
holds lets it mint a token, for itself or for another organization of the same SPACE.

Servers that sign this way advertise the capability token `pricing-token-jwks` in `X-Space-Capabilities`.

## The public keys (JWKS)

```
GET {SPACE_URL}/api/v1/.well-known/jwks.json
```

No API key. The answer is a JSON Web Key Set (`Content-Type: application/jwk-set+json`,
`Cache-Control: public, max-age=300`):

```json
{
  "keys": [
    { "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "kid": "Wq8x...", "alg": "ES256", "use": "sig" }
  ]
}
```

The first key is the one that signs new tokens; any others are previous keys whose tokens may not have expired
yet (or the next key, published before the switch). Every token names its key in the `kid` header. The API server
also answers at `/.well-known/jwks.json` (no prefix); behind the bundled nginx only the `/api/` URL is proxied.

## Fetching and verifying a token without a SPACE SDK

The wire format is a standard **compact JWS/JWT**: three base64url parts (`header.payload.signature`).
The header carries `alg: ES256` and `kid`; the payload is JSON. ES256 uses P-256/SHA-256 and the JOSE
64-byte `R || S` signature format, **not ASN.1/DER**. Use a maintained JWT library rather than implementing
ECDSA or base64 conversions. No SPACE SDK, private signing key, or shared secret is needed to verify it.

Obtain the token on your trusted backend with an organization API key (any scope, including EVALUATION):

```sh
# SPACE_URL, SPACE_ORG_API_KEY and URL_ENCODED_USER_ID are application configuration.
curl --fail-with-body --request POST \
  --header "x-api-key: $SPACE_ORG_API_KEY" \
  "$SPACE_URL/api/v1/features/$URL_ENCODED_USER_ID/pricing-token"
# Response: {"pricingToken":"eyJ..."}

# Public key discovery needs no API key:
curl --fail-with-body "$SPACE_URL/api/v1/.well-known/jwks.json"
```

Keep the organization API key on your backend. The pricing token is a signed entitlement snapshot, not an
API credential: it does not replace `x-api-key` on SPACE requests, authenticate a login, or record consumption.

For every technology, use this verification procedure:

1. Configure the trusted HTTPS JWKS URL and expected issuer (`JWT_ISSUER`, default `space`) in the application.
   Determine the expected organization and user from your authenticated application context, never from the token.
2. Read the untrusted header only to require `alg: ES256` and a non-empty `kid`. Obtain that key from the configured
   JWKS: `kty: EC`, `crv: P-256`, `alg: ES256`, `use: sig`; reject missing or ambiguous matching keys.
3. Verify the signature and require `exp`, `iss` and `aud`. Check issuer and audience exactly, expiry and `nbf`
   when present, allowing only a small configured clock skew (the .NET example uses 30 seconds).
4. Require `organizationId` and `userId` to match the authenticated application context exactly. Treat `sub` as
   an opaque URN. Only then use `features`, contexts or `subscription`; ignore unknown additive claims.
5. Cache JWKS for at most the advertised 300 seconds. On an unknown `kid`, refresh once with a bounded global
   cooldown; reject if it remains unknown. Network or validation errors must never enable HS256 or skip validation.

A representative payload is:

```json
{
  "iss": "space", "aud": "0123456789abcdef01234567",
  "sub": "urn:space:0123456789abcdef01234567:customer-42",
  "userId": "customer-42", "organizationId": "0123456789abcdef01234567",
  "iat": 1800000000, "exp": 1800003600,
  "features": {}, "pricingContext": {}, "subscriptionContext": {},
  "subscription": {
    "contractedServices": {"storage": "1.2.0"},
    "subscriptionPlans": {"storage": "PRO"}, "subscriptionAddOns": {},
    "contractVersion": "opaque-contract-version"
  }
}
```

The payload above is illustrative; do not treat it as an issued or currently valid token.
`subscription.contractVersion` identifies the contract state used for evaluation, not a signing-key version.
`dormantServices`, when present, lists disabled or missing services whose features are omitted.
A valid signature proves what SPACE issued at that time; it does not prove that the contract or usage is still
current. Reconcile with SPACE on contract events/reconnect or before operations requiring fresh state, then call
`POST /features/{userId}/pricing-token` again. Already distributed tokens remain snapshots until expiry;
clearing server caches cannot revoke them. Use server-side evaluation for current consumption enforcement.

## Verifying a token

Configure the JWKS URL of your SPACE yourself and **pin the algorithm**. Never take a key or key URL from the token
(`jwk`, `jku`, `x5u` headers) and never accept `alg: none` or `HS256`.

### Node.js / browser (`jose`)

```js
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

const SPACE_JWKS = createRemoteJWKSet(
  new URL('https://space.example.com/api/v1/.well-known/jwks.json'),
  { cacheMaxAge: 300_000, cooldownDuration: 30_000 },
);

export async function verifyPricingToken(token, myOrganizationId, expectedUserId) {
  const header = decodeProtectedHeader(token); // still untrusted
  if (header.alg !== 'ES256' || typeof header.kid !== 'string' || !header.kid.trim()) {
    throw new Error('Expected ES256 with a kid');
  }
  const { payload } = await jwtVerify(token, SPACE_JWKS, {
    algorithms: ['ES256'],
    issuer: 'space', // JWT_ISSUER of your SPACE (default "space")
    audience: myOrganizationId, // aud is the organization of the contract
    requiredClaims: ['exp', 'iss', 'aud'],
  });
  // aud and organizationId name the same organization.
  if (payload.organizationId !== myOrganizationId || payload.userId !== expectedUserId) {
    throw new Error('Pricing token does not match the authenticated organization/user');
  }
  return payload; // the user is payload.userId; sub is an opaque URN
}
```

`createRemoteJWKSet` caches the keys and refetches them when a token names an unknown `kid`, so key rotations need
no change on the verifier. The same code runs in browsers (WebCrypto supports ES256 everywhere).

### Python (PyJWT 2.15.1+ with `cryptography`)

Install `PyJWT[crypto]>=2.15.1`; this version supplies the bounded refresh cooldown used below.

```python
import jwt

jwks = jwt.PyJWKClient(
    "https://space.example.com/api/v1/.well-known/jwks.json",
    lifespan=300, cooldown_duration=30, timeout=10, cache_keys=False,
)

def verify_pricing_token(token: str, my_organization_id: str, expected_user_id: str) -> dict:
    header = jwt.get_unverified_header(token)
    if header.get("alg") != "ES256" or not isinstance(header.get("kid"), str) or not header["kid"].strip():
        raise ValueError("Expected ES256 with a kid")
    key = jwks.get_signing_key_from_jwt(token)
    payload = jwt.decode(
        token,
        key.key,
        algorithms=["ES256"],
        issuer="space",  # JWT_ISSUER of your SPACE (default "space")
        audience=my_organization_id,
        options={"require": ["exp", "iss", "aud"]},
    )
    if (payload.get("organizationId") != my_organization_id
            or payload.get("userId") != expected_user_id):
        raise ValueError("Pricing token does not match the authenticated organization/user")
    return payload
```

### Java (Nimbus JOSE + JWT)

```java
var source = JWKSourceBuilder.create(new URL("https://space.example.com/api/v1/.well-known/jwks.json")).build();
var processor = new DefaultJWTProcessor<SecurityContext>();
processor.setJWSKeySelector(new JWSVerificationKeySelector<>(JWSAlgorithm.ES256, source));
processor.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(
    myOrganizationId, // aud
    new JWTClaimsSet.Builder().issuer("space").build(), // JWT_ISSUER of your SPACE (default "space")
    Set.of("exp", "iss", "aud")));
var header = SignedJWT.parse(token).getHeader(); // still untrusted
if (!JWSAlgorithm.ES256.equals(header.getAlgorithm())
    || header.getKeyID() == null || header.getKeyID().isBlank())
    throw new SecurityException("Expected ES256 with a kid");
JWTClaimsSet claims = processor.process(token, null);
if (!myOrganizationId.equals(claims.getStringClaim("organizationId"))
    || !expectedUserId.equals(claims.getStringClaim("userId")))
    throw new SecurityException("Pricing token does not match the authenticated organization/user");
```

### .NET 8+ (Microsoft IdentityModel)

The [runnable example](examples/pricing-token-dotnet/PricingTokenVerifier.cs) uses the official
`Microsoft.IdentityModel.JsonWebTokens` and `Microsoft.IdentityModel.Tokens` packages, pinned in its project.
It includes a reusable verifier, cached JWKS discovery, a 30-second refresh cooldown and strict validation.
Reuse the `HttpClient` and verifier for the lifetime of your application:

```csharp
using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
var verifier = new PricingTokenVerifier(http,
    new Uri("https://space.example.com/api/v1/.well-known/jwks.json"), "space");
// organizationId and expectedUserId come from YOUR authenticated application context.
var principal = await verifier.ValidateAsync(token, organizationId, expectedUserId);
```

The implementation checks `TokenValidationResult.IsValid`: `ValidateTokenAsync` can return failure without
throwing. It pins `ValidAlgorithms`, issuer and audience and checks the explicit organization/user claims.
See [Microsoft's validation API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.identitymodel.jsonwebtokens.jsonwebtokenhandler.validatetokenasync).
SPACE publishes JWKS, **not OpenID Connect discovery**: do not set ASP.NET `Authority` or `MetadataAddress` to
the raw JWKS URL. Use the configured verifier or wire its trusted key retrieval into your middleware.

Run from the repository root (the JWT is read from stdin, not passed on the command line):

```sh
dotnet restore docs/examples/pricing-token-dotnet/PricingTokenVerifier.csproj
cat token.txt | dotnet run --project docs/examples/pricing-token-dotnet -- \
  https://space.example.com/api/v1/.well-known/jwks.json space ORGANIZATION_ID USER_ID
```

On errors, reject authorization and handle the exception at your application's boundary; do not log raw tokens.
An unknown key shortly after a refresh can be rejected until the 30-second cooldown passes. Publish upcoming keys
before switching the signer to avoid that window. Valid cached keys remain usable while an unknown key is throttled;
expired cache entries are never used after a failed refresh. The example accepts loopback HTTP only for local tests.

To reproduce the interoperability checks with tokens generated by SPACE (no database required):

```sh
pnpm --dir api exec tsx src/test/utils/pricingTokenInteropFixtures.ts /tmp/space-token-fixtures.json
dotnet run --project docs/examples/pricing-token-dotnet -- --self-test /tmp/space-token-fixtures.json
```

Checks cover valid SPACE tokens, tampering, expiry, future `nbf`, missing expiry, wrong issuer/audience/user/organization,
unknown keys, HS256 rejection, old/new-key rotation, cache reuse and network failures. Fixtures are temporary public
keys and synthetic tokens; private test keys are never written. The same check runs in GitHub Actions.

## Operating the key

| Variable | Purpose |
| --- | --- |
| `PRICING_TOKEN_PRIVATE_KEY` | EC P-256 private key: PEM (PKCS#8 or SEC1, `\n` escapes accepted on one line) or a private JWK (its `kid` is kept). |
| `PRICING_TOKEN_PRIVATE_KEY_FILE` | Path to a file with that key (Docker/Kubernetes secret). `PRICING_TOKEN_PRIVATE_KEY` wins when both are set. |
| `PRICING_TOKEN_GENERATE_KEY` | `true`: create `PRICING_TOKEN_PRIVATE_KEY_FILE` (mode 0600) on first start if missing. Single instance with a persistent volume only. |
| `PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS` (`_FILE`) | Public keys published besides the current one: PEM `BEGIN PUBLIC KEY` blocks, a JWKS or a JSON array of JWKs. Private keys are refused. |
| `PRICING_TOKEN_ALG` | `ES256` (default) or `HS256`, the deprecated legacy mode (below). |

Generate a key:

```sh
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out pricing-token-key.pem
chmod 600 pricing-token-key.pem
```

Without a key, `ENVIRONMENT=development` and `ENVIRONMENT=testing` use a throw-away key generated per process (with
a warning; its tokens stop verifying on restart). Any other `ENVIRONMENT` (also an unset one) refuses to start. The
`kid` is the RFC 7638 thumbprint of the public key unless the configured private JWK supplies its own `kid`.
It stays the same across restarts with the same key and configuration. Every
instance of a server must use the same key: the docker compose files generate one into the `space-keys` volume
(one instance), and `k8s/deploy.sh` creates the `space-pricing-token-key` secret that all replicas mount.

### Rotation

1. Generate the next private key and publish its **public JWK** alongside the current key on **every replica**
   before it signs anything. Preserve its intended `kid`. Wait at least the JWKS cache lifetime (300 seconds)
   and account for your verifiers' refresh policy before switching.
2. Switch every replica to the new private key, publishing both old and new public keys throughout deployment.
   New tokens carry the new `kid`; cached tokens signed with the old key are re-issued on the next token request.
   Preserve the old key's original `kid` in `PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS` (or `_FILE`). A public JWKS is:
   `{"keys":[{"kty":"EC","crv":"P-256","x":"...","y":"...","kid":"original-kid","alg":"ES256","use":"sig"}]}`.
   Never copy the private JWK's `d` member. Exporting PEM with `openssl pkey -in old-key.pem -pubout` is suitable
   only when the original `kid` was the default thumbprint; PEM loses a custom JWK `kid`.
3. Remove the old public key only after the **last** old-key token has expired, plus the verifier clock skew
   and cache window. Measure from the last replica that stopped signing with it, using the maximum token lifetime
   actually issued, not just the new configuration's `JWT_EXPIRATION`.

If a private key leaks, replace it and remove its public key from JWKS. This does **not** instantly invalidate
all distributed tokens: clients may still have the old public key cached, and forged tokens can verify with it.
Purge/invalidate verifier caches and explicitly deny the compromised `kid` in affected applications; review tokens
and application sessions. Short token lifetimes and online checks reduce exposure. No verifier may silently fall
back to another algorithm or trust a key supplied by the token.

### Legacy HS256 mode

`PRICING_TOKEN_ALG=HS256` signs as SPACE versions before ES256 did (HMAC with a key derived from `JWT_SECRET` and
`JWT_SALT`), for host applications that still verify with the shared secret while they move to the JWKS. It logs a
deprecation warning, publishes no signing key and does not advertise `pricing-token-jwks`. Anyone who can verify
such tokens can also forge them, for every organization of the server.
