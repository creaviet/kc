/**
 * AWS Secrets Manager with a per-Lambda-container cache.
 *
 * The secret is a JSON object: { "<secretKey>": "<client secret>", ... }.
 * Secrets are never logged; only a SHA-256 fingerprint may appear in logs.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from './config.js';
import { keyFingerprint } from './crypto.js';

const client = new SecretsManagerClient({});
let cached = null;

async function loadSecret() {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const result = await client.send(new GetSecretValueCommand({ SecretId: config.secretsSecretId }));
  if (!result.SecretString) throw new Error('secrets_manager_secret_has_no_string_value');

  let parsed;
  try {
    parsed = JSON.parse(result.SecretString);
  } catch {
    throw new Error('secrets_manager_secret_is_not_json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('secrets_manager_secret_wrong_shape');
  }

  cached = { value: parsed, expiresAt: now + config.secretsCacheMs };
  return parsed;
}

/** Returns the confidential client secret for one portal. Fails closed. */
export async function getClientSecret(portal) {
  const secrets = await loadSecret();
  const secret = secrets[portal.secretKey];
  if (typeof secret !== 'string' || secret.length < 16) {
    console.error(JSON.stringify({ level: 'error', event: 'missing_client_secret', realm: portal.realm, secret_key: portal.secretKey }));
    const err = new Error('missing_client_secret');
    err.statusCode = 500;
    throw err;
  }
  return secret;
}

/** Safe for logs/debugging: fingerprint only. */
export function describeSecret(secret) {
  return `sha256:${keyFingerprint(secret)}`;
}
