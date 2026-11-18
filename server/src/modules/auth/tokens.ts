import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Config } from '../../config.js';
import { unauthorized } from '../../errors.js';

export interface AuthUser {
  id: string;
  role: 'admin' | 'user';
}

const ISSUER = 'taskhub';

/** Short-lived, stateless access token. Verified on every request without a DB lookup. */
export function signAccessToken(config: Config, user: AuthUser): string {
  return jwt.sign({ role: user.role }, config.JWT_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: ISSUER,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function verifyAccessToken(config: Config, token: string): AuthUser {
  try {
    // Pin the algorithm: never let the token header choose it (blocks alg=none / key-confusion attacks).
    const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
    if (typeof payload === 'string' || !payload.sub || (payload.role !== 'admin' && payload.role !== 'user')) {
      throw new Error('bad claims');
    }
    return { id: payload.sub, role: payload.role };
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

/** Refresh tokens are opaque random strings; only their SHA-256 is stored, so a DB leak yields no usable tokens. */
export function newRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashRefreshToken(raw) };
}

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
