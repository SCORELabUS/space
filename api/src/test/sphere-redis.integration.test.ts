import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createClient } from 'redis';
import { io, Socket } from 'socket.io-client';
import CacheService from '../main/services/CacheService';
import EventService from '../main/services/EventService';

describe('synchronization cache and events with isolated Redis', () => {
  const cache = new CacheService();
  const publisher = new EventService(), receiver = new EventService();
  const servers: Server[] = [];
  const previousUrl = process.env.REDIS_URL;
  let client: Socket;
  beforeAll(async () => {
    process.env.REDIS_URL = previousUrl ?? 'redis://127.0.0.1:6379';
    const redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect(); cache.setRedisClient(redis);
    for (const service of [publisher, receiver]) {
      const server = createServer(); servers.push(server);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      await service.initialize(server);
    }
    client = io(`http://127.0.0.1:${(servers[1].address() as AddressInfo).port}/pricings`, { path: '/events', transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  });
  afterAll(async () => {
    client?.close();
    await publisher.close(); await receiver.close();
    await cache.del('features.sphere-redis-test.*');
    await cache.del('contracts.sphere-redis-test');
    await cache.close();
    if (previousUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previousUrl;
  });
  it('invalidates the contract, evaluations and cached pricing token together', async () => {
    const keys = ['contracts.sphere-redis-test', 'features.sphere-redis-test.eval', 'features.sphere-redis-test.eval.feature', 'features.sphere-redis-test.pricingToken'];
    for (const key of keys) await cache.set(key, { old: true }, 60, true);
    await cache.del('contracts.sphere-redis-test');
    await cache.del('features.sphere-redis-test.*');
    for (const key of keys) expect(await cache.get(key)).toBeNull();
  });
  it('delivers the persisted-pricing event to clients of another API instance', async () => {
    const message = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Redis event delivery timed out')), 4000);
      client.once('message', value => { clearTimeout(timeout); resolve(value); });
    });
    publisher.emitPricingActivedMessage('sphere-redis-test', '2.0');
    expect(await message).toMatchObject({ code: 'PRICING_ACTIVED', details: { serviceName: 'sphere-redis-test', pricingVersion: '2.0' } });
  });
});
