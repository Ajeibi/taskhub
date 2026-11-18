// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Task } from './api';
import Login from './pages/Login';
import { TaskPanel, TaskRow } from './pages/TaskParts';
import { fmtShortDate } from './ui';

const auth = vi.hoisted(() => ({ login: vi.fn(), register: vi.fn() }));
vi.mock('./auth', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Ada Lovelace', role: 'user' }, ...auth }) }));

const isoDay = (offset: number): string => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', projectId: 'p1', projectName: 'Website', title: 'Write copy', description: '', status: 'todo', priority: 'medium',
  assignee: null, creator: { id: 'u1', name: 'Ada Lovelace' }, dueDate: null, isOverdue: false, completedAt: null, version: 1, createdAt: '2026-11-01T00:00:00Z',
  ...over,
});

afterEach(cleanup);

describe('fmtShortDate', () => {
  it('uses friendly words near today and a short date otherwise', () => {
    expect(fmtShortDate(isoDay(0))).toBe('Today');
    expect(fmtShortDate(isoDay(1))).toBe('Tomorrow');
    expect(fmtShortDate(isoDay(-1))).toBe('Yesterday');
    expect(fmtShortDate(null)).toBe('');
  });
});

describe('TaskRow', () => {
  const renderRow = (t: Task) => {
    const onOpen = vi.fn(); const onStatus = vi.fn();
    render(<MemoryRouter><ul><TaskRow task={t} onOpen={onOpen} onStatus={onStatus} /></ul></MemoryRouter>);
    return { onOpen, onStatus };
  };

  it('marks an open task done from the status icon', async () => {
    const { onStatus } = renderRow(task());
    await userEvent.click(screen.getByRole('button', { name: /mark write copy done/i }));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), 'done');
  });

  it('reopens a done task', async () => {
    const { onStatus } = renderRow(task({ status: 'done' }));
    await userEvent.click(screen.getByRole('button', { name: /reopen write copy/i }));
    expect(onStatus).toHaveBeenCalledWith(expect.anything(), 'todo');
  });

  it('opens the task when the title is clicked', async () => {
    const { onOpen } = renderRow(task());
    await userEvent.click(screen.getByRole('button', { name: 'Write copy' }));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe('Login', () => {
  beforeEach(() => { auth.login.mockReset(); auth.register.mockReset(); });

  it('shows the server error and stays on the form when sign-in fails', async () => {
    auth.login.mockRejectedValue(new ApiError(401, 'unauthorized', 'Invalid email or password'));
    render(<Login />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.io');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled(); // not stuck on "Please wait"
  });

  it('switches to registration, which asks for a name and a 10+ character password', async () => {
    render(<Login />);
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('minlength', '10');
  });
});

describe('TaskPanel saving', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('queues quick successive edits so each save carries the version returned by the previous one', async () => {
    let version = 1;
    const patchBodies: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(init.body!);
        patchBodies.push(body);
        if (body.version !== version) return json(409, { error: { code: 'conflict', message: 'stale' } }); // what the real server does
        version += 1;
        return json(200, task({ version, status: body.status ?? 'todo', priority: body.priority ?? 'medium' }));
      }
      if (url.endsWith('/comments?limit=100')) return json(200, { items: [], nextCursor: null });
      if (url === '/api/projects/p1') return json(200, { id: 'p1', status: 'active', myRole: 'owner', members: [{ userId: 'u1', name: 'Ada Lovelace', email: 'a@b.io', role: 'owner' }] });
      return json(200, { ...task({ version }), commentCount: 0 });
    });

    render(<MemoryRouter><TaskPanel taskId="t1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} /></MemoryRouter>);
    const status = await screen.findByLabelText('Status');
    // No awaiting between the two changes: the second fires while the first request is still in flight.
    const user = userEvent.setup({ delay: null });
    void user.selectOptions(status, 'in_progress');
    void user.selectOptions(screen.getByLabelText('Priority'), 'urgent');

    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies.map((b) => b.version)).toEqual([1, 2]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // no false "someone else changed this"
  });
});
