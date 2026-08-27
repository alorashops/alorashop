import { useEffect, useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { updatePassword, hasActiveSession } from '../services/supabase';

const inputStyle: React.CSSProperties = {
  width: '100%',
  marginTop: 6,
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--border, #d1d5db)',
  background: 'var(--bg, #fff)',
  color: 'var(--text, #0f172a)',
  fontSize: 15
};
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600 };

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-wrap">
      <div className="login-card">{children}</div>
    </div>
  );
}

/**
 * Staff invite / password-reset landing page.
 *
 * The invite email carries a recovery link that lands HERE (Supabase's
 * password-recovery flow). On mount we give supabase-js a beat to swap the
 * recovery token into a real session, then let the user pick their own
 * password. Setting it via updateUser() confirms the account; they can then
 * log in normally.
 */
export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    void hasActiveSession().then((ok) => {
      if (!mounted) return;
      if (ok) setReady(true);
      else setError('This invite link is invalid or has expired. Ask an administrator to re-send it.');
    });
    return () => {
      mounted = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (pw.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (pw !== pw2) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await updatePassword(pw);
      await useAuthStore.getState().initialize();
      setInfo('Password set — you can now sign in.');
      setTimeout(() => navigate('/pos', { replace: true }), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const user = useAuthStore((s) => s.user);
  if (user && user.shopId) return <Navigate to="/pos" replace />;

  return (
    <Box>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 20 }}>A</span>
        <h1 style={{ margin: 0 }}>AloraShop</h1>
      </div>
      <p className="sub">Welcome to your team — set a password to activate your account.</p>

      {!ready ? (
        <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 12 }}>
          {error || 'Verifying your invite link…'}
        </p>
      ) : (
        <form onSubmit={submit} style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          <div>
            <label style={labelStyle}>New password</label>
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              style={inputStyle}
              placeholder="At least 6 characters"
              minLength={6}
              autoFocus
              required
            />
          </div>
          <div>
            <label style={labelStyle}>Confirm password</label>
            <input
              type="password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              style={inputStyle}
              placeholder="Re-enter password"
              minLength={6}
              required
            />
          </div>
          {error && <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>}
          {info && <div style={{ color: '#16a34a', fontSize: 13 }}>{info}</div>}
          <button className="btn" type="submit" disabled={busy} style={{ padding: '12px 0', fontWeight: 800 }}>
            {busy ? 'Setting password…' : 'Set password'}
          </button>
        </form>
      )}

      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ marginTop: 12 }}
        onClick={() => navigate('/login')}
      >
        ← Back to log in
      </button>
    </Box>
  );
}