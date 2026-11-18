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
