import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { ErrorBanner } from '../ui';

// A static, decorative preview of the product for the left-hand panel.
const PREVIEW = [
  { title: 'Finalise launch checklist', status: 'var(--s-progress)', label: 'In progress', who: 'AM', color: '#e15bd5' },
  { title: 'Review onboarding copy', status: 'var(--s-review)', label: 'In review', who: 'JO', color: '#4194f6' },
  { title: 'Ship billing settings page', status: 'var(--s-done)', label: 'Done', who: 'KT', color: '#2fb67c' },
  { title: 'Plan Q1 roadmap workshop', status: 'var(--s-todo)', label: 'To do', who: 'RS', color: '#f2a100' },
];

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const isLogin = mode === 'login';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (isLogin) await login(email, password);
      else await register(name, email, password);
    } catch (err) { setError(err); setBusy(false); }
  }

  return (
    <main className="auth">
      <aside className="auth-hero" aria-hidden="true">
        <div className="auth-brand"><span className="logo">T</span>TaskHub</div>

        <div className="auth-hero-body">
        <div className="auth-pitch">
          <h2>Plan, track and ship work together.</h2>
          <p>Projects, tasks and deadlines for your whole team — in a list, on a board, or at a glance on your dashboard.</p>
        </div>

        <div className="auth-preview">
          <div className="auth-preview-head">
            <span className="dot" style={{ background: '#e15bd5' }} />
            <strong>Website relaunch</strong>
            <span className="auth-preview-meta">12 of 18 done</span>
          </div>
          <div className="auth-preview-bar"><div style={{ width: '66%' }} /></div>
          <ul>
            {PREVIEW.map((t) => (
              <li key={t.title}>
                <span className="dot" style={{ background: t.status }} />
                <span className="t">{t.title}</span>
                <span className="pill" style={{ color: t.status }}>{t.label}</span>
                <span className="av" style={{ background: t.color }}>{t.who}</span>
              </li>
            ))}
          </ul>
        </div>
        </div>

        <ul className="auth-points">
          <li>Drag-and-drop boards</li>
          <li>Assignees &amp; due dates</li>
          <li>Comments &amp; live activity</li>
        </ul>
      </aside>

      <section className="auth-form">
        <form onSubmit={submit}>
          <div className="auth-brand mobile-only"><span className="logo">T</span>TaskHub</div>
          <header>
            <h1>{isLogin ? 'Welcome back' : 'Create your account'}</h1>
            <p>{isLogin ? 'Sign in to pick up where you left off.' : 'Get your team organised in under a minute.'}</p>
          </header>

          <ErrorBanner error={error} />

          {!isLogin && (
            <label className="field">Name
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" placeholder="Ada Lovelace" />
            </label>
          )}
          <label className="field">Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@company.com" />
          </label>
          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <div className="pw-wrap">
              <input id="auth-password" type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required
                minLength={isLogin ? 1 : 10} autoComplete={isLogin ? 'current-password' : 'new-password'}
                placeholder={isLogin ? '••••••••••' : 'At least 10 characters'} />
              <button type="button" className="pw-toggle" aria-pressed={showPw} onClick={() => setShowPw((v) => !v)}>
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
            {!isLogin && <span className="hint">Use 10 or more characters.</span>}
          </div>

          <button className="primary auth-submit" disabled={busy}>
            {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
          </button>

          <p className="auth-switch">
            {isLogin ? 'New to TaskHub? ' : 'Already have an account? '}
            <button type="button" className="link" onClick={() => { setMode(isLogin ? 'register' : 'login'); setError(null); }}>
              {isLogin ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </form>
      </section>
    </main>
  );
}
