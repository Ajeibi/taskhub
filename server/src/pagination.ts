import { z } from 'zod';
import { badRequest } from './errors.js';

// Keyset ("cursor") pagination: instead of OFFSET n (which makes the database read and discard n rows,
// so page 10,000 is slow), we remember the last row's sort key and ask for rows after it. The cost of
// every page is the same, and rows inserted while paging cannot cause skipped/duplicated items.
//
// IMPORTANT: `t` carries the timestamp as Postgres TEXT (microsecond precision). A JS Date only keeps
// milliseconds, which would make the cursor compare unequal to the real row and skip or repeat rows
// created within the same millisecond.
export interface Cursor {
  t: string;
  id: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;
const cursorSchema = z.object({ t: z.string().regex(TIMESTAMP), id: z.uuid() });

export const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

export function decodeCursor(raw: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('Invalid cursor');
  }
}

export const pageParams = {
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Callers fetch limit+1 rows; the extra row only tells us whether another page exists. */
export function toPage<R, T>(rows: R[], limit: number, map: (r: R) => T, cursorOf: (r: R) => Cursor): Page<T> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return { items: slice.map(map), nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null };
}
