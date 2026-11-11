import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLinks, planLinks, scoretechBinding } from './link-sphere-scoretech.mjs';

const sphereIssuer = 'https://sphere.example';
const issuer = sphereIssuer + '/identity/auth/realms/score';
const sphereId = 'a'.repeat(24);
const otherSphereId = 'b'.repeat(24);
const subject = 'scoretech-user-id';
const target = { issuer, subject };
const legacy = { _id: 'space-user', sphereIdentity: { issuer: sphereIssuer, subject: sphereId } };
const original = { id: sphereId, bindings: [scoretechBinding(issuer, subject)] };
const inputs = { sphereIssuer, issuer, subjects: [subject], sphereUsers: [original], spaceUsers: [legacy] };

test('maps the verified provider subject to the original SPACE account', () => {
  const { plan, report } = planLinks(inputs);
  assert.deepEqual(plan, [{ id: legacy._id, source: legacy.sphereIdentity, target }]);
  assert.equal(report.ready, 1);
});

test('leaves local accounts, unrelated SPHERE issuers and users absent from SCORETech alone', () => {
  const { plan, report } = planLinks({
    ...inputs,
    subjects: ['different-user'],
    spaceUsers: [
      legacy, { _id: 'password-only', username: 'same-name' },
      { _id: 'another-sphere', sphereIdentity: { ...legacy.sphereIdentity, issuer: 'https://other.example' } },
      { _id: 'no-sphere-link', sphereIdentity: { ...legacy.sphereIdentity, subject: otherSphereId } },
    ],
  });
  assert.deepEqual(plan, []);
  assert.equal(report.candidates, 2);
  assert.equal(report.missingInIdentity, 1);
  assert.equal(report.noSphereLink, 1);
});

test('leaves conflicting existing links on either account alone and recognizes an identical link', () => {
  const exact = { ...legacy, scoretechIdentity: target };
  assert.equal(planLinks({ ...inputs, spaceUsers: [exact] }).report.alreadyLinked, 1);
  for (const spaceUsers of [
    [{ ...legacy, scoretechIdentity: { issuer, subject: 'another' } }],
    [legacy, { _id: 'existing-owner', scoretechIdentity: target }],
  ]) {
    const { plan, report } = planLinks({ ...inputs, spaceUsers });
    assert.deepEqual(plan, []);
    assert.deepEqual(report.conflicts, [legacy._id]);
  }
});

test('never guesses when a SPHERE binding has multiple owners', () => {
  const double = { ...original, id: otherSphereId };
  const { plan, report } = planLinks({ ...inputs, sphereUsers: [original, double] });
  assert.deepEqual(plan, []);
  assert.deepEqual(report.conflicts, [legacy._id]);
});

test('rejects exports with malformed or repeated source IDs', () => {
  assert.throws(() => planLinks({ ...inputs, sphereUsers: [original, original] }), /repeated SPHERE binding/);
  assert.throws(() => planLinks({ ...inputs, subjects: [subject, subject] }), /Repeated SCORETech subject/);
});

test('applies only an unchanged legacy binding and reports concurrent changes', async () => {
  const writes = [];
  const users = {
    indexes: async () => [{
      name: 'unique_scoretech_identity', unique: true, key: { 'scoretechIdentity.issuer': 1, 'scoretechIdentity.subject': 1 },
    }],
    updateOne: async (filter, update) => {
      writes.push({ filter, update });
      return { modifiedCount: 0 };
    },
  };
  const { plan } = planLinks(inputs);
  assert.deepEqual(await applyLinks(users, plan), { linked: 0, changedSincePlan: [legacy._id] });
  assert.deepEqual(writes, [{
    filter: {
      _id: legacy._id,
      'sphereIdentity.issuer': sphereIssuer,
      'sphereIdentity.subject': sphereId,
      scoretechIdentity: { $exists: false },
    },
    update: { $set: { scoretechIdentity: target } },
  }]);
  users.updateOne = async () => { throw Object.assign(new Error(), { code: 11000 }); };
  assert.deepEqual(await applyLinks(users, plan), { linked: 0, changedSincePlan: [legacy._id] });
  users.indexes = async () => [];
  await assert.rejects(applyLinks(users, plan), /unique identity index/);
});
