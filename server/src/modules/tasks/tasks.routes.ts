import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db.js';
import { asyncHandler, parse } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { pageParams } from '../../pagination.js';
import { CommentService } from './comments.service.js';
import { TaskService, type Priority, type Status } from './tasks.service.js';

const STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const status = z.enum(STATUSES);
const priority = z.enum(PRIORITIES);

// Real calendar date, not just a pattern: rejects 2024-02-30.
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    // Zod runs every check even when the regex already failed, so this must never throw on garbage input.
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, 'Not a valid date');

/** "todo,in_progress" -> ['todo','in_progress'] validated against the enum. */
const csv = <const V extends readonly [string, ...string[]]>(values: V) =>
  z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.enum(values)).min(1).max(4));

const listFields = {
  q: z.string().trim().max(100).optional(),
  status: csv(STATUSES).optional(),
  priority: csv(PRIORITIES).optional(),
  assignee: z.union([z.literal('me'), z.literal('none'), z.uuid()]).optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  ...pageParams,
};

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10000).default(''),
  priority: priority.default('medium'),
  assigneeId: z.uuid().nullable().optional(),
  dueDate: dateOnly.nullable().optional(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(10000).optional(),
    status: status.optional(),
    priority: priority.optional(),
    assigneeId: z.uuid().nullable().optional(), // null = unassign
    dueDate: dateOnly.nullable().optional(), // null = clear
    version: z.number().int().min(1), // the version the client last saw (optimistic locking)
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'version' && v[k as keyof typeof v] !== undefined), {
    message: 'Provide at least one field to change',
  });

const commentBody = z.object({ body: z.string().trim().min(1).max(5000) });
const idParams = z.object({ id: z.uuid() });
const projectParams = z.object({ projectId: z.uuid() });
const commentParams = z.object({ id: z.uuid(), commentId: z.uuid() });
const commentList = z.object({ cursor: pageParams.cursor, limit: z.coerce.number().int().min(1).max(100).default(50) });

/** Tasks of one project: /api/projects/:projectId/tasks */
export function projectTasksRouter(db: Db, config: Config): Router {
  const router = Router({ mergeParams: true });
  const service = new TaskService(db);
  router.use(authenticate(config));

  router.post('/', asyncHandler(async (req, res) => {
    const { projectId } = parse(projectParams, req.params);
    res.status(201).json(await service.create(currentUser(req), projectId, parse(createSchema, req.body)));
  }));

  router.get('/', asyncHandler(async (req, res) => {
    const { projectId } = parse(projectParams, req.params);
    const filters = parse(z.object(listFields), req.query);
    res.json(await service.list(currentUser(req), { ...filters, projectId, status: filters.status as Status[] | undefined, priority: filters.priority as Priority[] | undefined }));
  }));

  return router;
}

/** Cross-project and single-task endpoints: /api/tasks */
export function tasksRouter(db: Db, config: Config): Router {
  const router = Router();
  const tasks = new TaskService(db);
  const comments = new CommentService(db);
  router.use(authenticate(config));

  // All tasks the caller can see (every project they belong to): "my tasks", global search.
  router.get('/', asyncHandler(async (req, res) => {
    const filters = parse(z.object({ projectId: z.uuid().optional(), ...listFields }), req.query);
    res.json(await tasks.list(currentUser(req), { ...filters, status: filters.status as Status[] | undefined, priority: filters.priority as Priority[] | undefined }));
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json(await tasks.get(currentUser(req), parse(idParams, req.params).id));
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json(await tasks.update(currentUser(req), id, parse(updateSchema, req.body)));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    await tasks.remove(currentUser(req), parse(idParams, req.params).id);
    res.status(204).end();
  }));

  router.get('/:id/comments', asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json(await comments.list(currentUser(req), id, parse(commentList, req.query)));
  }));

  router.post('/:id/comments', asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.status(201).json(await comments.add(currentUser(req), id, parse(commentBody, req.body).body));
  }));

  router.patch('/:id/comments/:commentId', asyncHandler(async (req, res) => {
    const { id, commentId } = parse(commentParams, req.params);
    res.json(await comments.edit(currentUser(req), id, commentId, parse(commentBody, req.body).body));
  }));

  router.delete('/:id/comments/:commentId', asyncHandler(async (req, res) => {
    const { id, commentId } = parse(commentParams, req.params);
    await comments.remove(currentUser(req), id, commentId);
    res.status(204).end();
  }));

  return router;
}
