import { db } from '../db';
import { uid, isCloudShopId } from '../../lib/utils';
import type { Customer, CreditLedgerEntry, CreditLedgerType } from '../../types';

export interface NewCustomerInput {
  name: string;
  phone: string;
  shopId: string;
}

export interface CreateCustomerOptions {
  /** Skip the duplicate-phone check (used only after explicit user confirmation). */
  allowDuplicate?: boolean;
}

/** Normalizes a stored row: a missing `allowCredit` field (legacy data) defaults to true. */
function normalizeCustomer(c: Customer): Customer {
  return { ...c, allowCredit: c.allowCredit !== false };
}

export async function findByPhone(shopId: string, phone: string): Promise<Customer | undefined> {
  const q = phone.trim();
  if (!q) return undefined;
  const rows = await db.customers
    .where('shopId')
    .equals(shopId)
    .filter((c) => c.phone.trim() === q)
    .toArray();
  return rows[0] ? normalizeCustomer(rows[0]) : undefined;
}

export async function createCustomer(input: NewCustomerInput, opts: CreateCustomerOptions = {}): Promise<Customer> {
  const now = Date.now();
  const phone = input.phone.trim();
  if (!opts.allowDuplicate) {
    const existing = await findByPhone(input.shopId, phone);
    if (existing) {
      throw new Error(`A customer with phone ${phone} already exists — ${existing.name}. Add anyway?`);
    }
  }
  const customer: Customer = {
    id: uid(),
    name: input.name.trim(),
    phone,
    creditBalance: 0,
    allowCredit: true,
    shopId: input.shopId,
    createdAt: now,
    updatedAt: now
  };
  await db.transaction('rw', db.customers, db.outbox, async () => {
    await db.customers.add(customer);
    // New customers are syncable ONLY for real cloud shops. The offline demo
    // shop (non-uuid `shop_default`) has no cloud account, and enqueuing its
    // rows would grow a local-only outbox that can never sync (purge is manual).
    // Real shops enqueue immediately so a customer created on device A reaches
    // the cloud (and device B), not only once a credit payment touches them.
    if (isCloudShopId(input.shopId)) {
      await db.outbox.add({
        id: uid(),
        idempotencyKey: `customer_${customer.id}`,
        entityType: 'CUSTOMER',
        payload: customer,
        status: 'PENDING',
        retryCount: 0,
        createdAt: now
      });
    }
  });
  return customer;
}

// ---------------------------------------------------------------------------
// Balance is DERIVED from the credit ledger (single source of truth). The
// stored `creditBalance` on the customer row is only a read cache — every read
// path below hydrates it from the ledger sum, so incremental updates can never
// drift the books (void reversal, overpayment and CHARGE/PAYMENT all share this).
// ---------------------------------------------------------------------------
function ledgerBalance(entries: CreditLedgerEntry[]): number {
  // CHARGE adds to what the customer owes; PAYMENT and REVERSAL reduce it.
  return entries.reduce((sum, e) => (e.type === 'CHARGE' ? sum + e.amount : sum - e.amount), 0);
}

/** Compute a customer's balance from the ledger and persist it back onto the row. */
export async function syncCreditBalanceCache(customerId: string): Promise<number> {
  const entries = await db.creditLedger.where('customerId').equals(customerId).toArray();
  const balance = ledgerBalance(entries);
  const customer = await db.customers.get(customerId);
  if (customer) await db.customers.put({ ...customer, creditBalance: balance, updatedAt: Date.now() });
  return balance;
}

/** Hydrate a batch of customers (already filtered to one shop) with ledger-derived balances. */
async function hydrateBalances(rows: Customer[]): Promise<Customer[]> {
  if (rows.length === 0) return rows;
  const entries = await db.creditLedger.where('shopId').equals(rows[0].shopId).toArray();
  const byCustomer = new Map<string, CreditLedgerEntry[]>();
  for (const e of entries) {
    const arr = byCustomer.get(e.customerId);
    if (arr) arr.push(e);
    else byCustomer.set(e.customerId, [e]);
  }
  return rows.map((c) => ({ ...normalizeCustomer(c), creditBalance: ledgerBalance(byCustomer.get(c.id) ?? []) }));
}

export async function getCustomers(shopId: string): Promise<Customer[]> {
  const rows = await db.customers.where('shopId').equals(shopId).toArray();
  return (await hydrateBalances(rows)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function searchCustomers(shopId: string, query: string): Promise<Customer[]> {
  const q = query.trim().toLowerCase();
  if (!q) return getCustomers(shopId);
  const rows = await db.customers
    .where('shopId')
    .equals(shopId)
    .filter((c) => c.name.toLowerCase().includes(q) || c.phone.includes(q))
    .toArray();
  return hydrateBalances(rows);
}

export async function getCustomerById(id: string): Promise<Customer | undefined> {
  const c = await db.customers.get(id);
  if (!c) return undefined;
  const [hydrated] = await hydrateBalances([c]);
  return hydrated;
}

export function isCreditAllowed(c: Customer): boolean {
  return c.allowCredit !== false;
}

export async function setAllowCredit(customerId: string, allowed: boolean): Promise<void> {
  const customer = await db.customers.get(customerId);
  if (!customer) throw new Error('Customer not found');
  const now = Date.now();
  await db.transaction('rw', db.customers, db.outbox, async () => {
    const next = { ...customer, allowCredit: allowed, updatedAt: now };
    await db.customers.put(next);
    // The allowCredit guardrail must reach the cloud too — otherwise a device
    // that pulls the customer still sees the old value and can extend credit
    // the manager explicitly disabled. (Demo shop never syncs — see above.)
    if (isCloudShopId(customer.shopId)) {
      await db.outbox.add({
        id: uid(),
        idempotencyKey: `customer_${customerId}`,
        entityType: 'CUSTOMER',
        payload: next,
        status: 'PENDING',
        retryCount: 0,
        createdAt: now
      });
    }
  });
}

/**
 * Customer pays down their tab — append-only credit ledger PAYMENT entry.
 * The full entered amount is recorded (never silently capped); the balance is
 * the ledger sum, so an overpayment shows up as shop credit owed to the
 * customer instead of vanishing.
 */
export async function payCredit(
  customerId: string,
  amount: number,
  shopId: string,
  actorId: string,
  actorName?: string
): Promise<void> {
  const now = Date.now();
  const customer = await db.customers.get(customerId);
  if (!customer) throw new Error('Customer not found');
  if (amount <= 0) throw new Error('Payment must be positive');
  const entryId = uid();
  await db.transaction('rw', db.customers, db.creditLedger, db.outbox, async () => {
    await db.creditLedger.add({
      id: entryId,
      customerId,
      type: 'PAYMENT',
      amount,
      referenceId: entryId,
      actorId,
      actorName,
      shopId,
      createdAt: now
    });
    // Balance is derived from the ledger — persist the read cache.
    await syncCreditBalanceCache(customerId);
    if (isCloudShopId(shopId)) {
      await db.outbox.add({
        id: uid(),
        idempotencyKey: `credit_pay_${entryId}`,
        entityType: 'CREDIT_LEDGER',
        payload: { id: entryId, customerId, type: 'PAYMENT', amount, referenceId: entryId, shopId, createdAt: now },
        status: 'PENDING',
        retryCount: 0,
        createdAt: now
      });
      const fresh = await db.customers.get(customerId);
      if (fresh) {
        await db.outbox.add({
          id: uid(),
          idempotencyKey: `customer_${customerId}`,
          entityType: 'CUSTOMER',
          payload: fresh,
          status: 'PENDING',
          retryCount: 0,
          createdAt: now
        });
      }
    }
  });
}

/** Newest-first, capped — a tab reads top-down like a cash-register tape. */
export async function getCreditLedger(customerId: string, limit = 50): Promise<CreditLedgerEntry[]> {
  const rows = await db.creditLedger.where('customerId').equals(customerId).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** Ledger rows resolved for display: CHARGE/REVERSAL show the receipt, PAYMENT shows who recorded it. */
export interface CreditLedgerRow extends CreditLedgerEntry {
  receiptNumber?: string;
  actorLabel?: string;
}

export async function getCreditLedgerDetailed(customerId: string, limit = 50): Promise<CreditLedgerRow[]> {
  const entries = await getCreditLedger(customerId, limit);
  const rows: CreditLedgerRow[] = [];
  for (const e of entries) {
    const row: CreditLedgerRow = { ...e };
    if (e.type === 'CHARGE' || e.type === 'REVERSAL') {
      const sale = await db.sales.get(e.referenceId);
      row.receiptNumber = sale?.receiptNumber;
    } else if (e.type === 'PAYMENT') {
      row.actorLabel = e.actorName || e.actorId || 'Unknown';
    }
    rows.push(row);
  }
  return rows;
}

export type { CreditLedgerEntry, CreditLedgerType };