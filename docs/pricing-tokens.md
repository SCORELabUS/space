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

## Verifying a token

Configure the JWKS URL of your SPACE yourself and **pin the algorithm**. Never take a key or key URL from the token
(`jwk`, `jku`, `x5u` headers) and never accept `alg: none` or `HS256`.

### Node.js / browser (`jose`)

```js
import { createRemoteJWKSet, jwtVerify } from 'jose';

const SPACE_JWKS = createRemoteJWKSet(new URL('https://space.example.com/api/v1/.well-known/jwks.json'));

export async function verifyPricingToken(token, myOrganizationId) {
  const { payload } = await jwtVerify(token, SPACE_JWKS, {
    algorithms: ['ES256'],
    issuer: 'space', // JWT_ISSUER of your SPACE (default "space")
    audience: myOrganizationId, // aud is the organization of the contract
    requiredClaims: ['exp', 'iss', 'aud'],
  });
  // aud and organizationId name the same organization.
  if (payload.organizationId !== myOrganizationId) throw new Error('Pricing token of another organization');
  return payload; // the user is payload.userId; sub is an opaque URN
}
```

`createRemoteJWKSet` caches the keys and refetches them when a token names an unknown `kid`, so key rotations need
no change on the verifier. The same code runs in browsers (WebCrypto supports ES256 everywhere).

### Python (PyJWT with `cryptography`)

```python
import jwt

jwks = jwt.PyJWKClient("https://space.example.com/api/v1/.well-known/jwks.json")

def verify_pricing_token(token: str, my_organization_id: str) -> dict:
    key = jwks.get_signing_key_from_jwt(token)
    payload = jwt.decode(
        token,
        key.key,
        algorithms=["ES256"],
        issuer="space",  # JWT_ISSUER of your SPACE (default "space")
        audience=my_organization_id,
        options={"require": ["exp", "iss", "aud"]},
    )
    if payload.get("organizationId") != my_organization_id:
        raise ValueError("Pricing token of another organization")
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
JWTClaimsSet claims = processor.process(token, null);
if (!myOrganizationId.equals(claims.getStringClaim("organizationId"))) throw new SecurityException("other organization");
```

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
`kid` is the RFC 7638 thumbprint of the public key, so it stays the same across restarts with the same key. Every
instance of a server must use the same key: the docker compose files generate one into the `space-keys` volume
(one instance), and `k8s/deploy.sh` creates the `space-pricing-token-key` secret that all replicas mount.

### Rotation

1. Generate the new key. Optionally publish it first, before it signs anything: add its public key
   (`openssl pkey -in new-key.pem -pubout`) to `PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS`, deploy, and wait five minutes
   (the JWKS `max-age`) so that HTTP caches in front of verifiers have it.
2. Switch: set the new private key, and put the public key of the old one (`openssl pkey -in old-key.pem -pubout`)
   in `PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS`. New tokens carry the new `kid`; tokens of the old key that SPACE had
   cached are re-issued on the next request.
3. After `JWT_EXPIRATION` (plus the five minutes of JWKS caching) no valid token of the old key is left: remove it
   from `PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS`.

If a private key leaks, switch to a new key and remove the leaked public key at once: its tokens stop verifying
immediately and clients fetch new ones.

### Legacy HS256 mode

`PRICING_TOKEN_ALG=HS256` signs as SPACE versions before ES256 did (HMAC with a key derived from `JWT_SECRET` and
`JWT_SALT`), for host applications that still verify with the shared secret while they move to the JWKS. It logs a
deprecation warning, publishes no signing key and does not advertise `pricing-token-jwks`. Anyone who can verify
such tokens can also forge them, for every organization of the server.
