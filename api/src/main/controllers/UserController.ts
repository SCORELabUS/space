import { authProvider } from '../services/identity/config';
import container from '../config/container';
import UserService from '../services/UserService';
import { USER_ROLES } from '../types/permissions';

class UserController {
  private userService: UserService;

  constructor() {
    this.userService = container.resolve('userService');
    this.create = this.create.bind(this);
    this.authenticate = this.authenticate.bind(this);
    this.getCurrentUser = this.getCurrentUser.bind(this);
    this.getAll = this.getAll.bind(this);
    this.getByUsername = this.getByUsername.bind(this);
    this.update = this.update.bind(this);
    this.destroy = this.destroy.bind(this);
    this.regenerateApiKey = this.regenerateApiKey.bind(this);
    this.changeRole = this.changeRole.bind(this);
  }

  async create(req: any, res: any) {
    if (authProvider() === 'scoretech' && !req.user) {
      return res.status(403).json({ error: 'Local registration is disabled' });
    }
    try {
      const user = await this.userService.create(req.body, req.user);
      res.status(201).json(user);
    } catch (err: any) {
      if (err.name?.includes('ValidationError') || err.code === 11000) {
        res.status(422).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('permission error')) {
        res.status(403).send({ error: err.message });
      } else if (
        err.message.toLowerCase().includes('already') ||
        err.message.toLowerCase().includes('not found')
      ) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async authenticate(req: any, res: any) {
    if (authProvider() === 'scoretech') return res.status(403).json({ error: 'Use SCORETech Identity to sign in' });
    try {
      const { username, password } = req.body;
      const user = await this.userService.authenticate(username, password);
      res.json({ username: user.username, apiKey: user.apiKey, role: user.role });
    } catch (err: any) {
      res.status(401).send({ error: err.message });
    }
  }

  async getCurrentUser(req: any, res: any) {
    try {
      // req.user is populated by the authentication middleware
      if (!req.user) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const user = await this.userService.findByUsername(req.user.username, req.user);
      res.json({ username: user.username, role: user.role });
    } catch (err: any) {
      res.status(500).send({ error: err.message });
    }
  }

  async getAll(req: any, res: any) {
    try {
      let { q, limit, offset } = req.query;

      q = q ?? '';

      if (!req.user){
        return res.status(401).send({ error: 'Authentication required' });
      }

      if (q.length < 4 && req.user.role !== 'ADMIN') {
        return res.status(403).send({ error: 'PERMISSION ERROR: Only admins can retrieve the full user list without providing at least 4 characters in the search query' });
      }

      const searchLimit = limit ? parseInt(limit, 10) : 10;
      const searchOffset = offset ? parseInt(offset, 10) : 0;

      if (Number.isNaN(searchLimit) || searchLimit < 1 || searchLimit > 50) {
        return res.status(400).send({ error: 'INVALID DATA: Limit must be between 1 and 50' });
      }

      if (Number.isNaN(searchOffset) || searchOffset < 0) {
        return res
          .status(400)
          .send({ error: 'INVALID DATA: Offset must be a non-negative number' });
      }

      const users = await this.userService.getUsers(req.user, q, searchLimit, searchOffset);
      const total = await this.userService.countUsers(q);
      return res.json({
        data: users,
        pagination: {
          offset: searchOffset,
          limit: searchLimit,
          total,
          page: Math.floor(searchOffset / searchLimit) + 1,
          pages: Math.ceil(total / searchLimit),
        },
      });
    } catch (err: any) {
      res.status(500).send({ error: err.message });
    }
  }

  async getByUsername(req: any, res: any) {
    try {
      const user = await this.userService.findByUsername(req.params.username, req.user);
      res.json(user);
    } catch (err: any) {
      res.status(404).send({ error: err.message });
    }
  }

  async update(req: any, res: any) {
    try {
      const user = await this.userService.update(req.params.username, req.body, req.user);
      res.json(user);
    } catch (err: any) {
      if (err.name?.includes('ValidationError') || err.code === 11000) {
        res.status(422).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('permission error')) {
        res.status(403).send({ error: err.message });
      } else if (
        err.message.toLowerCase().includes('already') ||
        err.message.toLowerCase().includes('not found')
      ) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async regenerateApiKey(req: any, res: any) {
    try {
      const newApiKey = await this.userService.regenerateApiKey(req.params.username, req.user);
      res.json({ apiKey: newApiKey });
    } catch (err: any) {
      if (
        err.message.toLowerCase().includes('already') ||
        err.message.toLowerCase().includes('not found')
      ) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('permission error')) {
        res.status(403).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async changeRole(req: any, res: any) {
    try {
      const { role } = req.body;
      if (!USER_ROLES.includes(role)) {
        return res.status(400).send({ error: 'Rol no válido' });
      }

      const user = await this.userService.changeRole(req.params.username, role, req.user);
      res.json(user);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('permission error')) {
        res.status(403).send({ error: err.message });
      } else if (
        err.message.toLowerCase().includes('already') ||
        err.message.toLowerCase().includes('not found')
      ) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async destroy(req: any, res: any) {
    try {
      await this.userService.destroy(req.params.username, req.user);
      res.status(204).send();
    } catch (err: any) {
      if (
        err.message.toLowerCase().includes('already') ||
        err.message.toLowerCase().includes('not found')
      ) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('permission error')) {
        res.status(403).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }
}

export default UserController;
