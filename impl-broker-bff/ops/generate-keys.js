// Generates the three independent 256-bit keys used by the BFF.
// Run: node ops/generate-keys.js
// Store the output in AWS Secrets Manager / SSM Parameter Store (SecureString).
// NEVER commit the generated values.

import { randomBytes } from 'node:crypto';

const newKey = () => randomBytes(32).toString('base64url');

console.log('# Add these to your Lambda environment (or SSM/Secrets Manager):');
console.log(`SESSION_ENC_KEY_B64U=${newKey()}`);
console.log(`TX_ENC_KEY_B64U=${newKey()}`);
console.log(`ENROLLED_ENC_KEY_B64U=${newKey()}`);
console.log('# Initial deploy: copy each current value into its PREVIOUS counterpart.');
console.log('# Rotation: set PREVIOUS=old value, current=new value, deploy, wait TTL, then clean up.');
