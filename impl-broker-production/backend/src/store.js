/**
 * Production persistence.
 *
 * The portal stores only a small identity cache and revocable session records.
 * WebAuthn credentials remain in Keycloak/Postgres — never here.
 *
 * DynamoDB is mandatory. There is deliberately no in-memory fallback: a cache
 * outage must not silently create sessions that cannot be revoked.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from './config.js';

const docClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: config.awsRegion }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export async function getUser(kcSub) {
  if (!kcSub) return null;

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
  await docClient.send(
    new UpdateCommand(buildLinkUserUpdate({ kcSub, portal, realm, verimiSub, now })),
  );
}

/**
 * Refresh the campaign flag from an authoritative Account API answer.
 * Call this ONLY for a real true/false answer — never for "Account API
 * unavailable".
 */
export async function setPasskeyVerified(kcSub, verified) {
  await docClient.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { kcSub },
      UpdateExpression: 'SET passkeyEnrolled = :v, lastCredentialCheckAt = :t',
      ExpressionAttributeValues: {
        ':v': Boolean(verified),
        ':t': new Date().toISOString(),
      },
    }),
  );
}

/** Backwards-compatible helper for true-only call sites. */
export async function markPasskeyVerified(kcSub) {
  return setPasskeyVerified(kcSub, true);
}

/** Create the server-side record that makes session revocation possible. */
export async function createSession({ sid, kcSub, portal, realm, expiresAt }) {
  const expiresAtSeconds = expiresAt ?? Math.floor(Date.now() / 1000) + config.sessionTtl;

  await docClient.send(
    new PutCommand({
      TableName: config.sessionTableName,
      Item: {
        sid,
        kcSub,
        portal,
        realm,
        revoked: false,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAtSeconds,
      },
    }),
  );
}

/** Returns true only for an existing, unrevoked, unexpired session record. */
export async function isSessionActive(sid) {
  if (!sid) return false;

  const result = await docClient.send(
    new GetCommand({ TableName: config.sessionTableName, Key: { sid } }),
  );
  const item = result.Item;
  return Boolean(item && !item.revoked && Number(item.expiresAt) > Math.floor(Date.now() / 1000));
}

/** Revoke one session. Missing records are acceptable; storage errors are not. */
export async function revokeSession(sid) {
  if (!sid) return false;

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: config.sessionTableName,
        Key: { sid },
        UpdateExpression: 'SET revoked = :r, revokedAt = :t',
        ConditionExpression: 'attribute_exists(sid)',
        ExpressionAttributeValues: {
          ':r': true,
          ':t': new Date().toISOString(),
        },
      }),
    );
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}
