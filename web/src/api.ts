// ---- Types mirroring the API ------------------------------------------------------------------
export type Status = 'todo' | 'in_progress' | 'in_review' | 'done';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type ProjectStatus = 'active' | 'completed' | 'archived';

export const STATUSES: Status[] = ['todo', 'in_progress', 'in_review', 'done'];
export const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];
export const STATUS_LABEL: Record<Status, string> = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done' };

export interface User { id: string; email: string; name: string; role: 'admin' | 'user' }
export interface TaskCounts { total: number; todo: number; inProgress: number; inReview: number; done: number; overdue: number }
export interface Project {
  id: string; name: string; description: string; status: ProjectStatus; version: number;
  createdAt: string; myRole: 'owner' | 'member' | 'admin'; taskCounts: TaskCounts;
}
export interface Member { userId: string; name: string; email: string; role: 'owner' | 'member' }
export interface ProjectDetail extends Project { members: Member[] }
export interface Task {
  id: string; projectId: string; projectName: string; title: string; description: string;
  status: Status; priority: Priority; assignee: { id: string; name: string } | null;
  creator: { id: string; name: string }; dueDate: string | null; isOverdue: boolean;
  completedAt: string | null; version: number; createdAt: string;
}
export interface TaskDetail extends Task { commentCount: number }
export interface Comment { id: string; author: { id: string; name: string }; body: string; createdAt: string; edited: boolean }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface ActivityEvent {
  id: string; action: string; createdAt: string; metadata: Record<string, unknown>;
  actor: { id: string; name: string } | null; project: { id: string; name: string }; task: { id: string; title: string } | null;
}
export interface Dashboard {
  projects: { total: number; active: number; completed: number; archived: number };
  tasks: {
    total: number; byStatus: { todo: number; inProgress: number; inReview: number; done: number };
    openByPriority: Record<Priority, number>; overdue: number; dueNext7Days: number; unassigned: number; completedLast7Days: number;
  };
  mine: { open: number; overdue: number; dueNext7Days: number };
  upcoming: Array<{ id: string; title: string; priority: Priority; status: Status; dueDate: string; isOverdue: boolean; projectId: string; projectName: string }>;
  recentActivity: ActivityEvent[];
}

// ---- HTTP client ------------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
  get isConflict(): boolean { return this.status === 409; }
}

interface SessionResponse { user: User; accessToken: string }

// The access token lives only in memory: nothing persisted for XSS to steal. A page reload restores the
// session from the httpOnly refresh cookie.
let accessToken: string | null = null;
let onSessionLost: () => void = () => {};
export const setSessionLostHandler = (fn: () => void): void => { onSessionLost = fn; };

async function parseError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null);
  return new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? `Request failed (${res.status})`, body?.error?.details);
}

// Single-flight refresh. Refresh tokens are single-use with reuse detection: if two parallel requests
// each tried to refresh with the same cookie, the second would look like token theft and log the user out.
let refreshing: Promise<SessionResponse | null> | null = null;
export function refreshSession(): Promise<SessionResponse | null> {
  refreshing ??= (async () => {
    try {
      let res = await fetch('/api/auth/refresh', { method: 'POST' });
      // Another tab rotated the (shared) cookie a moment ago; its response has set the new one, so try again once.
      if (res.status === 401 && (await res.clone().json().catch(() => null))?.error?.code === 'refresh_race') {
        await new Promise((r) => setTimeout(r, 300));
        res = await fetch('/api/auth/refresh', { method: 'POST' });
      }
      if (!res.ok) { accessToken = null; return null; }
      const session = (await res.json()) as SessionResponse;
      accessToken = session.accessToken;
      return session;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const send = (): Promise<Response> =>
    fetch(path, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  let res = await send();
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    const session = await refreshSession(); // access token expired: transparently get a new one and retry once
    if (!session) { onSessionLost(); throw await parseError(res); }
    res = await send();
  }
  if (!res.ok) throw await parseError(res);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function login(email: string, password: string): Promise<User> {
  const s = await api<SessionResponse>('/api/auth/login', { method: 'POST', body: { email, password } });
  accessToken = s.accessToken;
  return s.user;
}
export async function register(name: string, email: string, password: string): Promise<User> {
  const s = await api<SessionResponse>('/api/auth/register', { method: 'POST', body: { name, email, password } });
  accessToken = s.accessToken;
  return s.user;
}
export async function logout(): Promise<void> {
  try { await api('/api/auth/logout', { method: 'POST' }); } finally { accessToken = null; }
}

/** Builds "?a=1&b=2", skipping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// Test hook
export const __test = { reset: () => { accessToken = null; refreshing = null; }, token: () => accessToken };
