# Retrying writes with Idempotency-Key

Generate a random key before a logical operation and retain it with that operation. Send exactly the same key, endpoint, parameters, body and If-Match on retries after a timeout, connection failure, 5xx, or IDEMPOTENCY_IN_PROGRESS. An intentional new operation needs a new key. Another request with the same organization/key but different input receives 409 IDEMPOTENCY_CONFLICT, including while the first worker is abandoned.

## Scope

The optional header covers feature evaluations that consume or revert, contract creation, individual/group novation, and every increment/reset on PUT /contracts/{userId}/usageLevels. It is not installed on DELETE, contact/billing changes, read-only evaluations, previews or token generation. Without the header, existing behavior is unchanged. Authentication and current permissions are checked before replay.

A consumptionId identifies an applied consumption for a refund. Idempotency-Key identifies the request before execution; a retried consumption returns its original consumptionId rather than creating a new consumption.

## Recovery and retention

A prepared immutable plan and stable contract identities are journaled before business writes. Each atomic contract mutation includes a private receipt and public afterimage. Its result is checkpointed before the receipt is acknowledged. Retrying an interrupted operation completes missing checkpoints and cache invalidation rather than repeating increments or novations. Legacy reverts freeze their selected consumptionId. Group novations freeze their original members and changes; they recover one contract at a time and are not globally atomic. Event notification attempts may repeat after a crash.

The 60-second worker lease is renewed while execution continues. MongoDB time fences contract writes and reservation ownership. A successor retains the same operation, fingerprint and progress. Completed HTTP status, body and selected headers are stored before success is sent; inability to confirm that persistence returns 503. A 5xx after a prepared action retains that action for a same-key retry.

Completed responses expire after IDEMPOTENCY_KEY_TTL_SECONDS (default 86400 seconds), counted from completion. Unfinished journals have no TTL because forgetting an uncertain write would allow it to execute twice. Do not manually delete a pending journal as a retry strategy. Responses above the 4 MiB storage bound fail closed while preserving their prepared operation. Contract receipts expose no recovery metadata in REST responses, lists or pricing tokens.

## Conflicting later changes and deletion

A saved novation keeps an internal version guard even without caller If-Match; a counter reset keeps its original period guard. If an unapplied step conflicts with a later change, 409 IDEMPOTENCY_STATE_CHANGED preserves that later state and reports current contractVersion and any group members already novated. Review current state and use a new key for a corrected action. Explicit caller preconditions retain 412 CONTRACT_CHANGED.

A different request may checkpoint an abandoned, already persisted receipt without applying the original plan's remaining changes. Deleting a contract first checkpoints any pending applied receipt; a late retry cannot recreate that deleted contract or apply an old delta to its replacement. Expiry of a completed HTTP replay does not extend the original consumptionId's refund retention.
