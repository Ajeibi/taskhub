import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db.js';
import { asyncHandler, parse } from '../../http.js';
import { authenticate } from '../../middleware/authenticate.js';

const searchSchema = z.object({ q: z.string().trim().min(2).max(100) });

// Escape LIKE wildcards so user input is matched literally.
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/**
 * People picker (e.g. for adding project members). Returns only id/name/email, capped at 10, and requires
 * 2+ characters, so it cannot be used to dump the user table. Trade-off: any signed-in user can look up
 * colleagues by name/email prefix, which is the normal behaviour of an internal company directory.
 */
export function usersRouter(db: Db, config: Config): Router {
  const router = Router();
  router.use(authenticate(config));

  router.get('/', asyncHandler(async (req, res) => {
    const { q } = parse(searchSchema, req.query);
    const pattern = `${escapeLike(q.toLowerCase())}%`;
    const { rows } = await db.query(
      `SELECT id, name, email FROM users
        WHERE email LIKE $1 OR lower(name) LIKE $1
        ORDER BY name, id LIMIT 10`,
      [pattern],
    );
    res.json({ items: rows });
  }));

  return router;
}
