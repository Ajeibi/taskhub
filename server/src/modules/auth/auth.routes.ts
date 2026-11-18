import { Router, type CookieOptions, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db.js';
import { AppError } from '../../errors.js';
import { asyncHandler, parse } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { AuthService, type Session } from './auth.service.js';

const COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/auth'; // the browser only sends the refresh token to auth endpoints

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
// Length over composition rules (NIST 800-63B). 128 cap bounds hashing cost (DoS guard).
const password = z.string().min(10, 'Password must be at least 10 characters').max(128);

const registerSchema = z.object({ email, name: z.string().trim().min(1).max(100), password });
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function authRouter(db: Db, config: Config): Router {
  const router = Router();
  const service = new AuthService(db, config);

  // httpOnly: JavaScript (and so XSS) cannot read it. SameSite=Strict + a narrow path: it is
  // never sent on cross-site requests, which closes the CSRF hole that cookies normally open.
  const cookieOptions = (): CookieOptions => ({
    httpOnly: true,
    sameSite: 'strict',
    secure: config.COOKIE_SECURE,
    path: COOKIE_PATH,
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000,
  });

  const sendSession = (res: Response, status: number, s: Session): void => {
    res.cookie(COOKIE, s.refreshToken, cookieOptions());
    res.status(status).json({ user: s.user, accessToken: s.accessToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS });
  };

  // Brute-force / credential-stuffing protection. NOTE: the default store is per-process memory,
  // so with several replicas the effective limit is per pod. A shared store (Redis) or an
  // ingress-level limit is the production answer; see the technical document.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many attempts, try again later' } },
  });

  router.post(
    '/register',
    limiter,
    asyncHandler(async (req, res) => {
      sendSession(res, 201, await service.register(parse(registerSchema, req.body)));
    }),
  );

  router.post(
    '/login',
    limiter,
    asyncHandler(async (req, res) => {
      sendSession(res, 200, await service.login(parse(loginSchema, req.body)));
    }),
  );

  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const token = readCookie(req, COOKIE);
      if (!token) {
        res.status(401).json({ error: { code: 'unauthorized', message: 'No refresh token' } });
        return;
      }
      try {
        sendSession(res, 200, await service.refresh(token));
      } catch (err) {
        // A rotation race must keep the cookie: the other tab's response has just set the new, valid one.
        if (!(err instanceof AppError && err.code === 'refresh_race')) res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
        throw err;
      }
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const token = readCookie(req, COOKIE);
      if (token) await service.logout(token);
      res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
      res.status(204).end();
    }),
  );

  router.get(
    '/me',
    authenticate(config),
    asyncHandler(async (req, res) => {
      res.json({ user: await service.getUser(currentUser(req).id) });
    }),
  );

  return router;
}
