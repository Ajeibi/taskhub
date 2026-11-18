import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, PRIORITIES, STATUS_LABEL, type Dashboard as Data } from '../api';
import { useAuth } from '../auth';
import { Avatar, describeEvent, DueDate, ErrorBanner, fmtDateTime, PriorityFlag, Spinner, StatusIcon } from '../ui';

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' | 'warn' | 'good' | 'info' }) {
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

const greeting = (): string => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => { setError(null); api<Data>('/api/dashboard').then(setData).catch(setError); }, []);
  useEffect(load, [load]);

  if (error) return <div className="page-body"><ErrorBanner error={error} onRetry={load} /></div>;
  if (!data) return <div className="page-body"><Spinner /></div>;
  const { projects, tasks, mine, upcoming, recentActivity } = data;

  return (
    <div className="page-body">
      <div className="home-title">
        <h1>{greeting()}, {user?.name.split(' ')[0]}</h1>
        <p className="muted">Here is what is happening across your projects.</p>
      </div>

      <section aria-label="Overview" className="stats">
        <Stat label="Active projects" value={projects.active} tone="info" />
        <Stat label="Open tasks" value={tasks.total - tasks.byStatus.done} tone="info" />
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
                  <div className="deadline">
                    <StatusIcon status={t.status} />
                    <div className="grow">
                      <Link to={`/projects/${t.projectId}?task=${t.id}`}>{t.title}</Link>
                      <div className="muted small">{t.projectName}</div>
                    </div>
                    <PriorityFlag p={t.priority} label={false} />
                    <DueDate iso={t.dueDate} overdue={t.isOverdue} />
                  </div>
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
        {recentActivity.length === 0 ? <p className="muted">No activity yet. <Link to="/projects?new=1">Create a project</Link> to get started.</p> : (
          <ul className="list feed">
            {recentActivity.map((e) => (
              <li key={e.id}>
                <Avatar name={e.actor?.name ?? '?'} />
                <div className="grow">
                  {describeEvent(e)}
                  <span className="muted small"> in <Link to={`/projects/${e.project.id}`}>{e.project.name}</Link></span>
                </div>
                <span className="when muted small">{fmtDateTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
