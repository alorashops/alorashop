import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useSyncStore } from '../stores/syncStore';
import { useUiStore } from '../stores/uiStore';
import { fmtMoney, fmtDateTime } from '../lib/utils';
import { EmptyState } from '../components/ui';
import {
  getMyWallet,
  getMyReferrals,
  getMyNotifications,
  markNotificationsRead,
  getMyReferralCode,
  referralLink,
  listBanks,
  createRecipient,
  requestPayout,
  initiateTransfer,
  finalizeTransfer,
  getMyRecipients,
  getMyPayouts,
  getMyPayoutLimits,
  AffiliateFunctionError,
  type AffiliateWallet,
  type AffiliateReferral,
  type AffiliateNotification,
  type BankOption,
  type PayoutRecipient,
  type PayoutRequest,
  type PayoutChannel
} from '../services/affiliate';
import {
  PAYOUT_STATUS_LABELS,
  friendlyPayoutError,
  pesewasToGhs,
  resolveAttemptKey,
  validateDestination,
  validateWithdrawAmount,
  validateOtp,
  type WithdrawAttempt
} from '../lib/payout';

/**
 * Affiliate page (S9 reads + S8c withdraw) — ONLINE-ONLY. Wallet / referrals /
 * inbox for the signed-in user (any role: every POS user can be a referrer),
 * plus an ADMIN-GATED withdraw section. Reads go through the owner-only
 * `affiliate.*` RPCs; the client never touches the money tables. This module
 * deliberately imports NO PGlite/Dexie and its chunk is excluded from the
 * service-worker precache (vite.config.ts) — offline it shows a "needs a
 * connection" state instead of a broken page.
 *
 * The withdraw section is ADMIN-GATED in the UI, but that gate is only UX: the
 * server (`affiliate.request_payout`) re-reads `public.profiles.role` and is
 * authoritative. The RAW account number goes straight to `create-recipient` and
 * is never stored, logged, or kept in state beyond the request (AFFILIATE.md A10).
 */

/** Small shared label style for the withdraw form. */
const FIELD_LABEL: CSSProperties = { display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' };
const DIVIDER = '1px solid var(--border, #e2e8f0)';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The withdraw section (S8c). Owns its own payout state so the rest of the page
 * does not re-render on every keystroke. `onChanged` refreshes the parent (the
 * wallet moves the moment a payout HOLDS funds).
 */
function WithdrawSection({ availableMinor, onChanged }: { availableMinor: number; onChanged: () => void }) {
  const push = useUiStore((s) => s.push);

  // Destination form.
  const [channel, setChannel] = useState<PayoutChannel>('bank');
  const [banks, setBanks] = useState<BankOption[]>([]);
  const [banksLoading, setBanksLoading] = useState(false);
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [savingDest, setSavingDest] = useState(false);

  // Payout state.
  const [recipients, setRecipients] = useState<PayoutRecipient[]>([]);
  const [payouts, setPayouts] = useState<PayoutRequest[]>([]);
  const [amountInput, setAmountInput] = useState('');
  const [minPayoutMinor, setMinPayoutMinor] = useState(0);
  const [busy, setBusy] = useState(false);
  // Set when Paystack holds a transfer for OTP (S11c) — the payout id to finalize.
  const [otpPayoutId, setOtpPayoutId] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [otpBusy, setOtpBusy] = useState(false);
  // The idempotency key of the attempt in flight, reused on a retry so a
  // double-tap (or a retry after a transient failure) is ONE payout.
  const attemptRef = useRef<WithdrawAttempt | null>(null);

  const loadPayout = useCallback(async () => {
    try {
      const [r, p, l] = await Promise.all([
        getMyRecipients(),
        getMyPayouts(50),
        // The floor is server config (S11a). A failure here must NOT block the
        // section — fall back to 0 and let the server's rejection speak.
        getMyPayoutLimits().catch(() => ({ min_payout_minor: 0 }))
      ]);
      setRecipients(r);
      setPayouts(p);
      setMinPayoutMinor(l.min_payout_minor);
    } catch {
      // Non-fatal: the rest of the page still works; the action buttons will
      // surface a real error if the reads keep failing.
    }
  }, []);

  useEffect(() => {
    void loadPayout();
  }, [loadPayout]);

  // The bank / MoMo-provider list is PAYSTACK-DRIVEN (never hardcoded). Reload
  // it whenever the channel changes so codes cannot drift.
  useEffect(() => {
    let cancelled = false;
    setBanksLoading(true);
    setBankCode('');
    void (async () => {
      try {
        const list = await listBanks(channel);
        if (!cancelled) setBanks(list);
      } catch {
        if (!cancelled) setBanks([]);
        push('error', 'Could not load the bank list. Check your connection and try again.');
      } finally {
        if (!cancelled) setBanksLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel, push]);

  const activeRecipient = recipients.find((r) => r.is_active) ?? null;

  const saveDestination = async () => {
    const check = validateDestination({ channel, accountNumber, bankCode, accountName });
    if (!check.ok) {
      push('warn', check.reason);
      return;
    }
    setSavingDest(true);
    try {
      await createRecipient({
        channel,
        accountNumber: accountNumber.trim(),
        bankCode,
        accountName: accountName.trim()
      });
      // The RAW number is gone the instant we have the masked recipient.
      setAccountNumber('');
      setAccountName('');
      push('success', 'Payout destination saved.');
      await loadPayout();
    } catch (e) {
      push('error', friendlyPayoutError(errorText(e)));
    } finally {
      setSavingDest(false);
    }
  };

  const withdraw = async () => {
    if (!activeRecipient) {
      push('warn', 'Save a payout destination first.');
      return;
    }
    const check = validateWithdrawAmount(amountInput, availableMinor, minPayoutMinor);
    if (!check.ok) {
      push('warn', check.reason);
      return;
    }
    // Reuse the key only for the SAME withdrawal; a new amount/destination is a
    // genuinely new payout and must not be deduped against an older one.
    const attempt = resolveAttemptKey(attemptRef.current, check.amountMinor, activeRecipient.id);
    attemptRef.current = attempt;
    setBusy(true);
    try {
      const payoutId = await requestPayout(check.amountMinor, activeRecipient.id, attempt.key);
      const started = await initiateTransfer(payoutId);
      if (started.otpRequired) {
        // Paystack holds the transfer until an OTP is entered. KEEP the attempt
        // key so a retry continues the SAME payout (never a second hold).
        setOtpPayoutId(payoutId);
        push('warn', 'Paystack needs the code it sent you to complete this payout.');
        await loadPayout();
        return;
      }
      attemptRef.current = null; // done — a later withdrawal is a NEW payout
      setAmountInput('');
      push('success', 'Withdrawal started — its status appears below.');
      await loadPayout();
      onChanged();
    } catch (e) {
      if (e instanceof AffiliateFunctionError && e.transient) {
        // Transient: keep the SAME key so tapping Withdraw again continues the
        // SAME payout instead of creating a second one.
        push('warn', 'Could not reach Paystack — nothing was lost. Tap Withdraw again to continue.');
      } else {
        attemptRef.current = null; // terminal / rejected — a retry is a NEW payout
        push('error', friendlyPayoutError(errorText(e)));
      }
      await loadPayout();
    } finally {
      setBusy(false);
    }
  };

  // S11c: complete a transfer Paystack held for OTP. A wrong OTP is retryable —
  // no money moves, the hold stays.
  const finalizeWithOtp = async () => {
    if (!otpPayoutId) return;
    const check = validateOtp(otp);
    if (!check.ok) {
      push('warn', check.reason);
      return;
    }
    setOtpBusy(true);
    try {
      await finalizeTransfer(otpPayoutId, check.value);
      attemptRef.current = null; // this payout is done — a later one is NEW
      setOtpPayoutId(null);
      setOtp('');
      push('success', 'Withdrawal completed.');
      await loadPayout();
      onChanged();
    } catch (e) {
      push('error', friendlyPayoutError(errorText(e)));
      await loadPayout();
    } finally {
      setOtpBusy(false);
    }
  };

  return (
    <div className="card">
      <div style={{ fontWeight: 800, marginBottom: 8 }}>Withdraw</div>

      {activeRecipient ? (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
          Paying to <strong>{activeRecipient.account_name || 'your account'}</strong>
          {activeRecipient.bank_name ? ` · ${activeRecipient.bank_name}` : ''} · ••••{activeRecipient.account_last4}
          {activeRecipient.channel === 'momo' ? ' (Mobile Money)' : ''}
        </p>
      ) : (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
          Add a payout destination (bank or mobile money) to withdraw your available balance.
        </p>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={channel === 'bank' ? 'btn btn-sm' : 'btn btn-ghost btn-sm'}
            onClick={() => setChannel('bank')}
            disabled={savingDest || busy}
          >
            Bank
          </button>
          <button
            className={channel === 'momo' ? 'btn btn-sm' : 'btn btn-ghost btn-sm'}
            onClick={() => setChannel('momo')}
            disabled={savingDest || busy}
          >
            Mobile Money
          </button>
        </div>

        <label style={FIELD_LABEL}>
          {channel === 'momo' ? 'Provider' : 'Bank'}
          <select value={bankCode} onChange={(e) => setBankCode(e.target.value)} disabled={banksLoading || savingDest || busy}>
            <option value="">{banksLoading ? 'Loading…' : 'Choose…'}</option>
            {banks.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))}
          </select>
        </label>

        <label style={FIELD_LABEL}>
          {channel === 'momo' ? 'MoMo number' : 'Account number'}
          <input
            inputMode="numeric"
            autoComplete="off"
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder={channel === 'momo' ? '0XXXXXXXXX' : 'Account number'}
            disabled={savingDest || busy}
          />
        </label>

        <label style={FIELD_LABEL}>
          Account name
          <input
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
            placeholder="Name on the account"
            disabled={savingDest || busy}
          />
        </label>

        <div>
          <button className="btn btn-sm" onClick={() => void saveDestination()} disabled={savingDest || busy}>
            {savingDest ? 'Saving…' : activeRecipient ? 'Save / replace destination' : 'Save destination'}
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
          Your account number is sent to Paystack and never stored — we keep only the last 4 digits.
        </p>
      </div>

      <div style={{ display: 'grid', gap: 8, borderTop: DIVIDER, marginTop: 12, paddingTop: 12 }}>
        <label style={FIELD_LABEL}>
          Amount (GH₵)
          <input
            inputMode="decimal"
            autoComplete="off"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="0.00"
            disabled={busy}
          />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => void withdraw()} disabled={busy || !activeRecipient}>
            {busy ? 'Starting…' : 'Withdraw'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setAmountInput(pesewasToGhs(availableMinor))}
            disabled={busy || availableMinor <= 0}
          >
            Use all
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
          Available: {fmtMoney(availableMinor)}
          {minPayoutMinor > 0 ? ` · minimum withdrawal ${fmtMoney(minPayoutMinor)}` : ''}
        </p>

        {otpPayoutId ? (
          <div style={{ display: 'grid', gap: 6, borderTop: DIVIDER, paddingTop: 10 }}>
            <label style={FIELD_LABEL}>
              Paystack code (OTP)
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="123456"
                disabled={otpBusy}
              />
            </label>
            <div>
              <button className="btn btn-sm" onClick={() => void finalizeWithOtp()} disabled={otpBusy}>
                {otpBusy ? 'Completing…' : 'Complete withdrawal'}
              </button>
            </div>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
              Paystack is holding this payout until you enter the code it sent you.
            </p>
          </div>
        ) : null}
      </div>

      <div style={{ borderTop: DIVIDER, marginTop: 12, paddingTop: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Withdrawal history</div>
        {payouts.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No withdrawals yet.</div>
        ) : (
          payouts.map((p) => (
            <div
              key={p.id}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: DIVIDER }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{fmtMoney(p.amount_minor)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {fmtDateTime(new Date(p.created_at).getTime())}
                  {p.reason ? ` · ${p.reason}` : ''}
                </div>
              </div>
              <span className="tag">{PAYOUT_STATUS_LABELS[p.status] ?? p.status}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function AffiliatePage() {
  const user = useAuthStore((s) => s.user);
  const online = useSyncStore((s) => s.online);
  const toast = useUiStore();

  // UI gate only — the SERVER re-checks the role in `affiliate.request_payout`.
  const isAdmin = user?.role === 'admin';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<AffiliateWallet>({ available_minor: 0, pending_minor: 0, total_minor: 0 });
  const [referrals, setReferrals] = useState<AffiliateReferral[]>([]);
  const [notes, setNotes] = useState<AffiliateNotification[]>([]);
  const [code, setCode] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The referral code is minted lazily on first visit (S1), then the reads.
      const [c, w, r, n] = await Promise.all([
        getMyReferralCode(),
        getMyWallet(),
        getMyReferrals(),
        getMyNotifications(50)
      ]);
      setCode(c);
      setWallet(w);
      setReferrals(r);
      setNotes(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load affiliate data.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh JUST the wallet (no full-page loading flash) — used after a payout,
  // which HOLDS funds the moment it is requested.
  const refreshWallet = useCallback(async () => {
    try {
      setWallet(await getMyWallet());
    } catch {
      // keep the last known balance; the next full load will reconcile it
    }
  }, []);

  // Load once online. Offline the page simply shows the connection notice.
  useEffect(() => {
    if (online) void load();
    else setLoading(false);
  }, [online, load]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(referralLink(code));
      toast.push('success', 'Referral link copied.');
    } catch {
      toast.push('error', 'Could not copy — long-press the link to copy it.');
    }
  };

  const markRead = async (ids?: number[]) => {
    try {
      await markNotificationsRead(ids);
      await load();
    } catch {
      toast.push('error', 'Could not update notifications.');
    }
  };

  const unread = notes.filter((n) => !n.read_at).length;
  const link = code ? referralLink(code) : '';

  if (!online) {
    return (
      <div className="card">
        <EmptyState
          icon="🔌"
          title="Affiliate needs a connection"
          hint="Your wallet, referrals and notifications live in the cloud. Reconnect, then open this page again."
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>Affiliate</h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {user?.displayName} · {user?.role.toUpperCase()}
          </span>
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
          Share your link — when a new shop signs up and subscribes, you earn a recurring
          commission. Earnings clear a short refund hold before they become available.
        </p>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <strong style={{ color: 'var(--danger)' }}>Couldn’t load your affiliate data.</strong>
          <p style={{ margin: '6px 0 10px', fontSize: 13, color: 'var(--text-muted)' }}>{error}</p>
          <button className="btn btn-sm" onClick={() => void load()}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ color: 'var(--text-muted)' }}>Loading affiliate data…</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <div className="card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Available</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--success)' }}>{fmtMoney(wallet.available_minor)}</div>
            </div>
            <div className="card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Pending (in hold)</div>
              <div style={{ fontSize: 24, fontWeight: 800 }}>{fmtMoney(wallet.pending_minor)}</div>
            </div>
            <div className="card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total earned</div>
              <div style={{ fontSize: 24, fontWeight: 800 }}>{fmtMoney(wallet.total_minor)}</div>
            </div>
          </div>

          <div className="card">
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Your referral link</div>
            {code ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 220 }} />
                <button className="btn btn-sm" onClick={() => void copyLink()}>Copy</button>
              </div>
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Minting your code…</div>
            )}
            <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
              A new shop that signs up through this link is linked to you when they create their shop.
            </p>
          </div>

          <div className="card">
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Referred shops ({referrals.length})</div>
            {referrals.length === 0 ? (
              <EmptyState icon="🏬" title="No referrals yet" hint="Share your link to start earning." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {referrals.map((r) => (
                  <div key={r.store_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{r.store_name || 'Unnamed shop'}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        Joined {fmtDateTime(new Date(r.referred_at).getTime())} · via {r.source}
                      </div>
                    </div>
                    <span className="tag">{r.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontWeight: 800 }}>
                Notifications {unread > 0 ? <span className="badge">{unread}</span> : null}
              </div>
              {unread > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={() => void markRead()}>Mark all read</button>
              )}
            </div>
            {notes.length === 0 ? (
              <EmptyState icon="🔔" title="Nothing yet" hint="We’ll tell you here when a commission clears its hold." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {notes.map((n) => (
                  <div key={n.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                    <div>
                      <div style={{ fontWeight: n.read_at ? 400 : 700 }}>
                        {n.kind === 'commission_released' ? 'Commission released' : n.kind}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtDateTime(new Date(n.created_at).getTime())}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontWeight: 700, color: 'var(--success)' }}>+{fmtMoney(n.amount_minor)}</span>
                      {!n.read_at && (
                        <button className="btn btn-ghost btn-sm" onClick={() => void markRead([n.id])}>Mark read</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {isAdmin ? (
            <WithdrawSection availableMinor={wallet.available_minor} onChanged={() => void refreshWallet()} />
          ) : (
            <div className="card" style={{ background: 'var(--surface-2)' }}>
              <strong>Withdrawals</strong>
              <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
                Only the shop <strong>admin</strong> can withdraw earnings. Ask your admin to cash out.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}