export interface User {
  username: string;
  identityAlias?: string;
  apiKey: string;
  role: 'ADMIN' | 'USER';
}