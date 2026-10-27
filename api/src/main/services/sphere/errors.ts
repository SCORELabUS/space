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
