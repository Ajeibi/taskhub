import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { ErrorBanner } from '../ui';

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register(name, email, password);
    } catch (err) { setError(err); setBusy(false); }
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <h1>TaskHub</h1>
        <p className="muted">{mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}</p>
        <ErrorBanner error={error} />
        {mode === 'register' && (
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" /></label>
        )}
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label>
        <label>Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'register' ? 10 : 1}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        {mode === 'register' && <p className="muted small">At least 10 characters.</p>}
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <p className="small center">
          {mode === 'login' ? 'New here? ' : 'Have an account? '}
          <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </form>
    </main>
  );
}
