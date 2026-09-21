# SPHERE synchronization

SPACE can create a service from a public SPHERE pricing permanent link. Existing file and direct YAML URL imports remain independent manual sources.

## Deployment

1. Deploy SPHERE's permanent-identity migration and public pricing API first. Pause pricing writes while running its migration. Existing versions must receive a `pricingId`; never regenerate those IDs after sharing links.
2. Configure SPACE's `SPHERE_PUBLIC_URL` (for example `https://sphere.score.us.es`). Optional `SPHERE_API_URL` must use the same protocol and host and include the API prefix, normally `/api/v1`. In local development its port may differ, such as UI `http://localhost:5173` and API `http://localhost:8080/api/v1`.
3. Initially use `SPHERE_SYNC_ENABLED=false`. Create a linked service and use **Synchronize now** to verify connectivity and permissions.
4. Set `SPHERE_SYNC_ENABLED=true` and restart SPACE to enable periodic processing. The worker checks each service on a staggered five-minute schedule, with bounded sequential processing. Slow remote calls or a backlog can delay completion.
5. Disable periodic processing using the same flag without deleting services, contracts or snapshots. Manual synchronization remains available. Graceful SIGTERM/SIGINT shutdown waits for the current worker and closes events, Redis and MongoDB without deleting the database.

For local development only, `SPHERE_ALLOW_LOCAL_HTTP=true` permits an explicitly configured localhost HTTP origin. It is rejected in production. Run the projects on different API, UI, MongoDB and Redis ports. `SERVER_PORT` configures SPACE's API port. Never point development/test startup at production databases: legacy development initialization may seed or flush them.

SPACE's schema changes are additive. Existing services with no `source` field behave as manual services. Synchronization collections (`sphereRuns`, `sphereLeases`) are created by Mongoose; no existing contract or pricing needs a backfill. Seeders may omit these empty collections. The integration fixtures create representative linked services and runs.

## API

Creation uses the existing `POST /api/v1/organizations/{organizationId}/services` route for user keys, or `POST /api/v1/services` for organization keys:

```json
{
  "source": "sphere",
  "permanentUrl": "https://sphere.score.us.es/p/111111111111111111111111",
  "policy": "new_last"
}
```

Pick policies also require `selectedVersionId`, the immutable ID returned by SPHERE's public manifest. Do not pass a YAML URL, a collection link or a version label as that ID. A creation request cannot mix a file, direct YAML URL and SPHERE source.

SPACE supports the Pricing2Yaml versions bundled in its `pricing4ts` dependency. When the selected public source uses an older supported syntax, preview reports the source and target syntax version. The creation form requires an explicit acknowledgement before it stores the automatically upgraded YAML snapshot; administrators should review that snapshot after linking. Newer or unsupported syntax is rejected without creating a service. This acknowledgement is tied to the selected immutable SPHERE version ID, so changing the policy or selected version requires a fresh check.

Relative to either service collection route:

- `POST /sphere/preview`: resolve a permanent link and list public versions.
- `GET /{serviceName}/synchronization`: current configuration, retained versions and last execution.
- `PUT /{serviceName}/synchronization`: change policy/selection and queue reconciliation. Changing source identity is not supported.
- `POST /{serviceName}/synchronization/run`: request reconciliation; returns `202`. Poll the status endpoint for completion.

Organization keys need ALL or MANAGEMENT to mutate synchronization. EVALUATION may read status. User keys use organization routes with membership checks; OWNER, ADMIN and MANAGER may manage settings, and EVALUATOR may read them. The global permission table and route membership middleware both apply.

The frontend's **Add New Service** form offers file, YAML URL and SPHERE sources. Linked service details display state, applied target, last successful synchronization, retained versions and migration counts. Manual pricing upload/archive/delete and local renaming/moving of linked services are rejected; use synchronization settings. Converting existing manual services or switching pricing identity is outside v1.

## Policies

| API value | Existing bindings | New bindings | Target |
| --- | --- | --- | --- |
| `all_last` | Migrate | Forced target | Latest public pricing date |
| `new_last` | Keep version | Forced target | Latest public pricing date |
| `all_pick` | Migrate | Forced target | Selected public version ID |
| `new_pick` | Keep version | Forced target | Selected public version ID |

Adding a service to an existing contract is a new binding. The server enforces the target even when a client sends a different version. Invalid newly requested subscriptions fail validation; the automatic replacement rule applies only to migrations of existing subscriptions.

All migrations first try to preserve the exact plan/add-ons/quantities. If invalid, the fallback is the cheapest public plan with a finite nonnegative numeric price and a valid subscription without add-ons. Numeric strings are accepted; expressions and commercial text are not evaluated. Ties are resolved by plan ID. The interface warns about this behavior before selecting an All policy. If any required replacement is impossible, no contracts are migrated.

Billing dates remain unchanged during synchronization. Compatible usage counters and reset dates are preserved, including consumption above a new lower limit. New counters start with normal SPACE defaults; removed limits leave active state. Incompatible period, type, tracking or unit changes block migration. Other services in the same contract remain unchanged.

## Recovery and retention

The worker persists run state and obtains a renewable organization lease. Binding mutations coordinate with the worker; concurrent usage updates use conditional writes and retry. All migration is convergent, not a global database transaction: a technical failure after some contracts are migrated leaves `applying` state and resumes on retry. Contract history makes completed changes idempotent. Configuration changes wait until incomplete application is recovered.

`ready` means applied; `queued`/`checking`/`applying` indicate pending work. `blocked` requires correcting an incompatible pricing or configuration. `degraded` indicates unavailable/invalid remote content; existing local copies remain operational. Monitor `error`, `lastCheckedAt`, `lastSyncedAt`, the applied target and run counters. Logs report deferred worker errors without API keys.

The only retained snapshots are currently contracted versions plus the applied target. Expired contracts still count while their current binding exists. History alone does not retain YAML. Removed local historical pricing details can be read through the existing pricing-detail endpoint, which fetches public SPHERE content without persisting it. If SPHERE no longer exposes it, retrieval reports unavailability.

If the target disappears, becomes private, or SPHERE fails, SPACE keeps the applied target and permits new contracts with that copy. Last policies never automatically downgrade; they can advance to a later public version. Functional edits under an imported version ID are blocked. Renaming the SaaS or changing YAML mapping order does not change the functional fingerprint.

Cleanup rechecks bindings and removes obsolete database documents, YAML files and caches. Staged copies may briefly exist during an unfinished run. Periodic reconciliation also removes database-backed initial imports whose service was never created, using the organization lease to avoid racing service creation. Cache invalidation includes pricing, service, contract, feature evaluations and pricing tokens. Redis distributes pricing events across instances. JWTs already held by clients retain their existing refresh/expiration semantics; clearing server cache does not revoke them.

## Tests

Unit tests (no external services):

```sh
pnpm --dir api exec vitest run src/test/unit-tests
```

Opt-in integration tests use **only** `mongodb://127.0.0.1:27981/space_sphere_sync_test`; they delete that disposable database. Start a dedicated MongoDB on that port, never a tunnel to an existing deployment:

```sh
SPHERE_SYNC_TEST_MONGO=true pnpm --dir api exec vitest run src/test/sphere-sync.integration.test.ts
pnpm run build
```

Integration tests exercise all four policies, retention, fallback/blocking, remote outages, snapshot immutability, lease exclusion, recovery after a durable write, and concurrent consumption. Remote HTTP and cache/event effects are mocked there; database operations are real. The rest of SPACE's API suite additionally requires its disposable seeded MongoDB and Redis test environment.

The Redis integration suite uses only `redis://127.0.0.1:63991` and its own test keys. Run a dedicated disposable Redis instance on that port:

```sh
SPHERE_SYNC_TEST_REDIS=true pnpm --dir api exec vitest run src/test/sphere-redis.integration.test.ts
```

### Verification performed for this change

Both production builds and changed-file lint checks passed (existing hook/chunk-size warnings remain). The isolated suites passed 198 SPHERE tests and 76 SPACE tests. A separate cross-project HTTP smoke check used real SPHERE routes, real SPACE import/migration code and disposable MongoDB databases: private-version filtering, publishing a new public target, migration with preserved consumption/billing, retention, permanent-link renaming and offline operation passed. Cache and event effects were stubbed in that HTTP smoke check. Two additional tests against a disposable Redis instance verified contract/evaluation/pricing-token invalidation and event delivery between two API instances. Browser checks covered desktop/mobile, dark mode, the SPHERE form, All-policy warning, Escape dismissal and the service panel. The full legacy API suites were not run because they require their separate seeded test environment.
