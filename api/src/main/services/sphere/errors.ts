/**
 * SPHERE does not list the requested version (or the service is not linked):
 * the version cannot be provided, which is not a failure of SPHERE.
 */
export class SphereVersionNotListedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SphereVersionNotListedError';
  }
}

/** SPHERE refused the API key of a service (401/403). Never contains the key. */
export class SphereAuthError extends Error {
  constructor(status: number) {
    super(`SPHERE rejected the API key of this service (${status}); check sphereApiKey`);
    this.name = 'SphereAuthError';
  }
}

/** SPHERE hides both missing resources and resources the caller cannot read. */
export class SphereResourceUnavailableError extends Error {
  constructor() {
    super('SPHERE pricing is unavailable or requires access');
    this.name = 'SphereResourceUnavailableError';
  }
}
