/**
 * Persistence for the things the portal owns:
 *   1. account ↔ Keycloak sub mapping + enrolment campaign flag
 *   2. portal sessions (so logout can actually revoke a session cookie)
 *
 * Credentials stay in Keycloak/Postgres. STORE=memory is used only in tests
 * and local exploration; production uses DynamoDB with two scoped tables.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from './config.js';

const users = new Map();
const sessions = new Map();

const docClient =
  config.store === 'dynamodb'
    ? DynamoDBDocumentClient.from(
        new DynamoDBClient({ region: config.awsRegion }),
        { marshallOptions: { removeUndefinedValues: true } },
      )
    : null;

export async function getUser(kcSub) {
  if (!kcSub) return null;
  if (config.store === 'memory') return users.get(kcSub) ?? null;

  const result = await docClient.send(
    new GetCommand({ TableName: config.tableName, Key: { kcSub } }),
  );
  return result.Item ?? null;
}

/**
 * Build the DynamoDB update explicitly so a passkey-only login (verimiSub=null)
 * NEVER overwrites an existing Verimi mapping with null.
 */
export function buildLinkUserUpdate({ kcSub, portal, realm, verimiSub, now }) {
  const expression = [
    'portal = :p',
    'realm = :r',
    'lastLoginAt = :t',
    'passkeyEnrolled = if_not_exists(passkeyEnrolled, :f)',
  ];
  const ExpressionAttributeValues = {
    ':p': portal,
    ':r': realm,
    ':t': now,
    ':f': false,
  };
  const ExpressionAttributeNames = {};

  const hasVerimiSub = typeof verimiSub === 'string' && verimiSub.length > 0;
  if (hasVerimiSub) {
    expression.push('#vs = :v');
    ExpressionAttributeNames['#vs'] = 'verimiSub';
    ExpressionAttributeValues[':v'] = verimiSub;
  }

  return {
    TableName: config.tableName,
    Key: { kcSub },
    UpdateExpression: `SET ${expression.join(', ')}`,
    ...(Object.keys(ExpressionAttributeNames).length > 0 ? { ExpressionAttributeNames } : {}),
    ExpressionAttributeValues,
  };
}

/** Link (or refresh) the portal identity. Never resets an existing enrolment flag. */
export async function linkUser({ kcSub, portal, realm, verimiSub }) {
  const now = new Date().toISOString();

  if (config.store === 'memory') {
    const previous = users.get(kcSub) ?? {};
    users.set(kcSub, {
      ...previous,
      kcSub,
      portal,
      realm,
      verimiSub:
        typeof verimiSub === 'string' && verimiSub.length > 0
          ? verimiSub
          : previous.verimiSub ?? null,
      linkedAt: previous.linkedAt ?? now,
      lastLoginAt: now,
      passkeyEnrolled: previous.passkeyEnrolled ?? false,
    });
    return;
  }

  await docClient.send(
    new UpdateCommand(buildLinkUserUpdate({ kcSub, portal, realm, verimiSub, now })),
  );
}

/**
 * Refresh the campaign flag from an authoritative Account API answer.
 * This is self-healing: if a passkey was deleted in Keycloak, the next login
 * clears the stale portal flag. Call this ONLY for a real true/false answer —
 * never for "Account API unavailable".
 */
export async function setPasskeyVerified(kcSub, verified) {
  const now = new Date().toISOString();
  const value = Boolean(verified);

  if (config.store === 'memory') {
    const previous = users.get(kcSub) ?? { kcSub };
    users.set(kcSub, {
      ...previous,
      passkeyEnrolled: value,
      lastCredentialCheckAt: now,
    });
    return;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { kcSub },
      UpdateExpression: 'SET passkeyEnrolled = :v, lastCredentialCheckAt = :t',
      ExpressionAttributeValues: { ':v': value, ':t': now },
    }),
  );
}

/** Backwards-compatible helper for tests and true-only call sites. */
export async function markPasskeyVerified(kcSub) {
  return setPasskeyVerified(kcSub, true);
}

/** Create the server-side record that makes session revocation possible. */
export async function createSession({ sid, kcSub, portal, realm, expiresAt }) {
  const now = new Date().toISOString();
  const expiresAtSeconds =
    expiresAt ?? Math.floor(Date.now() / 1000) + config.sessionTtl;

  if (config.store === 'memory') {
    sessions.set(sid, {
      sid,
      kcSub,
      portal,
      realm,
      revoked: false,
      createdAt: now,
      expiresAt: expiresAtSeconds,
    });
    return;
  }

  await docClient.send(
    new PutCommand({
      TableName: config.sessionTableName,
      Item: {
        sid,
        kcSub,
        portal,
        realm,
        revoked: false,
        createdAt: now,
        expiresAt: expiresAtSeconds,
      },
    }),
  );
}

/** Returns true only for an existing, unrevoked, unexpired session record. */
export async function isSessionActive(sid) {
  if (!sid) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (config.store === 'memory') {
    const item = sessions.get(sid);
    return Boolean(item && !item.revoked && Number(item.expiresAt) > nowSeconds);
  }

  const result = await docClient.send(
    new GetCommand({ TableName: config.sessionTableName, Key: { sid } }),
  );
  const item = result.Item;
  return Boolean(item && !item.revoked && Number(item.expiresAt) > nowSeconds);
}

/** Revoke one session. Missing records are acceptable; storage errors are not. */
export async function revokeSession(sid) {
  if (!sid) return false;

  if (config.store === 'memory') {
    const item = sessions.get(sid);
    if (!item) return false;
    sessions.set(sid, { ...item, revoked: true, revokedAt: new Date().toISOString() });
    return true;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: config.sessionTableName,
        Key: { sid },
        UpdateExpression: 'SET revoked = :r, revokedAt = :t',
        ConditionExpression: 'attribute_exists(sid)',
        ExpressionAttributeValues: { ':r': true, ':t': new Date().toISOString() },
      }),
    );
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}
