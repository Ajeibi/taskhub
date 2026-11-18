import { useState } from 'react';
import { qs, type Task } from '../api';
import { usePaged } from '../hooks';
import { ErrorBanner, Spinner, useDebounced } from '../ui';
import { NO_FILTERS, TaskFilters, TaskModal, TaskRow, type Filters } from './TaskParts';

/** Every task in every project I belong to. Same filters and paging as a project board. */
export default function Tasks() {
  const [filters, setFilters] = useState<Filters>({ ...NO_FILTERS, assignee: 'me' });
  const q = useDebounced(filters.q);
  const list = usePaged<Task>(`/api/tasks${qs({ q, status: filters.status, priority: filters.priority, assignee: filters.assignee, overdue: filters.overdue, limit: 25 })}`);
  const [openId, setOpenId] = useState<string | null>(null);

  const replace = (t: Task) => list.setItems((items) => items.map((x) => (x.id === t.id ? t : x)));
  return (
    <>
      <h1>Tasks</h1>
      <TaskFilters value={filters} onChange={setFilters} />
      <ErrorBanner error={list.error} onRetry={list.reload} />
      {list.loading && list.items.length === 0 ? <Spinner /> : list.items.length === 0 && !list.error ? (
        <p className="card muted">No tasks match these filters.</p>
      ) : (
        <ul className="card tasks">
          {list.items.map((t) => <TaskRow key={t.id} task={t} showProject onOpen={(x) => setOpenId(x.id)} onUpdated={replace} />)}
        </ul>
      )}
      {list.hasMore && <button className="center-btn" onClick={list.loadMore} disabled={list.loading}>{list.loading ? 'Loading…' : 'Load more'}</button>}
      {openId && <TaskModal taskId={openId} onClose={() => setOpenId(null)} onChanged={replace} onDeleted={(id) => list.setItems((i) => i.filter((x) => x.id !== id))} />}
    </>
  );
}
