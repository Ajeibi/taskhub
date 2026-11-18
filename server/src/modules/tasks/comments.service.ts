import { withTransaction, type Db } from '../../db.js';
import { forbidden, notFound } from '../../errors.js';
import { decodeCursor, toPage, type Page } from '../../pagination.js';
import { logActivity } from '../activity/activity.js';
import type { AuthUser } from '../auth/tokens.js';
import { requireWritable } from '../projects/access.js';
import { requireTask } from './task-access.js';

export interface CommentDto {
  id: string;
  taskId: string;
  author: { id: string; name: string };
  body: string;
  createdAt: string;
  edited: boolean;
}

interface Row {
  id: string; task_id: string; author_id: string; author_name: string;
  body: string; created_at: Date; updated_at: Date; created_at_raw: string;
}

const SELECT = `SELECT c.id, c.task_id, c.author_id, u.name AS author_name, c.body, c.created_at, c.updated_at,
                       c.created_at::text AS created_at_raw
                  FROM comments c JOIN users u ON u.id = c.author_id`;

const toDto = (r: Row): CommentDto => ({
  id: r.id,
  taskId: r.task_id,
  author: { id: r.author_id, name: r.author_name },
  body: r.body,
  createdAt: r.created_at.toISOString(),
  edited: r.updated_at.getTime() > r.created_at.getTime(),
});

export class CommentService {
  constructor(private readonly db: Db) {}

  /** Oldest first (a conversation reads top to bottom), keyset-paginated like everything else. */
  async list(user: AuthUser, taskId: string, query: { cursor?: string; limit: number }): Promise<Page<CommentDto>> {
    await requireTask(this.db, taskId, user);
    const params: unknown[] = [taskId];
    let cursorSql = '';
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      params.push(c.t, c.id);
      cursorSql = `AND (c.created_at, c.id) > ($2::timestamptz, $3::uuid)`;
    }
    params.push(query.limit + 1);
    const { rows } = await this.db.query<Row>(
      `${SELECT} WHERE c.task_id = $1 AND c.deleted_at IS NULL ${cursorSql}
        ORDER BY c.created_at, c.id LIMIT $${params.length}`,
      params,
    );
    return toPage(rows, query.limit, toDto, (r) => ({ t: r.created_at_raw, id: r.id }));
  }

  async add(user: AuthUser, taskId: string, body: string): Promise<CommentDto> {
    return withTransaction(this.db, async (tx) => {
      const { task, access } = await requireTask(tx, taskId, user);
      requireWritable(access);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO comments (task_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
        [taskId, user.id, body],
      );
      await logActivity(tx, { projectId: task.project_id, taskId, actorId: user.id, action: 'comment.added', metadata: { commentId: rows[0]!.id } });
      const { rows: out } = await tx.query<Row>(`${SELECT} WHERE c.id = $1`, [rows[0]!.id]);
      return toDto(out[0]!);
    });
  }

  /** Only the author may edit their own comment, even the project owner may not rewrite someone's words. */
  async edit(user: AuthUser, taskId: string, commentId: string, body: string): Promise<CommentDto> {
    return withTransaction(this.db, async (tx) => {
      const { access } = await requireTask(tx, taskId, user);
      requireWritable(access);
      const { rows } = await tx.query<{ author_id: string }>(
        `SELECT author_id FROM comments WHERE id = $1 AND task_id = $2 AND deleted_at IS NULL`,
        [commentId, taskId],
      );
      if (!rows[0]) throw notFound('Comment');
      if (rows[0].author_id !== user.id) throw forbidden('You can only edit your own comments');
      await tx.query(`UPDATE comments SET body = $2, updated_at = now() WHERE id = $1`, [commentId, body]);
      const { rows: out } = await tx.query<Row>(`${SELECT} WHERE c.id = $1`, [commentId]);
      return toDto(out[0]!);
    });
  }

  /** The author can delete their comment; the project owner/admin can moderate any comment. */
  async remove(user: AuthUser, taskId: string, commentId: string): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const { task, access } = await requireTask(tx, taskId, user);
      requireWritable(access);
      const { rows } = await tx.query<{ author_id: string }>(
        `SELECT author_id FROM comments WHERE id = $1 AND task_id = $2 AND deleted_at IS NULL`,
        [commentId, taskId],
      );
      if (!rows[0]) throw notFound('Comment');
      if (rows[0].author_id !== user.id && access.role === 'member') {
        throw forbidden('Only the author or the project owner can delete this comment');
      }
      await tx.query(`UPDATE comments SET deleted_at = now() WHERE id = $1`, [commentId]);
      await logActivity(tx, { projectId: task.project_id, taskId, actorId: user.id, action: 'comment.deleted', metadata: { commentId } });
    });
  }
}
