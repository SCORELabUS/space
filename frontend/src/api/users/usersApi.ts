import axios from "@/lib/axios";
import type { User } from "@/types/User";

const DEFAULT_TIMEOUT = 5000;

export async function getCurrentUser(apiKey: string): Promise<{ username: string; role: string }> {
  return axios
    .get('/users/me', {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      timeout: DEFAULT_TIMEOUT,
    })
    .then(response => response.data)
    .catch(error => {
      throw new Error(
        'Failed to fetch current user. ' + (error.response?.data?.error || error.message)
      );
    });
}

export async function getUsers(
  apiKey: string,
  offset: number = 0,
  limit: number = 10,
  query: string = ''
): Promise<{ data: User[]; pagination: { offset: number; limit: number; total: number; page: number; pages: number } }> {
  return axios
    .get('/users', {
      params: { offset, limit, q: query },
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      timeout: DEFAULT_TIMEOUT,
    })
    .then(response => response.data)
    .catch(error => {
      throw new Error(
        'Failed to fetch users. ' + (error.response?.data?.error || error.message)
      );
    });
}

export async function updateUsername(apiKey: string, oldUsername: string, newUsername: string) {
  return axios
    .put(
      `/users/${oldUsername}`,
      { username: newUsername },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        timeout: DEFAULT_TIMEOUT,
      }
    )
    .then(response => response.data)
    .catch(error => {
      throw new Error(
        'Failed to update username. ' + (error.response?.data?.error || error.message)
      );
    });
}

export async function changeUserRole(apiKey: string, username: string, newRole: 'ADMIN' | 'USER') {
  return axios
    .put(
      `/users/${username}/role`,
      { role: newRole },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        timeout: DEFAULT_TIMEOUT,
      }
    )
    .then(response => response.data)
    .catch(error => {
      throw new Error(
        'Failed to change user role. ' + (error.response?.data?.error || error.message)
      );
    });
}

export async function changeUserPassword(apiKey: string, username: string, newPassword: string) {
  return axios
    .put(
      `/users/${username}`,
      { password: newPassword },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        timeout: DEFAULT_TIMEOUT,
      }
    )
    .then(response => response.data)
    .catch(error => {
      throw new Error(
        'Failed to change user password. ' + (error.response?.data?.error || error.message)
      );
    });
}

export async function deleteUser(apiKey: string, username: string) {
  return axios
    .delete(`/users/${username}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      timeout: DEFAULT_TIMEOUT,
    })
    .then(response => response.data)
    .catch(error => {
      throw new Error(
        'Failed to delete user. ' + (error.response?.data?.error || error.message)
      );
    });
}

export async function createUser(apiKey: string, user: { username: string; password: string; role: 'ADMIN' | 'USER' }) {
  return axios
    .post('/users', user, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      timeout: DEFAULT_TIMEOUT,
    })
    .then(response => response.data)
    .catch(error => {
      throw new Error(
        'Failed to create user. ' + (error.response?.data?.error || error.message)
      );
    });
}

export async function registerUser(user: { username: string; password: string }) {
  return axios
    .post('/users', { ...user, role: 'USER' }, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: DEFAULT_TIMEOUT,
    })
    .then(response => response.data)
    .catch(error => {
      throw new Error(
        'Failed to register user. ' + (error.response?.data?.error || error.message)
      );
    });
}

export async function searchUsers(apiKey: string, query: string, limit: number = 10): Promise<{ data: Array<Pick<User, 'username' | 'identityAlias'> & { role?: string }>; pagination: {offset: number, total: number, limit: number, page: number, pages: number} }> {
  return axios
    .get('/users', {
      params: { q: query, limit },
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      timeout: DEFAULT_TIMEOUT,
    })
    .then(response => response.data)
    .catch(error => {
      throw new Error(
        'Failed to search users. ' + (error.response?.data?.error || error.message)
      );
    });
}