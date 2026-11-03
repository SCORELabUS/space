import { toPlainObject } from '../../utils/mongoose';
import RepositoryBase from '../RepositoryBase';
import UserMongoose from './models/UserMongoose';
import { LeanUser } from '../../types/models/User';
import { UserRole } from '../../types/permissions';
import { generateUserApiKey } from '../../utils/users/helpers';

class UserRepository extends RepositoryBase {
  async findBySphereIdentity(issuer: string, subject: string): Promise<LeanUser | null> {
    const user = await UserMongoose.findOne({ 'sphereIdentity.issuer': issuer, 'sphereIdentity.subject': subject });
    return user ? user.toObject({ virtuals: true }) as unknown as LeanUser : null;
  }

  async sphereConnection(userId: string) {
    const user = await UserMongoose.findById(userId).select('+sphereIdentity');
    if (!user) throw new Error('User no longer exists');
    return { linked: Boolean(user.sphereIdentity), hasPassword: Boolean(user.password) };
  }

  async linkSphereIdentity(userId: string, issuer: string, subject: string) {
    return UserMongoose.findOneAndUpdate({ _id: userId, sphereIdentity: { $exists: false } },
      { $set: { sphereIdentity: { issuer, subject } } }, { new: true });
  }

  async deleteCreatedFederatedUser(userId: string) {
    await UserMongoose.deleteOne({ _id: userId, password: { $exists: false } });
  }


  async findAll(query?: any): Promise<LeanUser[]> {
    try {
      const users = await UserMongoose.find(query || {}, { password: 0, apiKey: 0 }).exec();
      return users.map(user => user.toObject({ getters: true, virtuals: true, versionKey: false }) as unknown as LeanUser);
    } catch (err) {
      return [];
    }
  }

  async find(username: string, limit: number = 10, offset: number = 0): Promise<LeanUser[]> {
    try {
      const users = await UserMongoose.find({ username: { $regex: username, $options: 'i' } }).select({ password: 0 }).skip(offset).limit(limit).exec();
      return users.map(user => user.toObject({ getters: true, virtuals: true, versionKey: false }) as unknown as LeanUser);
    } catch (err) {
      return [];
    }
  }

  async count(query: string = '') {
    try {
      return await UserMongoose.countDocuments({ username: { $regex: query, $options: 'i' } });
    } catch (err) {
      return 0;
    }
  }
  
  async findByUsername(username: string): Promise<LeanUser | null> {
    try {
      const user = await UserMongoose.findOne({ username })
        .select({ password: 0 })
        .exec();

      if (!user) return null;

      return user.toObject({ getters: true, virtuals: true, versionKey: false }) as unknown as LeanUser;
    } catch (err) {
      return null;
    }
  }

  async findByRole(role: UserRole): Promise<LeanUser[]> {
    try {
      const users = await UserMongoose.find({ role: role }, { password: 0, apiKey: 0 }).exec();
      return users.map(user => user.toObject({ getters: true, virtuals: true, versionKey: false }) as unknown as LeanUser);
    } catch (err) {
      return [];
    }
  }

  async authenticate(username: string, password: string): Promise<LeanUser | null> {
    const user = await UserMongoose.findOne({ username }).exec();

    if (!user) return null;

    const isPasswordValid = await user.verifyPassword(password);

    if (!isPasswordValid) return null;

    const leanUser = toPlainObject<LeanUser>(user.toJSON());

    if (!leanUser.apiKey) {
      // If the user does not have an API key, we generate one
      const newApiKey = generateUserApiKey();
      await UserMongoose.updateOne({ username }, { apiKey: newApiKey });
      leanUser.apiKey = newApiKey;
      
      return leanUser;
    }

    return leanUser;
  }

  async findByApiKey(apiKey: string) {
    const user = await UserMongoose.findOne({ apiKey: apiKey });

    if (!user) return null;

    return toPlainObject<LeanUser>(user.toObject({ virtuals: true }));
  }

  async create(userData: any): Promise<LeanUser> {
    const user = await new UserMongoose(userData).save();
    const userObject = await this.findByUsername(user.username);

    return userObject!;
  }

  async update(username: string, userData: any) {
    const updatedUser = await UserMongoose.findOneAndUpdate({ username: username }, userData, {
      new: true,
      projection: { password: 0, apiKey: 0 },
    })

    if (!updatedUser) {
      throw new Error('INVALID DATA: User not found');
    }
    
    return toPlainObject<LeanUser>(updatedUser.toJSON());
  }

  async regenerateApiKey(username: string) {
    const updatedUser = await UserMongoose.findOneAndUpdate(
      { username: username },
      { apiKey: generateUserApiKey() },
      { new: true, projection: { password: 0 } }
    );

    if (!updatedUser) {
      throw new Error('INVALID DATA: User not found');
    }

    return toPlainObject<LeanUser>(updatedUser?.toJSON()).apiKey;
  }

  async destroy(username: string) {
    const result = await UserMongoose.deleteOne({ username: username });
    return result?.deletedCount === 1;
  }

  async changeRole(username: string, role: UserRole) {
    return this.update(username, { role });
  }
}

export default UserRepository;
