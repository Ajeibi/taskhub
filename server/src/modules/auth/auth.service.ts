import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Config } from '../../config.js';
import { withTransaction, type Db } from '../../db.js';
import { AppError, conflict, unauthorized } from '../../errors.js';
import { dummyHash, hashPassword, verifyPassword } from './password.js';
import { hashRefreshToken, newRefreshToken, signAccessToken } from './tokens.js';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  createdAt: string;
}

export interface Session {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  created_at: Date;
  password_hash: string;
}

const toPublic = (u: UserRow): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.created_at.toISOString(),
});

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  async register(input: { email: string; name: string; password: string }): Promise<Session> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await withTransaction(this.db, async (tx) => {
        const { rows } = await tx.query<UserRow>(
          `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING *`,
          [input.email, input.name, passwordHash],
        );
        return this.startSession(tx, rows[0]!, randomUUID());
      });
    } catch (err) {
      // Rely on the unique index rather than check-then-insert: that would race under concurrency.
      if ((err as { code?: string }).code === '23505') throw conflict('An account with this email already exists');
      throw err;
    }
  }

  async login(input: { email: string; password: string }): Promise<Session> {
    const { rows } = await this.db.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [input.email]);
    const user = rows[0];
    // Always do one hash verification, whether or not the user exists (see dummyHash).
    const ok = await verifyPassword(input.password, user?.password_hash ?? (await dummyHash()));
    if (!user || !ok) throw unauthorized('Invalid email or password');
    return withTransaction(this.db, (tx) => this.startSession(tx, user, randomUUID()));
  }

  /**
   * Rotation: every refresh token is single-use. Using it returns a new one in the same "family".
   * If an already-used token is presented again, it was stolen or replayed, so the whole family
   * (every descendant, including the legitimate user's current token) is revoked.
   */
  async refresh(rawToken: string): Promise<Session> {
    const outcome = await withTransaction(this.db, async (tx) => {
      // FOR UPDATE serialises concurrent uses of the same token: the second caller sees it revoked.
      const { rows } = await tx.query<{
        id: string;
        user_id: string;
        family_id: string;
        expires_at: Date;
        revoked_at: Date | null;
        just_rotated: boolean;
      }>(`SELECT id, user_id, family_id, expires_at, revoked_at,
                 (replaced_by IS NOT NULL AND revoked_at > now() - make_interval(secs => $2)) AS just_rotated
            FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [
        hashRefreshToken(rawToken),
        this.config.REFRESH_REUSE_GRACE_SECONDS,
      ]);
      const token = rows[0];
      if (!token) return { kind: 'invalid' as const };
      // Rotated moments ago: almost certainly a second tab racing the first, whose new cookie is already valid.
      // Reject this request but do NOT revoke the family (that would log the user out everywhere).
      if (token.revoked_at && token.just_rotated) return { kind: 'race' as const };
      if (token.revoked_at) {
        await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [
          token.family_id,
        ]);
        return { kind: 'reuse' as const };
      }
      if (token.expires_at.getTime() <= Date.now()) return { kind: 'invalid' as const };

      const { rows: users } = await tx.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [token.user_id]);
      const session = await this.startSession(tx, users[0]!, token.family_id);
      await tx.query(
        `UPDATE refresh_tokens SET revoked_at = now(),
           replaced_by = (SELECT id FROM refresh_tokens WHERE token_hash = $2)
         WHERE id = $1`,
        [token.id, hashRefreshToken(session.refreshToken)],
      );
      return { kind: 'ok' as const, session };
    });
    // The reuse branch must COMMIT its revocation, so we throw only after the transaction ended.
    if (outcome.kind === 'race') throw new AppError(401, 'refresh_race', 'Token was just rotated, retry shortly');
    if (outcome.kind !== 'ok') throw unauthorized('Invalid or expired refresh token');
    return outcome.session;
  }

  /** Idempotent: revokes the token's whole family; unknown tokens are silently ignored. */
  async logout(rawToken: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE revoked_at IS NULL AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [hashRefreshToken(rawToken)],
    );
  }

  async getUser(id: string): Promise<PublicUser> {
    const { rows } = await this.db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    if (!rows[0]) throw new AppError(401, 'unauthorized', 'Account no longer exists');
    return toPublic(rows[0]);
  }

  private async startSession(tx: pg.PoolClient, user: UserRow, familyId: string): Promise<Session> {
    const refresh = newRefreshToken();
    await tx.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [user.id, refresh.hash, familyId, this.config.REFRESH_TOKEN_TTL_DAYS],
    );
    return {
      user: toPublic(user),
      accessToken: signAccessToken(this.config, { id: user.id, role: user.role }),
      refreshToken: refresh.raw,
    };
  }
}
