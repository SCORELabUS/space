# Sign in to SPACE with SCORETech Identity

SPACE reads `AUTH_PROVIDER=local|scoretech` at API startup. The default
`local` keeps password sign-in and the optional SPHERE sign-in configured in
[SPHERE sign-in](sphere-sign-in.md). The SPA reads `GET /api/v1/auth/config`,
so the same frontend build works with either mode.

In SCORETech Identity, register a confidential backend application for SPACE
with the authorization code flow and S256 PKCE. Set its exact callback to
`https://space.example.com/api/v1/auth/identity/callback` and configure any
application access requirements there. SPACE assigns its own roles and
organization permissions.

## Production Compose

Deploy the API and frontend from the same revision. On the managed machine,
merge these values into the existing `docker/production/.env`. Keep this file
private. The Compose server reads it at runtime.

```dotenv
AUTH_PROVIDER=scoretech
SPACE_HOST=https://space.score.us.es
SPACE_FRONTEND_URL=https://space.score.us.es/
SCORETECH_IDENTITY_ISSUER=https://sphere.score.us.es/identity/auth/realms/score
SCORETECH_IDENTITY_CLIENT_ID=<SPACE application client ID>
SCORETECH_IDENTITY_CLIENT_SECRET=<SPACE application client secret>
SCORETECH_LEGACY_PASSWORD_LOGIN=true
```

Use the actual public URLs of the deployment. Register the exact callback
`https://space.score.us.es/api/v1/auth/identity/callback` for this example.
The API must be served under the frontend's public origin. For a deployment at
`/space/`, keep `SPACE_HOST=https://space.score.us.es`, use `BASE_PATH=/space`
and `SPACE_FRONTEND_URL=https://space.score.us.es/space/`, and register
`https://space.score.us.es/space/api/v1/auth/identity/callback`. If
`ALLOWED_ORIGINS` is set, include the public origin without a path. The
optional `SCORETECH_IDENTITY_CALLBACK_URL` must match the derived public
callback. Set `SCORETECH_IDENTITY_ACCOUNT_URL` only if the account portal is
at a different URL from the one derived from the issuer. The server must be
able to reach the public issuer for discovery, JWKS, token exchange and
renewal. Existing outbound proxy settings apply. Loopback HTTP is supported
for development.

Before switching, verify that a SPACE administrator can use their existing
local password and that the deployment no longer uses a default admin
password. Changing `ADMIN_PASSWORD` in Compose only affects the first seed.
It does not reset an existing account's password.

From the deployed checkout:

```sh
cd docker/production
docker compose config --quiet
docker compose up -d --build space-server space-client nginx
docker compose ps
```

Open SPACE in a private browser window. Sign in to an existing account using
its SPACE password, connect its SCORETech Identity in Settings, sign out,
then sign in through SCORETech and confirm the account and organizations
are the same. Confirm that the public `/api/v1/auth/config` (with any path
prefix) reports `provider: scoretech`.

## Existing accounts

The main button signs in directly with SCORETech Identity. An existing
account with a local password can choose **Use an existing SPACE password**.
Under **Settings → Connect SCORETech Identity**, confirm the SPACE password
and authenticate with the desired SCORETech identity. The link is stored as
the verified issuer and subject on the existing account. A SCORETech
identity already linked elsewhere cannot be used. In managed mode, once an
account is linked its password stops working for browser sign-in. Set
`SCORETECH_LEGACY_PASSWORD_LOGIN=false` to retire the fallback for the
deployment after users have linked their accounts.

### Recover accounts that signed in through SPHERE

Run the recovery from the SPACE checkout on a machine with Docker Compose
access to the three production stacks. It reads the SPHERE user ID stored
in SPACE, the verified SCORETech binding on that SPHERE user, and the
matching account ID in SCORETech's `score` realm. It uses the existing
running containers and needs no additional environment variables. The
running SPACE API must already support SCORETech and have created its
unique identity index. The recovery can run while users are signed in.

```sh
bash docker/link-sphere-scoretech ../SPHERE ../SCORETech-identity
# Review the dry run, then apply the unambiguous links:
bash docker/link-sphere-scoretech ../SPHERE ../SCORETech-identity --apply
```

Replace the checkout paths if your directories differ. The dry run reads all
three databases and writes nothing. Apply only writes the verified identity
link on the original SPACE account, preserving its ID, roles, organizations,
password and API keys. It never overwrites a link. Run the dry run again to
confirm that recovered accounts are now counted as `alreadyLinked`. Users
can then sign in with SCORETech immediately.

`noSphereLink` means the original SPHERE user is absent or lacks a verified
SCORETech link. `missingInIdentity` means the binding has no corresponding
account ID in the current SCORETech realm. A copy of the user record or a
matching email is insufficient. Resolve those cases and any reported conflicts
individually. A SPACE administrator can verify the owner and set a unique
temporary password on the existing SPACE account if manual linking is needed.

The browser receives an opaque HttpOnly SPACE session cookie. Redis stores
the refresh token. Once a verification is a minute old, the next authenticated request
renews it with SCORETech Identity. SPACE logout ends the local session and
requests revocation for its refresh token. It leaves the user's central
sign-in available to other applications. The existing API keys still
authenticate programmatic requests and event subscriptions.

To revert, set `AUTH_PROVIDER=local` in `docker/production/.env` and run
`docker compose up -d --no-deps --force-recreate space-server` from that
directory. Reload the browser. Existing local passwords and any configured
SPHERE login work again. Account links and persistent volumes remain in place.
