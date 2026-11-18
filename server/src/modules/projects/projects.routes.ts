import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db.js';
import { asyncHandler, parse } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { pageParams } from '../../pagination.js';
import { ProjectService } from './projects.service.js';

const status = z.enum(['active', 'completed', 'archived']);
const idParams = z.object({ id: z.uuid() });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5000).default(''),
});
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(5000).optional(),
    status: status.optional(),
    version: z.number().int().min(1), // required: the version the client last saw (optimistic locking)
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.status !== undefined, {
    message: 'Provide at least one field to change',
  });
const listSchema = z.object({ q: z.string().trim().max(100).optional(), status: status.optional(), ...pageParams });
const addMemberSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) });
const transferSchema = z.object({ role: z.literal('owner') });

export function projectsRouter(db: Db, config: Config): Router {
  const router = Router();
  const service = new ProjectService(db);
  router.use(authenticate(config)); // everything below requires a logged-in user

  router.post('/', asyncHandler(async (req, res) => {
    res.status(201).json(await service.create(currentUser(req), parse(createSchema, req.body)));
  }));

  router.get('/', asyncHandler(async (req, res) => {
    res.json(await service.list(currentUser(req), parse(listSchema, req.query)));
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json(await service.get(currentUser(req), parse(idParams, req.params).id));
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json(await service.update(currentUser(req), id, parse(updateSchema, req.body)));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    await service.remove(currentUser(req), parse(idParams, req.params).id);
    res.status(204).end();
  }));

  router.get('/:id/members', asyncHandler(async (req, res) => {
    res.json({ items: await service.listMembers(currentUser(req), parse(idParams, req.params).id) });
  }));

  router.post('/:id/members', asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.status(201).json(await service.addMember(currentUser(req), id, parse(addMemberSchema, req.body).email));
  }));

  // Body {role: 'owner'} promotes this member and demotes the current owner.
  router.patch('/:id/members/:userId', asyncHandler(async (req, res) => {
    const { id, userId } = parse(memberParams, req.params);
    parse(transferSchema, req.body);
    res.json({ items: await service.transferOwnership(currentUser(req), id, userId) });
  }));

  router.delete('/:id/members/:userId', asyncHandler(async (req, res) => {
    const { id, userId } = parse(memberParams, req.params);
    await service.removeMember(currentUser(req), id, userId);
    res.status(204).end();
  }));

  return router;
}
