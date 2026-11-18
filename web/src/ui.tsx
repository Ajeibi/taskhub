import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, STATUS_LABEL, type Priority, type Status, type TaskCounts } from './api';

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export const errorMessage = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong');

export const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
export const fmtDateTime = (iso: string): string => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted" role="status">{label}</p>;
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="banner error" role="alert">
      <span>{errorMessage(error)}</span>
      {onRetry && <button className="link" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export const PriorityBadge = ({ p }: { p: Priority }) => <span className={`badge prio-${p}`}>{p}</span>;
export const StatusBadge = ({ s }: { s: Status }) => <span className={`badge status-${s}`}>{STATUS_LABEL[s]}</span>;

// ---- Visual primitives (ClickUp-style) -----------------------------------------------------------
export const STATUS_COLOR: Record<Status, string> = { todo: 'var(--s-todo)', in_progress: 'var(--s-progress)', in_review: 'var(--s-review)', done: 'var(--s-done)' };
const PALETTE = ['#7b68ee', '#e15bd5', '#4194f6', '#2fb67c', '#f2a100', '#e5484d', '#14a3b8', '#8b5cf6', '#e0762b', '#5b8def'];
export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] as string;
}
const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';

export function Avatar({ name, size }: { name?: string | null; size?: 'sm' | 'lg' }) {
  if (!name) return <span className={`avatar unassigned ${size ?? ''}`} title="Unassigned" aria-label="Unassigned">+</span>;
  return <span className={`avatar ${size ?? ''}`} style={{ background: colorFor(name) }} title={name} aria-hidden="true">{initials(name)}</span>;
}
export function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  return (
    <span className="avatars" aria-label={`${names.length} members`}>
      {names.slice(0, max).map((n) => <Avatar key={n} name={n} />)}
      {names.length > max && <span className="avatar" style={{ background: 'var(--faint)' }}>+{names.length - max}</span>}
    </span>
  );
}
export const ProjectIcon = ({ name, id, large }: { name: string; id: string; large?: boolean }) => (
  <span className={`proj-icon${large ? ' lg' : ''}`} style={{ background: colorFor(id) }} aria-hidden="true">{initials(name).slice(0, 1)}</span>
);

export function StatusIcon({ status, size = 16 }: { status: Status; size?: number }) {
  const c = STATUS_COLOR[status];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {status === 'done' ? (
        <><circle cx="8" cy="8" r="7" fill={c} /><path d="M4.6 8.2l2.3 2.3 4.5-4.8" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>
      ) : (
        <>
          <circle cx="8" cy="8" r="6.2" fill="none" stroke={c} strokeWidth="1.7" strokeDasharray={status === 'todo' ? '2.6 2.2' : undefined} />
          {status === 'in_progress' && <path d="M8 8 V3.2 A4.8 4.8 0 0 1 12.8 8 Z" fill={c} />}
          {status === 'in_review' && <path d="M8 8 V3.2 A4.8 4.8 0 1 1 3.2 8 Z" fill={c} />}
        </>
      )}
    </svg>
  );
}
export const StatusPill = ({ s, count }: { s: Status; count?: number }) => (
  <span className="status-pill" style={{ background: STATUS_COLOR[s] }}>{STATUS_LABEL[s]}{count !== undefined && <span style={{ opacity: .85 }}> {count}</span>}</span>
);

const PRIORITY_COLOR: Record<Priority, string> = { low: 'var(--p-low)', medium: 'var(--p-medium)', high: 'var(--p-high)', urgent: 'var(--p-urgent)' };
export function PriorityFlag({ p, label = true }: { p: Priority; label?: boolean }) {
  return (
    <span className="flag" title={`${p} priority`}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 14V2.5h8.6l-1.7 3 1.7 3H4.6V14z" fill={PRIORITY_COLOR[p]} /></svg>
      {label && p}
    </span>
  );
}

/** "Today", "Tomorrow", "Yesterday", else "Nov 20". */
export function fmtShortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  const days = Math.round((d.getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
export function DueDate({ iso, overdue }: { iso: string | null; overdue?: boolean }) {
  if (!iso) return <span className="due">—</span>;
  const days = Math.round((new Date(`${iso.slice(0, 10)}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  return <span className={`due${overdue ? ' late' : days <= 2 && days >= 0 ? ' soon' : ''}`}>{fmtShortDate(iso)}</span>;
}

/** Right-hand slide-over (task details). Escape and backdrop click close it. */
export function SlideOver({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="slideover" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>{children}</div>
    </div>
  );
}

export function ProgressBar({ counts }: { counts: TaskCounts }) {
  const pct = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);
  return (
    <div>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Completion">
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="muted small">
        {counts.total === 0 ? 'No tasks yet' : `${counts.done}/${counts.total} done (${pct}%)`}
        {counts.overdue > 0 && <span className="overdue"> · {counts.overdue} overdue</span>}
      </p>
    </div>
  );
}

/** Accessible modal: Escape closes, focus moves inside, clicking the backdrop closes. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <header><h2>{title}</h2><button className="icon" onClick={onClose} aria-label="Close">×</button></header>
        {children}
      </div>
    </div>
  );
}

/** Human-readable sentence for an audit-log event. */
export function describeEvent(e: { action: string; actor: { name: string } | null; task: { title: string } | null; metadata: Record<string, unknown> }): string {
  const who = e.actor?.name ?? 'Someone';
  const task = e.task ? `“${e.task.title}”` : 'a task';
  const m = e.metadata as { from?: string; to?: string; name?: string; email?: string; title?: string };
  switch (e.action) {
    case 'project.created': return `${who} created the project`;
    case 'project.updated': return `${who} updated the project`;
    case 'project.deleted': return `${who} deleted the project`;
    case 'project.ownership_transferred': return `${who} transferred ownership`;
    case 'member.added': return `${who} added ${m.email ?? 'a member'}`;
    case 'member.removed': return `${who} removed a member`;
    case 'task.created': return `${who} created ${task}`;
    case 'task.status_changed': return `${who} moved ${task} to ${STATUS_LABEL[m.to as Status] ?? m.to}`;
    case 'task.assigned': return `${who} ${m.to ? 'assigned' : 'unassigned'} ${task}`;
    case 'task.updated': return `${who} edited ${task}`;
    case 'task.deleted': return `${who} deleted ${m.title ? `“${m.title}”` : task}`;
    case 'comment.added': return `${who} commented on ${task}`;
    case 'comment.deleted': return `${who} removed a comment on ${task}`;
    default: return `${who}: ${e.action}`;
  }
}
