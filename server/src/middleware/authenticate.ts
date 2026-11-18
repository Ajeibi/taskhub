import type { RequestHandler } from 'express';
import type { Config } from '../config.js';
import { unauthorized } from '../errors.js';
import { verifyAccessToken, type AuthUser } from '../modules/auth/tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Requires `Authorization: Bearer <access token>`. Sets req.user; rejects with 401 otherwise. */
export function authenticate(config: Config): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next(unauthorized());
    try {
      req.user = verifyAccessToken(config, header.slice(7));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** For handlers that run after authenticate(): narrows req.user to defined. */
export function currentUser(req: Express.Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
