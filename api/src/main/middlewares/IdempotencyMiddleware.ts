import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import container from '../config/container';
import type IdempotencyKeyRepository from '../repositories/mongoose/IdempotencyKeyRepository';
import type { IdempotencyRecord, StoredResponse } from '../repositories/mongoose/IdempotencyKeyRepository';

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
 * - Stored: every response below 500 except 401, 403, 408 and 429, so that a
 *   retry gets the same answer as the first attempt. Not stored: 5xx (the
 *   request may not have run; a retry with the same key runs it again) and
 *   responses whose body exceeds `MAX_STORED_BODY_BYTES`.
 * - Records expire after `IDEMPOTENCY_KEY_TTL_SECONDS` (default 24 hours).
 *
 * Without the header the request is handled exactly as before. The middleware
 * is placed after authentication, permissions and validation, right before
 * the controller, so a caller only gets a replay of a request it may make.
 */

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** Response headers kept for a replay (besides status and body). */
const STORED_HEADERS = ['content-type', 'etag', 'x-total-count'];

/** Larger bodies are not stored: a retry runs the request again. */
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
      params: req.params,
      query: req.query as Record<string, unknown>,
      body: req.body,
      ifMatch: req.get('If-Match'),
    });

    const repository: IdempotencyKeyRepository = container.resolve('idempotencyKeyRepository');

    try {
      let reservation = await repository.reserve(organizationId, key, fingerprint, {
        ttlSeconds: idempotencyKeyTtlSeconds(),
        lockSeconds: LOCK_SECONDS,
      });

      if (!reservation.reserved) {
        let existing: IdempotencyRecord | null = reservation.existing;
        if (existing.fingerprint !== fingerprint) {
          return sendProblem(res, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request');
        }
        // The same request is running: wait for its response for a while.
        const deadline = Date.now() + waitMilliseconds();
        while (existing && existing.state === 'in_progress' && Date.now() < deadline) {
          await sleep(25);
          existing = await repository.find(organizationId, key);
        }
        if (existing?.state === 'completed' && existing.response) {
          if (existing.fingerprint !== fingerprint) {
            return sendProblem(res, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request');
          }
          return replay(res, existing.response);
        }
        if (existing) {
          return sendProblem(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed; retry later', 1);
        }
        // It was released (5xx) or expired meanwhile: this request runs it.
        reservation = await repository.reserve(organizationId, key, fingerprint, {
          ttlSeconds: idempotencyKeyTtlSeconds(),
          lockSeconds: LOCK_SECONDS,
        });
        if (!reservation.reserved) {
          return sendProblem(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed; retry later', 1);
        }
      }

      const { owner } = reservation;
      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        repository.release(organizationId, key, owner).catch(error => console.error('Idempotency key release failed', error));
      };

      // Store the response before it is sent, so that a client that got it
      // and retries anyway is replayed rather than run again.
      const send = res.send.bind(res);
      (res as any).send = (body?: any) => {
        if (settled || (typeof body !== 'string' && !Buffer.isBuffer(body) && body !== undefined)) {
          // Objects go through res.json, which calls send again with a string.
          return send(body);
        }
        settled = true;
        const status = res.statusCode;
        const text = body === undefined ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : body;
        if (!isStoredStatus(status) || Buffer.byteLength(text) > MAX_STORED_BODY_BYTES) {
          repository
            .release(organizationId, key, owner)
            .catch(error => console.error('Idempotency key release failed', error))
            .finally(() => send(body));
          return res;
        }
        const headers: Record<string, string> = {};
        for (const name of STORED_HEADERS) {
          const value = res.getHeader(name);
          if (value !== undefined) headers[name] = String(value);
        }
        repository
          .complete(organizationId, key, owner, { status, headers, body: text })
          .catch(error => console.error('Idempotency key completion failed', error))
          .finally(() => send(body));
        return res;
      };
      // A response written without send (Express's own error handler uses
      // end) is not stored: the key is given back so that a retry runs. A
      // client that disconnects does not release it: the request goes on and
      // its response is stored for the retry. A process that dies leaves the
      // key locked for LOCK_SECONDS, after which a retry takes it over.
      res.on('finish', release);
    } catch (error) {
      return next(error);
    }
    return next();
  };
}
