import { useState } from 'react';
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
  const [info, setInfo] = useState('');
  /** True after a signup that needs email confirmation — swaps the form for a
      "check your email" panel with a one-tap link to the inbox. */
  const [pendingConfirmation, setPendingConfirmation] = useState(false);

  const confirmFromEmail = async () => {
    setError('');
    setInfo('');
    setBusy(true);
    try {
      const login = useAuthStore.getState().login;
      await login(email.trim(), password);
      navigate('/pos', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setBusy(true);
    try {
      if (mode === 'login') {
        const login = useAuthStore.getState().login;
        await login(email.trim(), password);
        navigate('/pos', { replace: true });
      } else {
        const signUp = useAuthStore.getState().signUp;
        const { requiresConfirmation } = await signUp(email.trim(), password, displayName.trim() || email.trim());
        if (requiresConfirmation) {
          setPendingConfirmation(true);
          setInfo('Almost there — we sent a verification email. Tap the link in it to confirm your address.');
        } else {
          navigate('/pos', { replace: true });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const field = (value: string, set: (v: string) => void) => ({ value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value) });

  // Which inbox the signup email is on — only Gmail / iCloud get a one-tap
  // button (per requirement); every other provider shows a plain hint.
  const emailDomain = email.trim().split('@')[1]?.toLowerCase() ?? '';
  const provider =
    emailDomain === 'gmail.com' ? 'gmail' : emailDomain === 'icloud.com' ? 'icloud' : 'other';

  if (pendingConfirmation) {
    return (
      <Box>
        <Brand />
        <p className="sub">Offline-first — your local database is your data.</p>
        <div style={{ padding: '8px 2px' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--primary, #6366f1)' }}>
            📩 Check your email
          </div>
          <p style={{ margin: '10px 0 4px', fontSize: 14 }}>
            We sent a confirmation link to <strong>{email.trim()}</strong>. Open the email and tap{' '}
            <strong>Confirm your email</strong> to verify your address.
          </p>

          {provider === 'gmail' && (
            <button
              type="button"
              className="btn btn-block"
              style={{ marginTop: 12, padding: '12px 0', fontWeight: 800 }}
              onClick={() => window.open('https://mail.google.com/', '_blank')}
            >
              Open Gmail ↗
            </button>
          )}
          {provider === 'icloud' && (
            <button
              type="button"
              className="btn btn-block"
              style={{ marginTop: 12, padding: '12px 0', fontWeight: 800 }}
              onClick={() => window.open('https://www.icloud.com/mail', '_blank')}
            >
              Open iCloud Mail ↗
            </button>
          )}
          {provider === 'other' && (
            <p style={{ fontSize: 13, color: 'var(--text-muted, #64748b)', marginTop: 12 }}>
              Open your email app to find the confirmation link.
            </p>
          )}

          <button
            type="button"
            className="btn btn-block"
            style={{ marginTop: 10, background: 'var(--success, #16a34a)', color: '#fff', fontWeight: 800 }}
            onClick={() => void confirmFromEmail()}
            disabled={busy}
          >
            {busy ? 'Checking…' : "I've confirmed — Log in"}
          </button>

          {error && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>{error}</div>}

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginTop: 12 }}
            onClick={() => { setPendingConfirmation(false); setMode('signup'); setError(''); setInfo(''); }}
          >
            ← Use a different email / start over
          </button>
        </div>
      </Box>
    );
  }

  return (
    <Box>
      <Brand />
      <p className="sub">Offline-first POS. Your local database is the source of truth.</p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        {(['login', 'signup'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setError(''); setInfo(''); }}
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
              placeholder="At least 6 characters"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={6}
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
        {info && <div style={{ color: '#16a34a', fontSize: 13 }}>{info}</div>}

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