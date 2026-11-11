import bcrypt from 'bcryptjs';
import mongoose, { Document, Schema } from 'mongoose';
import { generateUserApiKey, hashPassword } from '../../../utils/users/helpers';
import { UserRole, USER_ROLES } from '../../../types/permissions';

const identitySchema = new Schema({
  issuer: { type: String, required: true },
  subject: { type: String, required: true },
}, { _id: false });

export const scoretechIdentityIndex = { 'scoretechIdentity.issuer': 1, 'scoretechIdentity.subject': 1 } as const;
export const scoretechIdentityIndexOptions = {
  name: 'unique_scoretech_identity',
  unique: true,
  partialFilterExpression: { 'scoretechIdentity.issuer': { $type: 'string' }, 'scoretechIdentity.subject': { $type: 'string' } },
};

const userSchema = new Schema({
  username: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    minlength: 5,
    required: function(this: { sphereIdentity?: unknown; scoretechIdentity?: unknown }) { return !this.sphereIdentity && !this.scoretechIdentity; },
  },
  sphereIdentity: {
    type: identitySchema,
    select: false,
  },
  scoretechIdentity: { type: identitySchema, select: false },
  apiKey: {
    type: String,
    unique: true,
    sparse: true // Only adds to the index if the field is present
  },
  role: {
    type: String,
    required: true,
    enum: USER_ROLES,
    default: USER_ROLES[USER_ROLES.length - 1]
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function (doc, resultObject, options) {
      delete resultObject._id;
      delete resultObject.__v;
      delete resultObject.password;
      delete resultObject.sphereIdentity;
      delete resultObject.scoretechIdentity;
      return resultObject;
    }
  }
});

userSchema.index({ 'sphereIdentity.issuer': 1, 'sphereIdentity.subject': 1 }, {
  name: 'unique_sphere_identity', unique: true,
  partialFilterExpression: { 'sphereIdentity.issuer': { $type: 'string' }, 'sphereIdentity.subject': { $type: 'string' } },
});

userSchema.index(scoretechIdentityIndex, scoretechIdentityIndexOptions);

// Verify password method
userSchema.methods.verifyPassword = async function(password: string) {
  return Boolean(this.password) && await bcrypt.compare(password, this.password);
};

userSchema.pre('save', async function(next) {
  const user = this;
  
  if (!user.apiKey) user.apiKey = generateUserApiKey();

  // If the password hasn't changed, we continue
  if (!user.isModified('password') || !user.password) return next();

  try {
    user.password = await hashPassword(user.password);

    
    next();
  } catch (error) {
    next(error as Error);
  }
});

export interface UserDocument extends Document {
  username: string;
  password?: string;
  sphereIdentity?: { issuer: string; subject: string };
  scoretechIdentity?: { issuer: string; subject: string };
  apiKey: string;
  role: UserRole;
  verifyPassword: (password: string) => Promise<boolean>;
}

const userModel = mongoose.model<UserDocument>('User', userSchema, 'users');

export default userModel;
