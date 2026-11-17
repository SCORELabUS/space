import container from '../config/container.js';
import OrganizationService from '../services/OrganizationService.js';
import type { LeanOrganization } from '../types/models/Organization.js';

class OrganizationController {
  private organizationService: OrganizationService;

  constructor() {
    this.organizationService = container.resolve('organizationService');
    this.getAll = this.getAll.bind(this);
    this.getById = this.getById.bind(this);
    this.create = this.create.bind(this);
    this.addMember = this.addMember.bind(this);
    this.updateMemberRole = this.updateMemberRole.bind(this);
    this.update = this.update.bind(this);
    this.addApiKey = this.addApiKey.bind(this);
    this.removeApiKey = this.removeApiKey.bind(this);
    this.removeMember = this.removeMember.bind(this);
    this.delete = this.delete.bind(this);
  }

  private async organizationResponse(organization: LeanOrganization | null) {
    if (!organization) return null;
    const [response] = await this.organizationService.withIdentityAliases([organization]);
    return response;
  }

  async getAll(req: any, res: any) {
    try {
      let organizations;
      let total = 0;

      // SPACE admins can see all organizations with pagination
      if (req.user.role === 'ADMIN') {
        const { q, limit = 10, offset = 0 } = req.query;

        // Validate limit and offset
        const parsedLimit = parseInt(limit as string, 10);
        const parsedOffset = parseInt(offset as string, 10);

        if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
          return res.status(400).send({ error: 'INVALID DATA: Limit must be between 1 and 50' });
        }

        if (isNaN(parsedOffset) || parsedOffset < 0) {
          return res
            .status(400)
            .send({ error: 'INVALID DATA: Offset must be a non-negative number' });
        }

        const filters: any = {};
        if (q) {
          filters.name = q;
        }

        organizations = await this.organizationService.find(filters, parsedLimit, parsedOffset);
        total = await this.organizationService.count(filters);

        // Return paginated response
        const page = Math.floor(parsedOffset / parsedLimit) + 1;
        const pages = Math.ceil(total / parsedLimit) || 1;

        return res.json({
          data: await this.organizationService.withIdentityAliases(organizations),
          pagination: {
            offset: parsedOffset,
            limit: parsedLimit,
            total,
            page,
            pages,
          },
        });
      } else {
        // Non-admin users see organizations where they are owner or member (no pagination for now)
        organizations = await this.organizationService.findByUser(req.user.username);
        res.json({ data: await this.organizationService.withIdentityAliases(organizations) });
      }
    } catch (err: any) {
      if (err.message.includes('PERMISSION ERROR')) {
        return res.status(403).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }

  async getById(req: any, res: any) {
    try {
      const organizationId = req.params.organizationId;
      const organization = await this.organizationService.findById(organizationId);

      if (!organization) {
        return res.status(404).send({ error: `Organization with ID ${organizationId} not found` });
      }

      res.json(await this.organizationResponse(organization));
    } catch (err: any) {
      if (err.message.includes('PERMISSION ERROR')) {
        return res.status(403).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }

  async create(req: any, res: any) {
    try {
      const organizationData = req.body;
      const organization = await this.organizationService.create(organizationData, req.user);
      res.status(201).json(await this.organizationResponse(organization));
    } catch (err: any) {
      if (err.message.includes('PERMISSION ERROR')) {
        return res.status(403).send({ error: err.message });
      }
      if (err.message.includes('does not exist') || err.message.includes('not found')) {
        return res.status(400).send({ error: err.message });
      }
      if (err.message.includes('CONFLICT')) {
        return res.status(409).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }

  async addMember(req: any, res: any) {
    try {
      const organizationId = req.params.organizationId;
      const { username, role } = req.body;

      if (!organizationId) {
        return res.status(400).send({ error: 'organizationId query parameter is required' });
      }

      if (!username) {
        return res.status(400).send({ error: 'username field is required' });
      }

      await this.organizationService.addMember(organizationId, { username, role }, req.user);

      const updatedOrganization = await this.organizationService.findById(organizationId);
      res.json(await this.organizationResponse(updatedOrganization));
    } catch (err: any) {
      if (err.message.includes('PERMISSION ERROR')) {
        return res.status(403).send({ error: err.message });
      }
      if (err.message.includes('INVALID DATA')) {
        return res.status(400).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }

  async updateMemberRole(req: any, res: any) {
    try {
      const organizationId = req.params.organizationId;
      const username = req.params.username;
      const { role } = req.body;

      if (!organizationId) {
        return res.status(400).send({ error: 'organizationId query parameter is required' });
      }

      if (!username) {
        return res.status(400).send({ error: 'username field is required' });
      }

      await this.organizationService.updateMemberRole(organizationId, username, role, req.user);

      const updatedOrganization = await this.organizationService.findById(organizationId);
      res.json(await this.organizationResponse(updatedOrganization));
    } catch (err: any) {
      if (err.message.includes('PERMISSION ERROR')) {
        return res.status(403).send({ error: err.message });
      }
      if (err.message.includes('INVALID DATA')) {
        return res.status(400).send({ error: err.message });
      }
      if (err.message.includes('CONFLICT')) {
        return res.status(409).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }

  async update(req: any, res: any) {
    try {
      const organizationId = req.params.organizationId;
      const updateData = req.body;

      const organization = await this.organizationService.findById(organizationId);
      if (!organization) {
        return res.status(404).send({ error: `Organization with ID ${organizationId} not found` });
      }

      await this.organizationService.update(organizationId, updateData, req.user);

      const updatedOrganization = await this.organizationService.findById(organizationId);
      res.json(await this.organizationResponse(updatedOrganization));
    } catch (err: any) {
      if (err.message.includes('PERMISSION ERROR')) {
        return res.status(403).send({ error: err.message });
      }
      if (err.message.includes('INVALID DATA') || err.message.includes('does not exist')) {
        return res.status(400).send({ error: err.message });
      }
      if (err.message.includes('CONFLICT')) {
        return res.status(409).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }

  async addApiKey(req: any, res: any) {
    try {
      const organizationId = req.params.organizationId;
      const { scope } = req.body;

      if (!organizationId) {
        return res.status(400).send({ error: 'organizationId query parameter is required' });
      }

      if (!scope) {
        return res.status(400).send({ error: 'scope field is required' });
      }

      await this.organizationService.addApiKey(organizationId, scope, req.user);
      const updatedOrganization = await this.organizationService.findById(organizationId);

      res.json(await this.organizationResponse(updatedOrganization));
    } catch (err: any) {
      if (err.message.includes('PERMISSION ERROR')) {
        return res.status(403).send({ error: err.message });
      } else if (err.message.includes('INVALID DATA')) {
        return res.status(400).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }

  async removeApiKey(req: any, res: any) {
    try {
      const organizationId = req.params.organizationId;
      const apiKey = req.params.apiKey;

      if (!organizationId) {
        return res.status(400).send({ error: 'organizationId query parameter is required' });
      }

      if (!apiKey) {
        return res.status(400).send({ error: 'apiKey field is required' });
      }

      await this.organizationService.removeApiKey(organizationId, apiKey, req.user);
      const updatedOrganization = await this.organizationService.findById(organizationId);

      return res.json(await this.organizationResponse(updatedOrganization));
    } catch (err: any) {
      if (err.message.includes('PERMISSION ERROR')) {
        return res.status(403).send({ error: err.message });
      }
      if (err.message.includes('not found')) {
        return res.status(400).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }

  async removeMember(req: any, res: any) {
    try {
      const organizationId = req.params.organizationId;
      const username = req.params.username;
      const orgRole = req.user.orgRole;

      if (!organizationId) {
        return res.status(400).send({ error: 'organizationId parameter is required' });
      }

      if (!username) {
        return res.status(400).send({ error: 'username parameter is required' });
      }

      if (
        !['OWNER', 'ADMIN', 'MANAGER'].includes(orgRole) &&
        req.user.role !== 'ADMIN' &&
        username !== req.user.username
      ) {
        return res
          .status(403)
          .send({
            error:
              'PERMISSION ERROR: Only users with OWNER, ADMIN, or MANAGER role can remove members, unless the user is removing themselves',
          });
      }

      await this.organizationService.removeMember(organizationId, username, req.user);
      const updatedOrganization = await this.organizationService.findById(organizationId);

      res.json(await this.organizationResponse(updatedOrganization));
    } catch (err: any) {
      if (err.message.includes('PERMISSION ERROR')) {
        return res.status(403).send({ error: err.message });
      }
      if (err.message.includes('not found')) {
        return res.status(400).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }

  async delete(req: any, res: any) {
    try {
      const organizationId = req.params.organizationId;

      await this.organizationService.destroy(organizationId, req.user);

      res.status(204).json({ message: 'Organization deleted successfully' });
    } catch (err: any) {
      if (err.message.includes('PERMISSION ERROR')) {
        return res.status(403).send({ error: err.message });
      }
      if (err.message.includes('CONFLICT')) {
        return res.status(409).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }
}

export default OrganizationController;
