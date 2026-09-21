# SPACE development guide

## Stack and layout
SPACE uses TypeScript, Express, MongoDB, Redis, Awilix and React 19 with Vite and Tailwind CSS 4. Use pnpm. API code lives in `api/src/main`; the entry point is `index.ts`, initialized through `app.ts`. Frontend code uses `pages`, `components`, `api`, `hooks`, and `types` under `frontend/src`; do not introduce SPHERE's module structure here.

## Commands
- Root: `pnpm run install`, `pnpm run dev`, `pnpm run build`, `pnpm run test`.
- `pnpm run dev:setup` starts local MongoDB and Redis. Check ports before starting another project's containers.
- `pnpm run dev:setup:test` generates test environments and seeds MongoDB; only run against disposable test infrastructure.
- API: `pnpm exec vitest run path/to/test.ts`, `pnpm run lint`, `pnpm run build`.
- Frontend: `pnpm run lint`, `pnpm run build`.
- The API test script runs test files sequentially. Never seed or run integration tests against real user data. SPACE does not require SPHERE's MiniZinc tooling for normal operations.

## API changes
Define contracts in `api/docs/space-api-docs.yaml` before implementation. Routes handle authentication and request validation; controllers parse requests and format responses; services contain business logic; repositories own database access. Register services and repositories in `api/src/main/config/container.ts`. Update TypeScript types, seeders and idempotent migrations for schema changes. Optional additive fields must preserve legacy documents.

Keep organization isolation explicit. User API keys use organization-scoped routes and membership permissions; organization API keys use direct routes scoped to the authenticated organization. Management actions require OWNER, ADMIN or MANAGER as appropriate. Never derive authorization from a request body's organization ID.

## Contracts and synchronization
Do not reset billing periods or consumption during pricing synchronization. Preserve unrelated contracted services. Validate a whole migration before applying it; persist resumable execution state and use conditional writes. Invalidate service, pricing, contract, evaluation and pricing-token caches after changes; emit events only after persistence. Distributed JWTs cannot be silently revoked by clearing Redis.

SPHERE imports are snapshots. Retain only versions referenced by current contract bindings plus the applied target; history does not pin YAML copies. Cleanup must recheck references. Never bypass remote TLS validation or fetch arbitrary user-controlled origins.

## Tests and UI
Use isolated unit tests with mocked external services and integration tests with disposable MongoDB/Redis. Cover authorization, failure recovery, concurrent consumption, retention and all synchronization policies. Run relevant tests and both builds; distinguish existing failures from regressions.

Follow `DESIGN.md`. Reuse existing components and API helpers. Every clickable element must include `cursor-pointer`. Include dark-mode styles, accessible labels, keyboard focus, loading states and actionable errors. Do not expose implementation details in ordinary user flows.
