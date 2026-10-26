import { randomBytes, randomUUID } from 'node:crypto';

export function createId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function createToken(prefix = 'ah') {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}
