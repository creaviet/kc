#!/usr/bin/env node
'use strict';

// Validates filled production input files locally.
// It never prints secret values and does not call any network endpoint.

const fs = require('node:fs');
const path = require('node:path');

const inputDir = path.resolve(process.argv[2] || __dirname);
const errors = [];
const seenErrors = new Set();

const PLACEHOLDER_RE = /(REPLACE_|CHANGE_ME|TEMPLATE|example\.|<[^>]+>)/i;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/i;
const CIDR_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
const ACM_ARN_RE = /^arn:aws:acm:([a-z0-9-]+):(\d{12}):certificate\/[a-zA-Z0-9-]+$/;
const SECRETS_ARN_RE = /^arn:aws:secretsmanager:([a-z0-9-]+):(\d{12}):secret:[\w+=,.@/-]+$/;
const ZONE_RE = /^Z[A-Z0-9]+$/;

function fail(message) {
  if (seenErrors.has(message)) return;
  seenErrors.add(message);
  errors.push(message);
}

function exists(file) {
  return fs.existsSync(path.join(inputDir, file));
}

function readText(file) {
  const full = path.join(inputDir, file);
  if (!fs.existsSync(full)) {
    fail(`Missing ${file}`);
    return '';
  }
  return fs.readFileSync(full, 'utf8');
}

function readJson(file) {
  const text = readText(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
    return null;
  }
}

function walk(value, label, key = '') {
  if (key.startsWith('_')) return;
  if (typeof value === 'string' && PLACEHOLDER_RE.test(value)) {
    fail(`${label} still contains a placeholder${key ? ` at ${key}` : ''}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      if (PLACEHOLDER_RE.test(childKey) && !childKey.startsWith('_')) {
        fail(`${label} key ${childKey} still contains a placeholder`);
      }
      walk(childValue, label, childKey);
    }
  }
}

function requireString(value, label, minLength = 1) {
  if (typeof value !== 'string' || value.trim().length < minLength) {
    fail(`${label} must be a non-empty string (min ${minLength} chars)`);
    return false;
  }
  return true;
}

function requireHost(value, label) {
  if (typeof value !== 'string' || !HOST_RE.test(value)) {
    fail(`${label} must be a valid DNS hostname without scheme or port`);
    return false;
  }
  return true;
}

function requireHttpsUrl(value, label, expectedHost, expectedPort) {
  if (typeof value !== 'string') {
    fail(`${label} must be a string`);
    return false;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} is not a valid absolute URL`);
    return false;
  }
  if (url.protocol !== 'https:') fail(`${label} must use https`);
  if (expectedHost && url.hostname.toLowerCase() !== expectedHost.toLowerCase()) {
    fail(`${label} host must be ${expectedHost}`);
  }
  if (expectedPort && url.port !== String(expectedPort)) {
    fail(`${label} port must be ${expectedPort}`);
  }
  if (url.username || url.password) fail(`${label} must not contain credentials`);
  return true;
}

function parseEnv(text, file) {
  const result = {};
  const seen = new Set();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const separator = line.indexOf('=');
    if (separator < 1) {
      fail(`${file}:${index + 1} is not KEY=VALUE`);
      return;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (seen.has(key)) fail(`${file} contains duplicate key ${key}`);
    seen.add(key);
    result[key] = value;
  });
  return result;
}

function isDocumentationIp(value) {
  return /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(value);
}

function validatePortals() {
  const data = readJson('portals.json');
  if (!data) return [];
  walk(data, 'portals.json');

  if (data.expectedPortalCount !== 9) {
    fail('portals.json expectedPortalCount must be 9');
  }
  if (!Array.isArray(data.portals) || data.portals.length !== 9) {
    fail('portals.json must contain exactly 9 portals');
    return [];
  }

  const unique = { portalHost: new Set(), apiHost: new Set(), realm: new Set(), secretKey: new Set() };
  data.portals.forEach((portal, index) => {
    const label = `portals.json portals[${index}]`;
    for (const field of ['portalHost', 'apiHost', 'realm', 'clientId', 'secretKey', 'redirectUri', 'postLoginUrl', 'postLogoutUrl']) {
      requireString(portal[field], `${label}.${field}`);
    }
    requireHost(portal.portalHost, `${label}.portalHost`);
    requireHost(portal.apiHost, `${label}.apiHost`);
    if (!SLUG_RE.test(portal.realm || '')) fail(`${label}.realm must be a lowercase Keycloak-safe slug`);
    if (!SLUG_RE.test(portal.secretKey || '')) fail(`${label}.secretKey must be a Secrets Manager key slug`);
    if (typeof portal.verimiEnabled !== 'boolean') fail(`${label}.verimiEnabled must be boolean`);

    for (const [field, set] of Object.entries(unique)) {
      if (set.has(portal[field])) fail(`${label}.${field} is duplicated: ${portal[field]}`);
      set.add(portal[field]);
    }

    const callback = safeUrl(portal.redirectUri);
    if (callback) {
      if (callback.hostname.toLowerCase() !== String(portal.apiHost).toLowerCase()) {
        fail(`${label}.redirectUri host must equal apiHost`);
      }
      if (callback.pathname !== '/api/auth/callback') {
        fail(`${label}.redirectUri path must be /api/auth/callback`);
      }
    }
    const login = safeUrl(portal.postLoginUrl);
    if (login && login.hostname.toLowerCase() !== String(portal.portalHost).toLowerCase()) {
      fail(`${label}.postLoginUrl host must equal portalHost`);
    }
    const logout = safeUrl(portal.postLogoutUrl);
    if (logout && logout.hostname.toLowerCase() !== String(portal.portalHost).toLowerCase()) {
      fail(`${label}.postLogoutUrl host must equal portalHost`);
    }
  });
  return data.portals;
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function validateDomains(portals) {
  const data = readJson('domains.json');
  if (!data) return;
  walk(data, 'domains.json');
  const entries = Object.entries(data).filter(([key]) => !key.startsWith('_'));
  if (entries.length !== 9) fail('domains.json must contain exactly 9 portal entries');

  const portalByHost = new Map(portals.map((p) => [p.portalHost, p]));
  for (const [host, value] of entries) {
    const label = `domains.json[${host}]`;
    const portal = portalByHost.get(host);
    if (!portal) {
      fail(`${label} does not match any portalHost from portals.json`);
      continue;
    }
    if (value.apiHost !== portal.apiHost) {
      fail(`${label}.apiHost must equal ${portal.apiHost}`);
    }
    if (typeof value.certificateArn !== 'string' || !ACM_ARN_RE.test(value.certificateArn)) {
      fail(`${label}.certificateArn is not a valid ACM certificate ARN`);
    }
    if (value.hostedZoneId !== undefined && !ZONE_RE.test(value.hostedZoneId)) {
      fail(`${label}.hostedZoneId is not a valid Route53 zone id`);
    }
  }
}

function validateVerimi() {
  const data = readJson('verimi.json');
  if (!data) return;
  walk(data, 'verimi.json');
  for (const field of ['authorizationUrl', 'tokenUrl', 'userInfoUrl', 'logoutUrl', 'jwksUrl', 'issuer']) {
    requireHttpsUrl(data[field], `verimi.json.${field}`);
  }
  requireString(data.clientId, 'verimi.json.clientId', 2);
  requireString(data.clientSecret, 'verimi.json.clientSecret', 8);
}

function validateVpsEnv() {
  const env = parseEnv(readText('vps.env'), 'vps.env');
  if (!Object.keys(env).length) return;
  if (PLACEHOLDER_RE.test(readText('vps.env'))) fail('vps.env still contains a placeholder');
  const required = ['KC_DB_DATABASE', 'KC_DB_USERNAME', 'KC_DB_PASSWORD', 'KC_PROXY_TRUSTED_ADDRESSES', 'KC_BOOTSTRAP_ADMIN_USERNAME', 'KC_BOOTSTRAP_ADMIN_PASSWORD'];
  for (const key of required) requireString(env[key], `vps.env:${key}`);
  if ((env.KC_DB_PASSWORD || '').length < 24) fail('vps.env:KC_DB_PASSWORD must be at least 24 characters');
  if ((env.KC_BOOTSTRAP_ADMIN_PASSWORD || '').length < 24) fail('vps.env:KC_BOOTSTRAP_ADMIN_PASSWORD must be at least 24 characters');
  const cidrs = String(env.KC_PROXY_TRUSTED_ADDRESSES || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!cidrs.length) fail('vps.env:KC_PROXY_TRUSTED_ADDRESSES must contain at least one CIDR');
  for (const cidr of cidrs) {
    if (!CIDR_RE.test(cidr)) fail(`vps.env:KC_PROXY_TRUSTED_ADDRESSES contains invalid CIDR ${cidr}`);
    if (isDocumentationIp(cidr)) fail(`vps.env:KC_PROXY_TRUSTED_ADDRESSES contains a documentation IP ${cidr}`);
  }
}

function validateAdminAllow() {
  const text = readText('admin-allow.conf');
  if (!text) return;
  if (PLACEHOLDER_RE.test(text)) fail('admin-allow.conf still contains a placeholder');
  const lines = text.split(/\r?\n/).map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean);
  const allows = lines.filter((line) => /^allow\s+/i.test(line)).map((line) => line.replace(/^allow\s+/i, '').replace(/;$/, '').trim());
  if (!allows.length) fail('admin-allow.conf must contain at least one allow rule');
  if (!lines.some((line) => /^deny\s+all\s*;$/i.test(line))) fail('admin-allow.conf must end with deny all;');
  for (const value of allows) {
    if (!CIDR_RE.test(value)) fail(`admin-allow.conf contains invalid IP/CIDR ${value}`);
    if (isDocumentationIp(value)) fail(`admin-allow.conf contains documentation IP ${value}`);
  }
}

function validateAwsEnv(portals) {
  const text = readText('aws-deploy.env');
  if (!text) return null;
  if (PLACEHOLDER_RE.test(text)) fail('aws-deploy.env still contains a placeholder');
  const env = parseEnv(text, 'aws-deploy.env');
  requireString(env.AWS_REGION, 'aws-deploy.env:AWS_REGION', 2);
  requireString(env.STAGE, 'aws-deploy.env:STAGE', 1);
  requireString(env.TABLE_SUFFIX, 'aws-deploy.env:TABLE_SUFFIX', 1);
  if (!SECRETS_ARN_RE.test(env.SECRETS_SECRET_ARN || '')) {
    fail('aws-deploy.env:SECRETS_SECRET_ARN is not a valid Secrets Manager ARN');
  } else {
    const match = SECRETS_ARN_RE.exec(env.SECRETS_SECRET_ARN);
    if (match[1] !== env.AWS_REGION) fail('aws-deploy.env:SECRETS_SECRET_ARN region must equal AWS_REGION');
  }

  requireString(env.COOKIE_ACTIVE_KEY_ID, 'aws-deploy.env:COOKIE_ACTIVE_KEY_ID', 1);
  let keys = null;
  try {
    keys = JSON.parse(env.COOKIE_ENCRYPTION_KEYS_JSON || 'null');
  } catch (error) {
    fail(`aws-deploy.env:COOKIE_ENCRYPTION_KEYS_JSON is not valid JSON: ${error.message}`);
  }
  if (keys && typeof keys === 'object') {
    const active = keys[env.COOKIE_ACTIVE_KEY_ID];
    if (typeof active !== 'string') {
      fail('aws-deploy.env active cookie key is missing');
    } else {
      const decoded = Buffer.from(active, 'base64url');
      if (decoded.length !== 32) fail('active cookie key must decode to exactly 32 bytes');
      if (decoded.toString('base64url') !== active) fail('active cookie key must be canonical base64url');
    }
    for (const [keyId, value] of Object.entries(keys)) {
      const decoded = Buffer.from(String(value), 'base64url');
      if (keyId === env.COOKIE_ACTIVE_KEY_ID && decoded.length !== 32) {
        fail(`cookie key ${keyId} must decode to exactly 32 bytes`);
      }
    }
  }

  requireHttpsUrl(env.KC_PUBLIC_URL, 'aws-deploy.env:KC_PUBLIC_URL', 'kc.gateway-vw.de', '8443');
  const origins = String(env.ALLOWED_AUTH_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!origins.length) fail('aws-deploy.env:ALLOWED_AUTH_ORIGINS must contain at least one origin');
  for (const origin of origins) requireHttpsUrl(origin, 'aws-deploy.env:ALLOWED_AUTH_ORIGINS entry');

  for (const optionalArn of ['WAF_WEB_ACL_ARN', 'ALARM_SNS_TOPIC_ARN']) {
    const value = env[optionalArn];
    if (value && !/^arn:aws:/.test(value)) fail(`aws-deploy.env:${optionalArn} must be empty or an ARN`);
  }
  return env;
}

function validateFrontendEnv() {
  const text = readText('frontend.env');
  if (!text) return;
  if (PLACEHOLDER_RE.test(text)) fail('frontend.env still contains a placeholder');
  const env = parseEnv(text, 'frontend.env');
  const apiBase = env.VITE_API_BASE || '';
  if (apiBase !== '/api') {
    requireHttpsUrl(apiBase, 'frontend.env:VITE_API_BASE');
    if (!safeUrl(apiBase)?.pathname.endsWith('/api')) {
      fail('frontend.env:VITE_API_BASE must end with /api');
    }
  }
  const origins = String(env.VITE_ALLOWED_AUTH_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!origins.includes('https://kc.gateway-vw.de:8443')) {
    fail('frontend.env:VITE_ALLOWED_AUTH_ORIGINS must include https://kc.gateway-vw.de:8443');
  }
  if (!['true', 'false'].includes(env.VITE_VERIMI_AVAILABLE)) {
    fail('frontend.env:VITE_VERIMI_AVAILABLE must be true or false');
  }
}

function validateVerimiRedirects(portals, awsEnv) {
  const text = readText('verimi-redirect-uris.txt');
  if (!text) return;
  if (PLACEHOLDER_RE.test(text)) fail('verimi-redirect-uris.txt still contains a placeholder');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 9) fail('verimi-redirect-uris.txt must contain exactly 9 lines');
  const kc = (awsEnv && awsEnv.KC_PUBLIC_URL ? awsEnv.KC_PUBLIC_URL : 'https://kc.gateway-vw.de:8443').replace(/\/+$/, '');
  const expected = portals.map((p) => `${kc}/realms/${p.realm}/broker/verimi/endpoint`);
  const actualSet = new Set(lines);
  if (actualSet.size !== lines.length) fail('verimi-redirect-uris.txt contains duplicates');
  for (const uri of expected) {
    if (!actualSet.has(uri)) fail(`verimi-redirect-uris.txt is missing ${uri}`);
  }
  for (const uri of lines) {
    if (!expected.includes(uri)) fail(`verimi-redirect-uris.txt contains unexpected URI ${uri}`);
  }
}

function main() {
  const portals = validatePortals();
  validateDomains(portals);
  validateVerimi();
  validateVpsEnv();
  validateAdminAllow();
  const awsEnv = validateAwsEnv(portals);
  validateFrontendEnv();
  validateVerimiRedirects(portals, awsEnv);

  if (errors.length) {
    console.error(`FAILED: ${errors.length} production input problem(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  for (const requiredFile of ['portals.json', 'domains.json', 'verimi.json', 'vps.env', 'admin-allow.conf', 'aws-deploy.env', 'frontend.env', 'verimi-redirect-uris.txt']) {
    if (!exists(requiredFile)) fail(`Missing ${requiredFile}`);
  }
  if (errors.length) {
    console.error(`FAILED: ${errors.length} production input problem(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log('OK: production inputs are structurally valid.');
  console.log('Portals: 9 | Realms: 9 | Verimi broker redirect URIs: 9');
  console.log('No secret values were printed.');
}

main();
