import { beforeEach, describe, expect, it } from 'vitest';
import EventService from '../../main/services/EventService';

/**
 * Every event EventService emits carries `eventId` (UUIDv7) and `occurredAt`
 * (ISO 8601), next to the existing `code` and `details`, which are unchanged.
 * The Socket.IO server is replaced by a recorder, so this needs no database.
 */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Emitted = { namespace: string; room?: string; event: string; payload: any };

const recorder = (emitted: Emitted[]) => {
  const socket = {
    id: 'socket-1',
    data: { organizationId: 'org-1' },
    connected: true,
    emit: (event: string, payload: any) => emitted.push({
      namespace: '/contracts', room: 'organization:org-1', event, payload,
    }),
    disconnect() { this.connected = false; },
  };
  const namespaces = new Map(['/contracts', '/pricings'].map(namespace => [namespace, {
    sockets: new Map(namespace === '/contracts' ? [[socket.id, socket]] : []),
    emit: (event: string, payload: any) => emitted.push({ namespace, event, payload }),
  }]));
  return { socket, io: { of: (namespace: string) => namespaces.get(namespace)! } };
};

const contract = () => ({
  userContact: { userId: 'user-1', username: 'user-1' },
  organizationId: 'org-1',
  contractedServices: { petclinic: '2025-3-26' },
  subscriptionPlans: { petclinic: 'GOLD' },
  subscriptionAddOns: {},
  billingPeriod: {
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-01-31T00:00:00.000Z'),
    autoRenew: true,
    renewalDays: 30,
  },
  history: [],
});

const expectEnvelope = (payload: any, before: number, after: number) => {
  expect(payload.eventId).toMatch(UUID_V7);
  expect(payload.occurredAt).toMatch(ISO_8601_UTC);
  expect(new Date(payload.occurredAt).toISOString()).toBe(payload.occurredAt);
  const at = Date.parse(payload.occurredAt);
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(after);
};

describe('EventService event ids', () => {
  let service: EventService;
  let emitted: Emitted[];

  beforeEach(() => {
    service = new EventService();
    emitted = [];
    const { io, socket } = recorder(emitted);
    (service as any).io = io;
    (service as any).contractAuthorizers.set(socket, async () => 'org-1');
  });

  it('adds eventId and occurredAt to every contract event, keeping code and details', async () => {
    const before = Date.now();
    for (const code of ['CONTRACT_CREATED', 'CONTRACT_NOVATED', 'CONTRACT_RENEWED'] as const) {
      service.emitContractEvent(code, contract());
    }
    service.emitContractEvent('CONTRACT_DELETED', contract(), { deleted: true });
    const after = Date.now();
    expect(emitted).toHaveLength(0);
    await (service as any).contractDelivery;

    expect(emitted.map(e => e.payload.code)).toEqual([
      'CONTRACT_CREATED',
      'CONTRACT_NOVATED',
      'CONTRACT_RENEWED',
      'CONTRACT_DELETED',
    ]);
    for (const { namespace, room, event, payload } of emitted) {
      expect(namespace).toBe('/contracts');
      expect(room).toBe('organization:org-1');
      expect(event).toBe('message');
      expect(Object.keys(payload).sort()).toEqual(['code', 'details', 'eventId', 'occurredAt']);
      expect(Object.keys(payload.details).sort()).toEqual(['contractVersion', 'organizationId', 'services', 'userId']);
      expect(payload.details).toMatchObject({ userId: 'user-1', organizationId: 'org-1', services: ['petclinic'] });
      expectEnvelope(payload, before, after);
    }
    expect(emitted[3].payload.details.contractVersion).toBeNull();
  });

  it('uses the time of the persisted change when the caller gives it', async () => {
    const persistedAt = new Date('2026-10-27T10:00:00.123Z');

    service.emitContractEvent('CONTRACT_NOVATED', contract(), { occurredAt: persistedAt });
    await (service as any).contractDelivery;

    expect(emitted[0].payload.occurredAt).toBe('2026-10-27T10:00:00.123Z');
  });

  it('adds eventId and occurredAt to every pricing event, keeping code and details', () => {
    const before = Date.now();
    service.emitPricingCreatedMessage('petclinic', '1.0.0');
    service.emitPricingArchivedMessage('petclinic', '1.0.0');
    service.emitPricingActivedMessage('petclinic', '1.0.0');
    service.emitServiceDisabledMessage('petclinic');
    const after = Date.now();

    expect(emitted.map(e => [e.namespace, e.event, e.payload.code])).toEqual([
      ['/pricings', 'message', 'PRICING_CREATED'],
      ['/pricings', 'message', 'PRICING_ARCHIVED'],
      ['/pricings', 'message', 'PRICING_ACTIVED'],
      ['/pricings', 'message', 'SERVICE_DISABLED'],
    ]);
    for (const { payload } of emitted.slice(0, 3)) {
      expect(payload.details).toEqual({ serviceName: 'petclinic', pricingVersion: '1.0.0' });
    }
    expect(emitted[3].payload.details).toEqual({ serviceName: 'petclinic' });
    for (const { payload } of emitted) {
      expect(Object.keys(payload).sort()).toEqual(['code', 'details', 'eventId', 'occurredAt']);
      expectEnvelope(payload, before, after);
    }
  });

  it('gives every event its own id', async () => {
    for (let i = 0; i < 500; i++) {
      service.emitContractEvent('CONTRACT_NOVATED', contract());
      service.emitPricingCreatedMessage('petclinic', String(i));
    }

    await (service as any).contractDelivery;
    const ids = emitted.map(e => e.payload.eventId);
    expect(ids).toHaveLength(1000);
    expect(new Set(ids).size).toBe(1000);
  });
});
