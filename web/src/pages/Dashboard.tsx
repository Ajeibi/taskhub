import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, PRIORITIES, STATUS_LABEL, type Dashboard as Data } from '../api';
import { describeEvent, ErrorBanner, fmtDate, fmtDateTime, PriorityBadge, Spinner } from '../ui';

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' | 'warn' | 'good' }) {
  return <div className={`stat ${tone ?? ''}`}><strong>{value}</strong><span>{label}</span></div>;
}

function Bars({ rows }: { rows: Array<{ label: string; value: number; cls: string }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span>{r.label}</span>
          <div className="track"><div className={r.cls} style={{ width: `${(r.value / max) * 100}%` }} /></div>
          <b>{r.value}</b>
        </li>
      ))}
    </ul>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => { setError(null); api<Data>('/api/dashboard').then(setData).catch(setError); }, []);
  useEffect(load, [load]);

  if (error) return <ErrorBanner error={error} onRetry={load} />;
  if (!data) return <Spinner />;
  const { projects, tasks, mine, upcoming, recentActivity } = data;

  return (
    <>
      <h1>Dashboard</h1>
      <section aria-label="Overview" className="stats">
        <Stat label="Active projects" value={projects.active} />
        <Stat label="Open tasks" value={tasks.total - tasks.byStatus.done} />
        <Stat label="Overdue" value={tasks.overdue} tone={tasks.overdue ? 'bad' : undefined} />
        <Stat label="Due in 7 days" value={tasks.dueNext7Days} tone={tasks.dueNext7Days ? 'warn' : undefined} />
        <Stat label="Unassigned" value={tasks.unassigned} />
        <Stat label="Done this week" value={tasks.completedLast7Days} tone="good" />
      </section>

      <div className="grid2">
        <section className="card">
          <h2>My work</h2>
          <div className="stats small-stats">
            <Stat label="Open" value={mine.open} />
            <Stat label="Overdue" value={mine.overdue} tone={mine.overdue ? 'bad' : undefined} />
            <Stat label="Due in 7 days" value={mine.dueNext7Days} />
          </div>
          <h3>Next deadlines</h3>
          {upcoming.length === 0 ? <p className="muted">Nothing with a deadline is assigned to you.</p> : (
            <ul className="list">
              {upcoming.map((t) => (
                <li key={t.id}>
                  <Link to={`/projects/${t.projectId}?task=${t.id}`}>{t.title}</Link>
                  <span className="muted small"> {t.projectName}</span>
                  <span className="right"><PriorityBadge p={t.priority} /> <span className={t.isOverdue ? 'overdue' : 'muted small'}>{fmtDate(t.dueDate)}</span></span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Workload</h2>
          <h3>By status</h3>
          <Bars rows={[
            { label: STATUS_LABEL.todo, value: tasks.byStatus.todo, cls: 'b-todo' },
            { label: STATUS_LABEL.in_progress, value: tasks.byStatus.inProgress, cls: 'b-progress' },
            { label: STATUS_LABEL.in_review, value: tasks.byStatus.inReview, cls: 'b-review' },
            { label: STATUS_LABEL.done, value: tasks.byStatus.done, cls: 'b-done' },
          ]} />
          <h3>Open by priority</h3>
          <Bars rows={PRIORITIES.map((p) => ({ label: p, value: tasks.openByPriority[p], cls: `b-${p}` }))} />
        </section>
      </div>

      <section className="card">
        <h2>Recent activity</h2>
        {recentActivity.length === 0 ? <p className="muted">No activity yet. <Link to="/projects">Create a project</Link> to get started.</p> : (
          <ul className="list feed">
            {recentActivity.map((e) => (
              <li key={e.id}>
                <span>{describeEvent(e)}</span>
                <span className="muted small"> in <Link to={`/projects/${e.project.id}`}>{e.project.name}</Link></span>
                <span className="right muted small">{fmtDateTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
