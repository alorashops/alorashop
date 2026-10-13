import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useSyncStore } from '../stores/syncStore';
import { useUiStore } from '../stores/uiStore';
import { fmtMoney, fmtDate, fmtDateTime } from '../lib/utils';
import { EmptyState } from '../components/ui';
import {
  getBillingState,
  getPaymentHistory,
  startSubscriptionPayment,
  BillingFunctionError,
  type BillingState,
  type BillingPayment
} from '../services/billing';
import { resumePaystackCharge } from '../services/paystack';
import {
  billingBanner,
  formatCard,
  friendlyBillingError,
  subscriptionStatusLabel
} from '../lib/billing';

/**
 * Billing page (S12-6) — ONLINE-ONLY. Shows the signed-in shop's subscription
 * state and lets ANY member pay (B4 — deliberately NOT admin-gated, unlike the
 * Affiliate withdraw section).
 *
 * The shop + the amount are derived SERVER-SIDE (`billing.state()` /
 * `paystack-subscribe` -> `create_intent`), so the client never names a shop or a
 * price. Paying opens the Paystack checkout via `resumePaystackCharge(access_code)`;
 * the WEBHOOK is the ONLY thing that marks the shop paid, so after a charge we
 * POLL `billing.state()` and never optimistically advance the shop ourselves.
 *
 * B3: `trialing` / `past_due` are NOTICES ONLY — the POS is never gated here.
 * This module deliberately imports NO PGlite/Dexie and its chunk is excluded from
 * the service-worker precache (vite.config.ts) — offline it shows a "needs a
 * connection" state instead of a broken page.
 */

const FIELD_LABEL: CSSProperties = { display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' };
const DIVIDER = '1px solid var(--border, #e2e8f0)';
/** Webhook latency is usually < a few seconds; poll ~2 minutes before giving up. */
const POLL_INTERVAL_MS = 3000;
const POLL_ATTEMPTS = 40;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function BillingPage() {
  const user = useAuthStore((s) => s.user);
  const online = useSyncStore((s) => s.online);
  const push = useUiStore((s) => s.push);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<BillingState | null>(null);
  const [history, setHistory] = useState<BillingPayment[]>([]);
  const [paying, setPaying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The B9 opt-in DRAFT sent with the next Pay (defaults to the stored setting).
  const [autoRenew, setAutoRenew] = useState(false);

  // Cancellation token for the post-charge poll loop (cleared on unmount/reload).
  const pollRef = useRef<{ cancelled: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, h] = await Promise.all([getBillingState(), getPaymentHistory(50)]);
      setState(s);
      setHistory(h);
      setAutoRenew(s?.auto_renew ?? false);
    } catch (e) {
      setError(friendlyBillingError(errorText(e)));
    } finally {
      setLoading(false);
    }
  }, []);

  /** Re-read the state without the full-page loading flash (used while polling). */
  const refreshState = useCallback(async (): Promise<BillingState | null> => {
    try {
      const s = await getBillingState();
      setState(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await getPaymentHistory(50));
    } catch {
      /* keep the last known history; the next full load reconciles it */
    }
  }, []);

  // Load once online. Offline the page simply shows the connection notice.
  useEffect(() => {
    if (online) void load();
    else setLoading(false);
    return () => {
      if (pollRef.current) pollRef.current.cancelled = true;
    };
  }, [online, load]);

  /**
   * Poll `billing.state()` until the WEBHOOK flips the shop to `active`. We NEVER
   * mark the shop paid from the client — a `success` from Paystack only means the
   * card was charged; the webhook is the authority. Gives up (with a friendly
   * notice) after ~2 minutes; the state reconciles on the next visit anyway.
   */
  const confirmUntilActive = useCallback(async () => {
    const token = { cancelled: false };
    pollRef.current = token;
    setConfirming(true);
    try {
      for (let i = 0; i < POLL_ATTEMPTS; i++) {
        await sleep(POLL_INTERVAL_MS);
        if (token.cancelled) return;
        const s = await refreshState();
        if (token.cancelled) return;
        if (s?.status === 'active') {
          await refreshHistory();
          push('success', 'Subscription active — thank you!');
          return;
        }
      }
      push('info', 'Payment received. We are still confirming with Paystack — this page will update shortly.');
    } finally {
      if (pollRef.current === token) pollRef.current = null;
      setConfirming(false);
    }
  }, [refreshState, refreshHistory, push]);

  const pay = async () => {
    if (paying || confirming) return;
    setPaying(true);
    try {
      // 1) The function mints OUR intent from auth.uid() and opens a Paystack
      //    transaction (the shop + amount are never client-supplied).
      const start = await startSubscriptionPayment(autoRenew);
      // 2) Complete the charge in the Paystack checkout.
      const charge = await resumePaystackCharge(start.access_code);
      if (charge.status === 'success') {
        push('info', 'Charge authorised — confirming your subscription…');
        void confirmUntilActive();
      } else if (charge.status === 'closed') {
        push('info', charge.message ?? 'Payment window closed — no charge was made.');
      } else {
        push('error', charge.message ?? 'Could not complete the payment.');
      }
    } catch (e) {
      const transient = e instanceof BillingFunctionError && e.transient;
      push('error', `${friendlyBillingError(errorText(e))}${transient ? ' You can try again.' : ''}`);
    } finally {
      setPaying(false);
    }
  };

  const banner = billingBanner(state?.status);
  const card = formatCard(state?.card_brand, state?.card_last4);
  const periodEnd = state?.current_period_end ?? state?.trial_ends_at ?? null;
  const busy = paying || confirming;

  if (!online) {
    return (
      <div className="card">
        <EmptyState
          icon="🔌"
          title="Billing needs a connection"
          hint="Your subscription lives in the cloud. Reconnect, then open this page again."
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>Billing</h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {user?.displayName} · {user?.role.toUpperCase()}
          </span>
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
          Your AloraShop subscription. Any member of the shop can pay, and your POS keeps working at all times.
        </p>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <strong style={{ color: 'var(--danger)' }}>Couldn’t load your billing details.</strong>
          <p style={{ margin: '6px 0 10px', fontSize: 13, color: 'var(--text-muted)' }}>{error}</p>
          <button className="btn btn-sm" onClick={() => void load()}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ color: 'var(--text-muted)' }}>Loading billing details…</div>
      ) : !state ? (
        <div className="card">
          <EmptyState icon="🧾" title="No billing record yet" hint="Your subscription details will appear here." />
        </div>
      ) : (
        <>
          {banner && (
            <div className="card" style={{ borderColor: banner.tone === 'warn' ? 'var(--warning, #d97706)' : 'var(--primary)' }}>
              <strong>{banner.title}</strong>
              <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>{banner.message}</p>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <div className="card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Status</div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{subscriptionStatusLabel(state.status)}</div>
            </div>
            <div className="card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {state.status === 'trialing' ? 'Trial ends' : 'Renews / due'}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                {periodEnd ? fmtDate(new Date(periodEnd).getTime()) : '—'}
              </div>
            </div>
            <div className="card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Days left</div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{state.days_left ?? '—'}</div>
            </div>
            <div className="card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Price</div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{fmtMoney(state.price_minor)}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>every {state.period_days} days</div>
            </div>
          </div>

          <div className="card">
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Subscription payment</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 24, fontWeight: 800 }}>{fmtMoney(state.price_minor)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  adds {state.period_days} days{card ? ` · card on file: ${card}` : ''}
                </div>
              </div>
              <button className="btn" onClick={() => void pay()} disabled={busy}>
                {confirming ? 'Confirming…' : paying ? 'Opening Paystack…' : 'Pay with Paystack'}
              </button>
            </div>
            <label style={{ ...FIELD_LABEL, gridTemplateColumns: 'auto 1fr', alignItems: 'center', marginTop: 10 }}>
              <input
                type="checkbox"
                checked={autoRenew}
                onChange={(e) => setAutoRenew(e.currentTarget.checked)}
                disabled={busy}
              />
              <span>
                Auto-renew — save this card and charge it each period
                {state.auto_renew !== autoRenew ? ' (applies when you pay)' : state.auto_renew ? ' (currently on)' : ' (currently off)'}.
              </span>
            </label>
            <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
              You pay on Paystack’s secure page. The shop is marked paid only once Paystack confirms.
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
              The price above applies to your next payment — a price change never affects a period you have already paid (B6).
            </p>
          </div>

          <div className="card">
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Payment history ({history.length})</div>
            {history.length === 0 ? (
              <EmptyState icon="🧾" title="No payments yet" hint="Your completed subscription payments will appear here." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {history.map((p) => (
                  <div
                    key={p.reference}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: DIVIDER }}
                  >
                    <div>
                      <div style={{ fontWeight: 600 }}>{fmtMoney(p.amount_minor)}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {fmtDateTime(new Date(p.paid_at).getTime())} · covers to {fmtDate(new Date(p.period_end).getTime())}
                      </div>
                    </div>
                    <span className="tag" title={p.reference}>{p.currency}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
