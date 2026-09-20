import dotenv from 'dotenv';
import { createClient } from 'redis';
type CacheClient = ReturnType<typeof createClient>;
dotenv.config();

class CacheService {
  private redisClient: CacheClient | null = null;
  private readonly namespace = (process.env.REDIS_KEY_PREFIX ?? 'space:').replace(/:$/, '') + ':';

  constructor() {}

  setRedisClient(client: CacheClient) {
    this.redisClient = client;
  }

  private key(value: string) {
    return `${this.namespace}${value.toLowerCase()}`;
  }

  async close() {
    if (this.redisClient?.isOpen) await this.redisClient.quit();
    this.redisClient = null;
  }

  // --- Serialization Helpers ---

  // Transforms Maps into serializable objects
  private replacer(key: string, value: any) {
    if (value instanceof Map) {
      return {
        _dataType: 'Map', // Marca especial
        value: Array.from(value.entries()), // Guardamos como array de arrays para preservar tipos de llaves
      };
    }
    return value;
  }

  // If encountering the special Map marker, reconstruct the Map
  private reviver(key: string, value: any) {
    if (typeof value === 'object' && value !== null) {
      if (value._dataType === 'Map') {
        return new Map(value.value);
      }
    }
    return value;
  }

  // --------------------------------

  async get(key: string) {
    if (!this.redisClient) {
      throw new Error('Redis client not initialized');
    }

    const value = await this.redisClient?.get(this.key(key));

    // AÑADIDO: Pasamos this.reviver como segundo argumento
    return value ? JSON.parse(value, this.reviver) : null;
  }

  async set(key: string, value: any, expirationInSeconds: number = 300, replaceIfExists: boolean = false) {
    if (!this.redisClient) {
      throw new Error('Redis client not initialized');
    }

    // AÑADIDO: Serializamos usando el replacer para comparar y para guardar
    const stringValue = JSON.stringify(value, this.replacer);

    const previousValue = await this.redisClient?.get(this.key(key));
    
    // Comparamos contra el stringValue generado con nuestro replacer
    if (previousValue && previousValue !== stringValue && !replaceIfExists) {
      throw new Error('Value already exists in cache, please use a different key.');
    }

    await this.redisClient?.set(this.key(key), stringValue, {
      EX: expirationInSeconds,
    });
  }

  async match(keyLocationPattern: string): Promise<string[]> {
    if (!this.redisClient) {
      throw new Error('Redis client not initialized');
    }

    const normalizedPattern = this.key(keyLocationPattern.replace(/\*\*/g, '*'));
    const keys: string[] = [];

    for await (const key of this.redisClient.scanIterator({ MATCH: normalizedPattern })) {
      keys.push((key as string).slice(this.namespace.length));
    }

    return keys;
  }

  async del(key: string) {
    if (!this.redisClient) {
      throw new Error('Redis client not initialized');
    }

    if (key.endsWith('.*')) {
      const pattern = this.key(key.slice(0, -2));
      const keysToDelete = await this.redisClient.keys(`${pattern}*`);
      if (keysToDelete.length > 0) {
        await this.redisClient.del(keysToDelete);
      }
    } else {
      await this.redisClient.del(this.key(key));
    }
  }

  async delMany(keys: string[]): Promise<number> {
    if (!this.redisClient) {
      throw new Error('Redis client not initialized');
    }

    if (keys.length === 0) {
      return 0;
    }

    const keysToDelete: Set<string> = new Set();

    // Separate keys with patterns from exact keys
    const patternKeys = keys.filter(k => k.endsWith('.*'));
    const exactKeys = keys.filter(k => !k.endsWith('.*')).map(k => this.key(k));

    // Process exact keys
    exactKeys.forEach(key => keysToDelete.add(key));

    // Process pattern keys in a single batch
    if (patternKeys.length > 0) {
      const patterns = patternKeys.map(k => this.key(k.slice(0, -2)));

      for (const pattern of patterns) {
        const matchedKeys = await this.redisClient.keys(`${pattern}*`);
        matchedKeys.forEach(k => keysToDelete.add(k));
      }
    }

    // Delete all matched keys in a single operation
    if (keysToDelete.size > 0) {
      return await this.redisClient.del(Array.from(keysToDelete));
    }

    return 0;
  }
}

export default CacheService;
