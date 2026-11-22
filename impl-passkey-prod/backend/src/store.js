/**
 * DynamoDB adapter: portal-owned identity cache and revocable sessions.
 *
 * All access is point-lookups (no scans). TTL attributes let DynamoDB clean up
 * expired records automatically.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { config } from './config.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function identityKey(portal, sub) {
  return `${portal.realm}:${sub}`;
}

export async function getIdentity(key) {
  const result = await ddb.send(new GetCommand({
    TableName: config.identityTable,
    Key: { id: key },
  }));
  return result.Item ?? null;
}

/**
 * Upsert the identity after a successful login. Idempotent.
 * We never write passkeyEnrolled=true here — only the Account API result may do that.
 */
export async function recordLogin({ key, portal, claims, now }) {
  await ddb.send(new UpdateCommand({
    TableName: config.identityTable,
    Key: { id: key },
    UpdateExpression: [
      'SET realm = :realm, portalHost = :portalHost, email = :email, lastLoginAt = :now, updatedAt = :now',
      'ADD loginCount :one',
    ].join(', '),
    ExpressionAttributeValues: {
      ':realm': portal.realm,
      ':portalHost': portal.portalHost,
      ':email': typeof claims.email === 'string' ? claims.email : null,
      ':now': now,
      ':one': 1,
    },
  }));
}

/** Only an authoritative `true` from Keycloak may set this flag. */
export async function setPasskeyStatus({ key, hasPasskey, now }) {
  if (hasPasskey !== true) return;
  await ddb.send(new UpdateCommand({
    TableName: config.identityTable,
    Key: { id: key },
    UpdateExpression: 'SET passkeyEnrolled = :value, passkeyVerifiedAt = :now, updatedAt = :now',
    ExpressionAttributeValues: { ':value': true, ':now': now },
  }));
}

export async function createSession({ sid, key, portal, expiresAt, now }) {
  await ddb.send(new PutCommand({
    TableName: config.sessionTable,
    Item: {
      sid,
      identityId: key,
      portalHost: portal.portalHost,
      realm: portal.realm,
      createdAt: now,
      expiresAt,
      ttl: Math.floor(expiresAt / 1000) + 3600,
      revoked: false,
    },
  }));
}

/**
 * Consistent read: logout must be visible immediately. Returns null for
 * missing, expired or revoked sessions.
 */
export async function getActiveSession(sid) {
  const result = await ddb.send(new GetCommand({
    TableName: config.sessionTable,
    Key: { sid },
    ConsistentRead: true,
  }));
  const item = result.Item;
  if (!item || item.revoked === true || item.expiresAt <= Date.now()) return null;
  return item;
}

export async function revokeSession(sid) {
  await ddb.send(new UpdateCommand({
    TableName: config.sessionTable,
    Key: { sid },
    UpdateExpression: 'SET revoked = :true, revokedAt = :now',
    ExpressionAttributeValues: { ':true': true, ':now': Date.now() },
  }));
}
