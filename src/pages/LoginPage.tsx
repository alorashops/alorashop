import { useState } from 'react';
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from '../lib/utils';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

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

function Brand() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
          display: 'grid',
          placeItems: 'center',
          color: '#fff',
          fontWeight: 800,
          fontSize: 20
        }}
      >
        A
      </span>
      <div>
        <h1 style={{ margin: 0 }}>AloraShop</h1>
      </div>
    </div>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-wrap">
      <div className="login-card">{children}</div>
    </div>
  );
}

function AuthShell() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const submit = async (e: React.FormEvent) => {
      e.preventDefault();
      setError('');
      // P10a: enforce the strength policy on SIGNUP only. Login must never be
      // gated here, or existing accounts whose stored password is shorter than
      // 8 characters would be locked out of the app.
      if (mode === 'signup' && !isStrongPassword(password)) {
        setError(PASSWORD_POLICY_MESSAGE);
        return;
      }
      setBusy(true);
      try {
        const auth = useAuthStore.getState();
        if (mode === 'login') {
          await auth.login(email.trim(), password);
        } else {
          // Sign up creates the account AND signs in immediately — no email
          // verification, no link, no expiry.
          await auth.signUp(email.trim(), password, displayName.trim() || email.trim());
        }
        navigate('/pos', { replace: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Something went wrong.';
        // Only realistic setup hiccup: "Confirm email" still ON in Supabase.
        setError(
          msg.toLowerCase().includes('email not confirmed')
            ? 'Account created, but email confirmation is still enabled in Supabase. Turn it OFF under Authentication → Sign In / Up → Email, then try again.'
            : msg
        );
      } finally {
        setBusy(false);
      }
    };

  const field = (value: string, set: (v: string) => void) => ({ value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value) });

  return (
    <Box>
      <Brand />
      <p className="sub">Offline-first POS. Your local database is the source of truth.</p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        {(['login', 'signup'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setError(''); }}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 8,
              border: '1px solid var(--border, #d1d5db)',
              background: mode === m ? 'var(--primary, #6366f1)' : 'transparent',
              color: mode === m ? '#fff' : 'var(--text, #0f172a)',
              fontWeight: 700
            }}
          >
            {m === 'login' ? 'Log in' : 'Sign up'}
          </button>
        ))}
      </div>

      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        {mode === 'signup' && (
          <div>
            <label style={labelStyle}>Shop owner name</label>
            <input {...field(displayName, setDisplayName)} style={inputStyle} placeholder="e.g. Kofi Mensah" autoComplete="name" required />
          </div>
        )}
        <div>
          <label style={labelStyle}>Email</label>
          <input type="email" {...field(email, setEmail)} style={inputStyle} placeholder="you@example.com" autoComplete="email" required />
        </div>
        <div>
          <label style={labelStyle}>Password</label>
          <div style={{ position: 'relative', marginTop: 6 }}>
            <input
              type={showPassword ? 'text' : 'password'}
              {...field(password, setPassword)}
              style={{ ...inputStyle, marginTop: 0, paddingRight: 44 }}
              placeholder={mode === 'login' ? 'Your password' : 'At least 8 characters (letter, number, symbol)'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'login' ? undefined : 8}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              title={showPassword ? 'Hide password' : 'Show password'}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: 18,
                padding: 4,
                lineHeight: 1,
                color: 'var(--text-muted, #64748b)'
              }}
            >
              {showPassword ? '🙈' : '👁️'}
                          </button>
                        </div>
                      </div>

                      {error && <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>}

                      <button className="btn" type="submit" disabled={busy} style={{ padding: '12px 0', fontWeight: 800 }}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>
    </Box>
  );
}

function CreateShop({ displayName }: { displayName: string }) {
  const navigate = useNavigate();
  const [shopName, setShopName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await useAuthStore.getState().createShop(shopName.trim(), phone.trim() || undefined);
      navigate('/pos', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create shop.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Brand />
      <p className="sub">
        Welcome, <strong>{displayName || 'friend'}</strong>! One last step — name your shop.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        <div>
          <label style={labelStyle}>Shop name</label>
          <input value={shopName} onChange={(e) => setShopName(e.target.value)} style={inputStyle} placeholder="e.g. Mensah Provision Store" required />
        </div>
        <div>
          <label style={labelStyle}>Shop phone (optional)</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} placeholder="e.g. 0244 000 000" inputMode="tel" />
        </div>
        {error && <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>}
        <button className="btn" type="submit" disabled={busy} style={{ padding: '12px 0', fontWeight: 800 }}>
          {busy ? 'Creating shop…' : 'Create my shop'}
        </button>
      </form>
    </Box>
  );
}

export default function LoginPage() {
  const booted = useAuthStore((s) => s.booted);
  const user = useAuthStore((s) => s.user);

  if (!booted) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--primary)' }}>AloraShop</div>
          <div style={{ color: 'var(--text-muted)', marginTop: 8 }}>Starting…</div>
        </div>
      </div>
    );
  }

  if (user) {
    if (!user.shopId) return <CreateShop displayName={user.displayName} />;
    return <Navigate to="/pos" replace />;
  }

  return <AuthShell />;
}