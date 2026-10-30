import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server } from 'http';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { LeanOrganization, OrganizationMember } from '../types/models/Organization';
import { computeContractVersion } from '../utils/contracts/version';

export type ContractEventCode = 'CONTRACT_CREATED' | 'CONTRACT_NOVATED' | 'CONTRACT_DELETED' | 'CONTRACT_RENEWED';

/** Payload of the `message` events of the `/contracts` namespace. */
export interface ContractEvent {
  code: ContractEventCode;
  details: { userId: string; organizationId: string; contractVersion: string | null; services: string[] };
}

/** Socket.IO room of an organization in the `/contracts` namespace. */
const organizationRoom = (organizationId: string) => `organization:${organizationId}`;

/**
 * Organization a `/contracts` connection may listen to. Organization API keys
 * (any scope) listen to their organization; user API keys must name, in the
 * handshake (`auth.organizationId` or `organizationId` query parameter), an
 * organization they own or are a member of (platform ADMIN users: any).
 */
async function authorizeContractEvents(handshake: any): Promise<string> {
  // Loaded lazily: the container registers this service, so a static import would be circular.
  const container = (await import('../config/container')).default;
  const { rejectionOrOutage, InvalidApiKeyError } = await import('../middlewares/AuthMiddleware');
  /**
   * A lookup that tells a refused credential (`InvalidApiKeyError`, with
   * `invalid` as the message) apart from a database that cannot answer, which
   * is reported as unavailable, as the HTTP middleware answers 503.
   */
  const lookup = async <T>(run: () => Promise<T>, invalid: string): Promise<T> => {
    try {
      return await rejectionOrOutage(run, invalid);
    } catch (error) {
      if (error instanceof InvalidApiKeyError) throw new Error(invalid);
      throw new Error('Authentication is temporarily unavailable; retry shortly');
    }
  };
  const header = handshake.headers?.['x-api-key'];
  const apiKey: unknown = handshake.auth?.apiKey ?? (Array.isArray(header) ? header[0] : header);

  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('API Key not found. Connect with auth: { apiKey } or an x-api-key header');
  }

  if (apiKey.startsWith('org_')) {
    const organization: LeanOrganization = await lookup(
      () => container.resolve('organizationRepository').findByApiKey(apiKey),
      'Invalid Organization API Key'
    );
    if (!organization?.id) throw new Error('Invalid Organization API Key');
    return String(organization.id);
  }

  if (apiKey.startsWith('usr_')) {
    const user: any = await lookup(
      () => container.resolve('userService').findByApiKey(apiKey),
      'Invalid User API Key'
    );
    const organizationId = handshake.auth?.organizationId ?? handshake.query?.organizationId;
    if (typeof organizationId !== 'string' || !organizationId) {
      throw new Error('User API keys must name the organization: auth: { apiKey, organizationId }');
    }
    let organization: LeanOrganization | null = null;
    try {
      organization = await container.resolve('organizationService').findById(organizationId);
    } catch {
      organization = null;
    }
    const isMember = organization && (organization.owner === user.username ||
      organization.members?.some((member: OrganizationMember) => member.username === user.username));
    if (!organization || (!isMember && user.role !== 'ADMIN')) {
      throw new Error('You are not a member of this organization');
    }
    return String(organization.id ?? organizationId);
  }

  throw new Error('Invalid API Key format. API Keys must start with "usr_" or "org_"');
}

/**
 * Servicio encargado de gestionar eventos en tiempo real usando WebSockets.
 * Este servicio permite emitir eventos a los clientes conectados.
 */
class EventService {
  private io: SocketIOServer | null = null;
  private pubClient?: ReturnType<typeof createClient>;
  private subClient?: ReturnType<typeof createClient>;
  // Credentials stay in this process; socket.data and Redis carry no API key.
  private contractAuthorizers = new WeakMap<Socket, () => Promise<string>>();
  private contractDelivery: Promise<void> = Promise.resolve();

  /**
   * Inicializa el servicio de eventos con un servidor HTTP.
   * @param server - El servidor HTTP de la aplicación
   */
  async initialize(server: Server): Promise<void> {
    this.io = new SocketIOServer(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      },
      path: '/events',
      transports: ['websocket']
    });

    // Configuración del adaptador Redis para Socket.IO
    if (process.env.REDIS_URL) {
      this.pubClient = createClient({ url: process.env.REDIS_URL });
      this.subClient = this.pubClient.duplicate();
      this.pubClient.on('error', error => console.error('Event publisher', error.message));
      this.subClient.on('error', error => console.error('Event subscriber', error.message));
      await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
      this.io.adapter(createAdapter(this.pubClient, this.subClient, {
        key: process.env.REDIS_SOCKET_KEY ?? 'space:socket.io'
      }));
    }

    this.setupEventHandlers();
    this.setupContractEvents();
  }

  /**
   * `/contracts` namespace: authenticated, and each connection only joins the
   * room of its organization, so it only receives that organization's events.
   */
  private setupContractEvents(): void {
    if (!this.io) return;

    const io = this.io;
    const contracts = io.of('/contracts');

    contracts.use((socket, next) => {
      const header = socket.handshake.headers['x-api-key'];
      const proof = Object.freeze({ auth: Object.freeze({
        apiKey: socket.handshake.auth?.apiKey ?? (Array.isArray(header) ? header[0] : header),
        organizationId: socket.handshake.auth?.organizationId ?? socket.handshake.query?.organizationId,
      }) });
      const authorize = () => authorizeContractEvents(proof);
      authorize()
        .then(organizationId => {
          if (this.io !== io || socket.conn.readyState !== 'open') {
            next(new Error('Connection closed during authentication'));
            return;
          }
          socket.data.organizationId = organizationId;
          this.contractAuthorizers.set(socket, authorize);
          next();
        })
        .catch((error: Error) => next(new Error(error.message)));
    });

    contracts.on('connection', socket => {
      socket.join(organizationRoom(socket.data.organizationId));
      socket.once('disconnect', () => this.contractAuthorizers.delete(socket));
    });

    // Inter-server messages never bypass the recipient instance's authorization.
    contracts.on('contract-event', (event: ContractEvent) => this.queueContractEvent(event));
    contracts.on('contract-access-changed', () => {
      void this.revalidateLocalContractConnections().catch(error => {
        console.error('Contract connections could not be revalidated', (error as Error).message);
      });
    });
  }

  private async contractSocketAuthorized(socket: Socket): Promise<boolean> {
    const authorize = this.contractAuthorizers.get(socket);
    if (!authorize || !socket.connected || !this.io) return false;
    try {
      const organizationId = await authorize();
      // A concurrent revocation/close may have disconnected it during the read.
      if (!socket.connected || !this.io || this.contractAuthorizers.get(socket) !== authorize) return false;
      if (organizationId === socket.data.organizationId) return true;
    } catch {
      // Lost authority or an unavailable database: do not deliver private data.
    }
    socket.disconnect();
    return false;
  }

  private async revalidateLocalContractConnections(): Promise<void> {
    const contracts = this.io?.of('/contracts');
    if (!contracts) return;
    await Promise.all([...contracts.sockets.values()].map(socket => this.contractSocketAuthorized(socket)));
  }

  /** Called after persisted key, membership, ownership or user authority changes. */
  async revalidateContractConnections(): Promise<void> {
    if (!this.io) return;
    try {
      if (this.pubClient?.isReady) this.io.of('/contracts').serverSideEmit('contract-access-changed');
    } catch (error) {
      console.error('Contract access change could not be broadcast', (error as Error).message);
    }
    // A failed control broadcast must still revalidate this instance. Other
    // instances independently recheck permission before their next delivery.
    try {
      await this.revalidateLocalContractConnections();
    } catch (error) {
      console.error('Contract connections could not be revalidated', (error as Error).message);
    }
  }

  private queueContractEvent(event: ContractEvent): void {
    const io = this.io;
    this.contractDelivery = this.contractDelivery.then(async () => {
      if (!io || this.io !== io) return;
      const sockets = [...io.of('/contracts').sockets.values()]
        .filter(socket => socket.data.organizationId === event.details.organizationId);
      await Promise.all(sockets.map(async socket => {
        if (await this.contractSocketAuthorized(socket) && this.io === io && socket.connected) {
          socket.emit('message', event);
        }
      }));
    }).catch(error => {
      // One failed notification must not poison the queue or fail a mutation.
      console.error('Contract event could not be delivered', (error as Error).message);
    });
  }

  /**
   * Emit a contract event to the connections of the contract's organization.
   * Call it after the change is persisted. It never throws: a notification
   * failure must not fail the change that was already made.
   */
  emitContractEvent(code: ContractEventCode, contract: any, options: { deleted?: boolean } = {}): void {
    try {
      if (!this.io || !contract?.organizationId || !contract?.userContact?.userId) return;
      const contractedServices = contract.contractedServices instanceof Map
        ? Object.fromEntries(contract.contractedServices)
        : contract.contractedServices ?? {};
      const event: ContractEvent = {
        code,
        details: {
          userId: contract.userContact.userId,
          organizationId: String(contract.organizationId),
          contractVersion: options.deleted ? null : computeContractVersion(contract),
          services: Object.keys(contractedServices),
        },
      };
      this.queueContractEvent(event);
      if (this.pubClient?.isReady) this.io.of('/contracts').serverSideEmit('contract-event', event);
    } catch (error) {
      console.error('Contract event could not be emitted', (error as Error).message);
    }
  }

  async close() {
    const io = this.io;
    this.io = null;
    this.contractAuthorizers = new WeakMap();
    if (io) await new Promise<void>(resolve => io.close(() => resolve()));
    if (this.pubClient?.isOpen) await this.pubClient.quit();
    if (this.subClient?.isOpen) await this.subClient.quit();
  }

  /**
   * Configura los manejadores de eventos para las conexiones de WebSockets.
   */
  private setupEventHandlers(): void {
    if (!this.io) return;

    // Namespace para eventos relacionados con pricings
    const pricingsNamespace = this.io.of('/pricings');

    pricingsNamespace.on('connection', (socket) => {
      console.log(`New client connected to pricing events: ${socket.id}`);

      socket.on('disconnect', () => {
        console.log(`Client disconnected from pricing events: ${socket.id}`);
      });
    });
  }

  /**
   * Emits a pricing change event to all connected clients.
   * @param serviceName - Name of the service to which the pricing belongs
   * @param pricingVersion - Version of the pricing that has changed
   */
  emitPricingCreatedMessage(serviceName: string, pricingVersion: string): void {
    if (!this.io) {
      console.error('Websocket server is not initialized');
      return;
    }

    this.io.of('/pricings').emit('message', {
      code: 'PRICING_CREATED',
      details: {
        serviceName,
        pricingVersion
      }
    });
  }

  emitPricingArchivedMessage(serviceName: string, pricingVersion: string): void {
    if (!this.io) {
      console.error('Websocket server is not initialized');
      return;
    }

    this.io.of('/pricings').emit('message', {
      code: 'PRICING_ARCHIVED',
      details: {
        serviceName,
        pricingVersion
      }
    });
  }

  emitPricingActivedMessage(serviceName: string, pricingVersion: string): void {
    if (!this.io) {
      console.error('Websocket server is not initialized');
      return;
    }

    this.io.of('/pricings').emit('message', {
      code: 'PRICING_ACTIVED',
      details: {
        serviceName,
        pricingVersion
      }
    });
  }

  emitServiceDisabledMessage(serviceName: string): void {
    if (!this.io) {
      console.error('Websocket server is not initialized');
      return;
    }

    this.io.of('/pricings').emit('message', {
      code: 'SERVICE_DISABLED',
      details: {
        serviceName
      }
    });
  }
}

export default EventService;
