import { createHash } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import container from '../config/container';
import IdempotencyKeyRepository, { IdempotencyOwnershipError, type IdempotencyRecord, type StoredResponse } from '../repositories/mongoose/IdempotencyKeyRepository';
import { runIdempotencyExecution, type IdempotencyExecution } from '../services/idempotencyExecution';

/**
 * `Idempotency-Key` for writes that must not be applied twice when a client
 * retries them (consumptions, usage level increments, contract creation,
 * novations, reverts).
 *
 * - The key (1-255 characters) is scoped to the organization of the request:
 *   the organization of the API key or of the route (`user:<username>` for a
 *   platform ADMIN on a direct route without `organizationId`). Two
 *   organizations may use the same key independently.
 * - It is bound to a fingerprint of the canonical request: method, route,
 *   path parameters, query, JSON body and `If-Match`. The same key with the
 *   same request replays the stored status, body and `ETag`, with
 *   `Idempotent-Replayed: true`, without running the request again. The same
 *   key with another request answers `409 IDEMPOTENCY_CONFLICT`.
 * - Concurrent requests with the same key: the unique index on
 *   `{ organizationId, key }` lets exactly one run. The others wait for it a
 *   short while (`IDEMPOTENCY_WAIT_MS`, default 2 s) and replay its response,
 *   or answer `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After` if it is still
 *   running.
 * - Successful/final responses are persisted before sending. A storage or
 *   ownership failure answers 503, retaining a prepared operation for recovery.
 *   Transient responses never discard a prepared plan; a retry resumes it.
 * - Only completed records expire after `IDEMPOTENCY_KEY_TTL_SECONDS`
 *   (default 24 hours). In-progress records retain their operation identity,
 *   plan and checkpoints across lease takeover.
 *
 * Without the header the request is handled exactly as before. The middleware
 * is placed after authentication, permissions and validation, right before
 * the controller, so a caller only gets a replay of a request it may make.
 */

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** Response headers kept for a replay (besides status and body). */
const STORED_HEADERS = ['content-type', 'etag', 'x-total-count'];

/** Larger final responses cannot be acknowledged as safely replayable. */
export const MAX_STORED_BODY_BYTES = 4 * 1024 * 1024;

/** How long a running request holds its key before another may take it over. */
const LOCK_SECONDS = 60;

export function idempotencyKeyTtlSeconds(): number {
  const configured = Number(process.env.IDEMPOTENCY_KEY_TTL_SECONDS);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 24 * 3600;
}

function waitMilliseconds(): number {
  const configured = Number(process.env.IDEMPOTENCY_WAIT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 2000;
}

/** Statuses that are not about the operation but about the caller or the moment. */
const NOT_STORED = new Set([401, 403, 408, 429]);

export function isStoredStatus(status: number): boolean {
  return status < 500 && !NOT_STORED.has(status);
}

/** JSON with object keys sorted, so that `{a, b}` and `{b, a}` are the same request. */
export function canonicalJson(value: unknown): string {
  const canonical = (item: any): any => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object' && !(item instanceof Date)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map(key => [key, canonical(item[key])])
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value ?? null)) ?? 'null';
}

/** Fingerprint of the canonical request (`v1:` + SHA-256). */
export function requestFingerprint(request: {
  method: string;
  route: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  ifMatch?: string;
}): string {
  const material = canonicalJson({
    method: request.method.toUpperCase(),
    route: request.route,
    params: request.params ?? {},
    query: request.query ?? {},
    body: request.body ?? null,
    ifMatch: request.ifMatch ?? null,
  });
  return 'v1:' + createHash('sha256').update(material).digest('hex');
}

/** Scope of the key: see the module comment. Never taken from the body. */
function scopeOf(req: Request): string | undefined {
  const fromRoute = (req.params as any)?.organizationId;
  if (req.org?.id) return req.org.id;
  if (fromRoute) return String(fromRoute);
  const requested = req.query?.organizationId;
  if (typeof requested === 'string' && requested.length > 0) return requested;
  if (req.user?.username) return `user:${req.user.username}`;
  return undefined;
}

function sendProblem(res: Response, status: number, code: string, error: string, retryAfter?: number) {
  if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
  res.status(status).json({ error, code });
}

function replay(res: Response, response: StoredResponse) {
  for (const [name, value] of Object.entries(response.headers ?? {})) res.setHeader(name, value);
  res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
  res.status(response.status).send(response.body);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param options.when only requests for which it returns true are made
 *        idempotent (for example, an evaluation only when it consumes); the
 *        header is ignored on the others.
 */
export function idempotent(options: { when?: (req: Request) => boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.get(IDEMPOTENCY_KEY_HEADER);
    if (key === undefined || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (options.when && !options.when(req)) return next();
    if (key.length < 1 || key.length > 255) {
      return sendProblem(res, 400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must have between 1 and 255 characters');
    }
    const organizationId = scopeOf(req);
    if (!organizationId) return next();
    const fingerprint = requestFingerprint({
      method: req.method,
      route: `${req.baseUrl ?? ''}${req.route?.path ?? req.path}`,
      params: req.params, query: req.query as Record<string, unknown>, body: req.body,
      ifMatch: req.get('If-Match'),
    });
    const repository: IdempotencyKeyRepository = container.resolve('idempotencyKeyRepository');

    try {
      let reservation = await repository.reserve(organizationId, key, fingerprint, {
        ttlSeconds: idempotencyKeyTtlSeconds(), lockSeconds: LOCK_SECONDS,
      });
      if (!reservation.reserved) {
        let existing: IdempotencyRecord | null = reservation.existing;
        const deadline = Date.now() + waitMilliseconds();
        for (;;) {
          if (existing && existing.fingerprint !== fingerprint) {
            return sendProblem(res, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request');
          }
          if (existing?.state === 'completed' && existing.response) return replay(res, existing.response);
          if (!existing || existing.state !== 'in_progress' || Date.now() >= deadline) break;
          await sleep(25);
          existing = await repository.find(organizationId, key);
        }
        // A released key is new work; an expired worker lease resumes the
        // SAME durable operation. Only reserve decides ownership, using DB time.
        reservation = await repository.reserve(organizationId, key, fingerprint, {
          ttlSeconds: idempotencyKeyTtlSeconds(), lockSeconds: LOCK_SECONDS,
        });
        if (!reservation.reserved) {
          existing = reservation.existing;
          if (existing.fingerprint !== fingerprint) {
            return sendProblem(res, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request');
          }
          if (existing.state === 'completed' && existing.response) return replay(res, existing.response);
          return sendProblem(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed; retry later', 1);
        }
      }

      const { owner, record } = reservation;
      const execution: IdempotencyExecution & { ownershipLost?: boolean } = {
        organizationId, key, owner, operationId: record.operationId, repository, record,
      };
      let phase: 'active' | 'finalizing' | 'settled' = 'active';
      let ownershipLost = false;
      let renewing = false;
      const heartbeat = setInterval(() => {
        if (phase !== 'active' || ownershipLost || renewing) return;
        renewing = true;
        void repository.renew(organizationId, key, owner, LOCK_SECONDS).then(updated => {
          if (phase !== 'active') return;
          if (updated) execution.record = updated;
          else { ownershipLost = true; execution.ownershipLost = true; }
        }).catch(() => {
          if (phase === 'active') { ownershipLost = true; execution.ownershipLost = true; }
        }).finally(() => { renewing = false; });
      }, 20_000);
      heartbeat.unref();
      const originalSend = res.send.bind(res);
      const stopHeartbeat = () => clearInterval(heartbeat);
      const freshOwnership = async () => {
        if (ownershipLost) throw new IdempotencyOwnershipError();
        execution.record = await repository.assertOwned(organizationId, key, owner);
        return execution.record;
      };
      const preserveOrRelease = async () => {
        // Even after a failed heartbeat, yielding is safe if the database
        // confirms that this owner still holds the unexpired lease.
        const current = await repository.assertOwned(organizationId, key, owner);
        execution.record = current;
        if (Object.prototype.hasOwnProperty.call(current, 'plan')) {
          await repository.yieldLease(organizationId, key, owner);
        } else if (!await repository.release(organizationId, key, owner)) {
          throw new IdempotencyOwnershipError();
        }
      };
      const unavailable = (code = 'IDEMPOTENCY_UNAVAILABLE') => {
        if (res.headersSent || res.writableEnded || res.destroyed) return res;
        // The original response may have set these before send was intercepted.
        for (const header of ['content-length', 'content-encoding', 'etag', 'content-disposition', 'content-range', 'x-total-count', IDEMPOTENT_REPLAYED_HEADER]) {
          res.removeHeader(header);
        }
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Retry-After', '1');
        return originalSend(JSON.stringify({ code, error: 'The operation could not be safely acknowledged. Retry with the same Idempotency-Key.' }));
      };
      const finalize = async (body: any) => {
        const status = res.statusCode;
        const text = body == null ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
        const oversized = Buffer.byteLength(text) > MAX_STORED_BODY_BYTES;
        try {
          if (!isStoredStatus(status) || oversized) {
            await preserveOrRelease();
            if (oversized && status >= 200 && status < 400) unavailable('IDEMPOTENCY_RESPONSE_TOO_LARGE');
            else if (!res.headersSent && !res.writableEnded && !res.destroyed) originalSend(body);
            return;
          }
          await freshOwnership();
          const headers: Record<string, string> = {};
          for (const name of STORED_HEADERS) {
            const value = res.getHeader(name);
            if (value !== undefined) headers[name] = String(value);
          }
          const completed = await repository.complete(organizationId, key, owner, { status, headers, body: text }, idempotencyKeyTtlSeconds());
          if (!completed) throw new IdempotencyOwnershipError();
          if (!res.headersSent && !res.writableEnded && !res.destroyed) originalSend(body);
        } catch (error) {
          // Completion may have persisted before its acknowledgement was lost.
          // Rechecking ownership prevents deleting or yielding another worker's
          // key, or deleting a record that is already complete.
          await preserveOrRelease().catch(() => {});
          unavailable();
        } finally {
          phase = 'settled';
          stopHeartbeat();
        }
      };
      (res as any).send = (body?: any) => {
        if (phase !== 'active') return res;
        // Preserve Express 4's deprecated send(status) shorthand without
        // allowing that primitive response to bypass durable finalization.
        if (typeof body === 'number') {
          if (!Number.isInteger(body) || body < 100 || body > 999) throw new RangeError('Invalid status code');
          res.statusCode = body;
          if (!res.getHeader('Content-Type')) res.type('txt');
          body = STATUS_CODES[body];
        }
        // Express sends objects through json(), which re-enters this wrapper
        // with a serialized string. Null is an empty body in res.send().
        if (body !== null && body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
          return originalSend(body);
        }
        phase = 'finalizing';
        stopHeartbeat();
        void finalize(body);
        return res;
      };
      // end()/streamed errors can finish without calling send. Retain a
      // prepared operation; only an unused reservation may be deleted.
      res.once('finish', () => {
        if (phase !== 'active') return;
        phase = 'finalizing';
        stopHeartbeat();
        void preserveOrRelease().catch(() => {}).finally(() => { phase = 'settled'; });
      });
      // No close/disconnect release: work can finish after its client leaves,
      // and its durable outcome must remain available to a subsequent retry.
      return runIdempotencyExecution(execution, () => next());
    } catch (error) {
      return next(error);
    }
  };
}
