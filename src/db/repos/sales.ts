import { db } from '../db';
import { uid, todayKey, isCloudShopId } from '../../lib/utils';
import { newIdempotencyKey } from '../../lib/idempotency';
import { syncCreditBalanceCache } from './customers';
import { enqueueDailySummary, enqueueStockLedger } from './outbox';
import type { Sale, SaleItem, PaymentSplit, PaymentMethod, PaymentStatus, DailySummary } from '../../types';

export interface CreateSaleInput {
  shopId: string;
  cashierId: string;
  cashierName?: string;
  items: SaleItem[];
  discount: number; // minor units
  payments: PaymentSplit[];
  paymentStatus: PaymentStatus;
  primaryMethod: PaymentMethod;
  createdAt?: number;
}

/**
 * Atomic sale creation. A sale is durable the instant this transaction commits
 * to IndexedDB — cloud sync is purely a backup layer.
 */
export async function createSale(input: CreateSaleInput): Promise<Sale> {
  const now = input.createdAt ?? Date.now();
  const dateKey = todayKey(new Date(now));

  // Sequential receipt number per shop per day.
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const daySales = await db.sales
    .where('shopId')
    .equals(input.shopId)
    .and((s) => s.createdAt >= startOfDay.getTime())
    .count();
  const seq = daySales + 1;
  const receiptNumber = `${input.shopId.slice(0, 6).toUpperCase()}-${dateKey.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;

  const subtotal = input.items.reduce((sum, it) => sum + it.lineTotal, 0);
  const totalAmount = Math.max(0, subtotal - input.discount);
  const idempotencyKey = newIdempotencyKey('SALE');
  const saleId = uid();

  const sale: Sale = {
    id: saleId,
    receiptNumber,
    shopId: input.shopId,
    cashierId: input.cashierId,
    cashierName: input.cashierName,
    items: input.items,
    subtotal,
    discount: input.discount,
    totalAmount,
    payments: input.payments,
    paymentMethod: input.primaryMethod,
    paymentStatus: input.paymentStatus,
    createdAt: now,
    syncedToCloud: false,
    outboxRetryCount: 0,
    idempotencyKey
  };

  await db.transaction(
    'rw',
    [db.sales, db.stockLedger, db.products, db.dailySummaries, db.creditLedger, db.customers, db.outbox],
    async () => {
    // 1. The sale itself.
    await db.sales.add(sale);

    // 2. Stock deltas coalesced per product + append-only stock ledger entries.
    const stockDelta = new Map<string, number>();
    for (const item of input.items) stockDelta.set(item.productId, (stockDelta.get(item.productId) ?? 0) - item.quantity);
    for (const [productId, delta] of stockDelta) {
      const product = await db.products.get(productId);
      if (!product) continue;
      const nextQty = Math.max(0, product.stockQuantity + delta);
      await db.products.put({ ...product, stockQuantity: nextQty, updatedAt: now });
      const ledgerEntry = {
        id: uid(),
        productId,
        type: 'SALE' as const,
        quantityDelta: delta,
        referenceId: saleId,
        actorId: input.cashierId,
        shopId: input.shopId,
        createdAt: now
      };
      await db.stockLedger.add(ledgerEntry);
      // SALE movements are append-only and must reach the cloud — otherwise a
      // fresh device rebuilds a stock ledger missing every sale (Finding 3).
      await enqueueStockLedger(ledgerEntry);
    }

    // 3. Credit ledger entries for store-credit payments.
    for (const p of input.payments) {
      if (p.method === 'CREDIT' && p.customerId) {
        const customer = await db.customers.get(p.customerId);
        if (!customer) throw new Error('Customer not found for store credit');
        if (customer.allowCredit === false) {
          throw new Error(`Credit is not allowed for ${customer.name} — enable "Allow credit" on the Customers page.`);
        }
        const entryId = uid();
        await db.creditLedger.add({
          id: entryId,
          customerId: p.customerId,
          type: 'CHARGE',
          amount: p.amount,
          referenceId: saleId,
          shopId: input.shopId,
          createdAt: now
        });
        // The CHARGE must reach the cloud (credit_ledger is append-only and the
        // only source a fresh device can rebuild balances from). Previously only
        // PAYMENT entries synced — a re-synced device would rebuild a ledger
        // with just the payments and derive wrong tab balances. (Demo shop
        // never syncs — gate on the real cloud-shop uuid like the customer rows.)
        if (isCloudShopId(input.shopId)) {
          await db.outbox.add({
            id: uid(),
            idempotencyKey: `credit_charge_${entryId}`,
            entityType: 'CREDIT_LEDGER',
            payload: { id: entryId, customerId: p.customerId, type: 'CHARGE', amount: p.amount, referenceId: saleId, shopId: input.shopId, createdAt: now },
            status: 'PENDING',
            retryCount: 0,
            createdAt: now
          });
        }
        // Balance is derived from the ledger — recompute (cache only, never a second source of truth).
        await syncCreditBalanceCache(p.customerId);
      }
    }

    // 4. Incremental daily summary (pre-aggregated — dashboards never scan sales).
    await incrementDailySummary(input.shopId, sale);

    // 5. Outbox entry — durability + idempotency.
    await db.outbox.add({
      id: uid(),
      idempotencyKey,
      entityType: 'SALE',
      payload: sale,
      status: 'PENDING',
      retryCount: 0,
      createdAt: now
    });
  });

  return sale;
}

/** Incremental summary update — ONE doc per shop per day, per the free-tier spec. */
export async function incrementDailySummary(shopId: string, sale: Sale): Promise<void> {
  const dateKey = todayKey(new Date(sale.createdAt));
  const id = `${shopId}_${dateKey}`;
  const existing = await db.dailySummaries.get(id);
  const base = existing?.totalsByMethod ?? { CASH: 0, CARD: 0, PAYSTACK: 0, CREDIT: 0 };
  const byMethod: Record<PaymentMethod, number> = {
    ...base,
    [sale.paymentMethod]: (base[sale.paymentMethod] ?? 0) + sale.totalAmount
  };

  const topMap = new Map<string, { productId: string; productName: string; qty: number; revenue: number }>();
  for (const it of sale.items) {
    const cur = topMap.get(it.productId) ?? { productId: it.productId, productName: it.productName, qty: 0, revenue: 0 };
    cur.qty += it.quantity;
    cur.revenue += it.lineTotal;
    topMap.set(it.productId, cur);
  }
  const topList = [...(existing?.topSelling ?? [])];
  for (const t of topMap.values()) {
    const found = topList.find((x) => x.productId === t.productId);
    if (found) {
      found.qty += t.qty;
      found.revenue += t.revenue;
    } else topList.push(t);
  }

  const summary: DailySummary = {
    id,
    shopId,
    date: dateKey,
    salesCount: (existing?.salesCount ?? 0) + 1,
    totalsByMethod: byMethod,
    totalRevenue: (existing?.totalRevenue ?? 0) + sale.totalAmount,
    totalProfit: (existing?.totalProfit ?? 0) + (sale.profit ?? 0),
    topSelling: topList.sort((a, b) => b.qty - a.qty).slice(0, 10),
    lastUpdatedAt: Date.now()
  };
  await db.dailySummaries.put(summary);
  // Push the pre-aggregated summary to the cloud so other/fresh devices can
  // rebuild dashboards without scanning raw sales (Finding 2).
  await enqueueDailySummary(summary);
}

export async function getSaleById(id: string): Promise<Sale | undefined> {
  return db.sales.get(id);
}

export async function getSalesToday(shopId: string, cashierId?: string): Promise<Sale[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = await db.sales
    .where('shopId')
    .equals(shopId)
    .and((s) => s.createdAt >= start.getTime() && (!cashierId || s.cashierId === cashierId))
    .toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getSalesPage(shopId: string, cursor?: number, limit = 20): Promise<Sale[]> {
  const all = await db.sales.where('shopId').equals(shopId).toArray();
  const sorted = all.sort((a, b) => b.createdAt - a.createdAt);
  if (!cursor) return sorted.slice(0, limit);
  const idx = sorted.findIndex((s) => s.createdAt <= cursor);
  return idx === -1 ? [] : sorted.slice(idx, idx + limit);
}

export async function getSalesByRange(shopId: string, from: number, to: number): Promise<Sale[]> {
  const rows = await db.sales
    .where('shopId')
    .equals(shopId)
    .and((s) => s.createdAt >= from && s.createdAt <= to && !s.voidedBy)
    .toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** Void = reversal document, never an edit. Append-only enforced at repo level. */
export async function voidSale(saleId: string, actorId: string, reason?: string): Promise<Sale> {
  const now = Date.now();
  const sale = await db.sales.get(saleId);
  if (!sale) throw new Error('Sale not found');
  if (sale.voidedBy) throw new Error('Sale already voided');

  const reversalId = uid();
  const reversal: Sale = {
    ...sale,
    id: reversalId,
    receiptNumber: `${sale.receiptNumber}-V`,
    totalAmount: -sale.totalAmount,
    subtotal: -sale.subtotal,
    discount: -sale.discount,
    items: sale.items.map((it) => ({ ...it, lineTotal: -it.lineTotal })),
    payments: sale.payments.map((p) => ({ ...p, amount: -p.amount })),
    createdAt: now,
    voidedBy: sale.id,
    syncedToCloud: false,
    outboxRetryCount: 0,
    idempotencyKey: newIdempotencyKey('VOID')
  };

  await db.transaction('rw', [db.sales, db.stockLedger, db.products, db.dailySummaries, db.outbox, db.creditLedger, db.customers], async () => {
    // Mark original as voided (status flag only — the financial row is untouched).
    await db.sales.put({ ...sale, voidedBy: reversalId });
    await db.sales.add(reversal);

    const deltaMap = new Map<string, number>();
    for (const it of sale.items) deltaMap.set(it.productId, (deltaMap.get(it.productId) ?? 0) + it.quantity);
    for (const [productId, delta] of deltaMap) {
      const product = await db.products.get(productId);
      if (!product) continue;
      await db.products.put({ ...product, stockQuantity: Math.max(0, product.stockQuantity + delta), updatedAt: now });
      const ledgerEntry = {
        id: uid(),
        productId,
        type: 'VOID' as const,
        quantityDelta: delta,
        referenceId: reversalId,
        actorId,
        shopId: sale.shopId,
        createdAt: now
      };
      await db.stockLedger.add(ledgerEntry);
      // VOID movements are append-only and must reach the cloud too (Finding 3).
      await enqueueStockLedger(ledgerEntry);
    }

    // 2b. Credit reversal — a voided credit sale must also undo the customer's
    //     tab, atomically with the sale reversal (mirror of createSale step 3).
    //     Without this, a voided credit sale leaves a phantom debt on the tab.
    for (const p of sale.payments) {
      if (p.method === 'CREDIT' && p.customerId) {
        const customer = await db.customers.get(p.customerId);
        if (!customer) continue;
        const entryId = uid();
        await db.creditLedger.add({
          id: entryId,
          customerId: p.customerId,
          type: 'REVERSAL',
          amount: p.amount,
          referenceId: reversalId,
          shopId: sale.shopId,
          createdAt: now
        });
        // The REVERSAL must also reach the cloud — a voided credit sale's
        // ledger entry is otherwise missing from the backup/other devices
        // (same gap as the CHARGE: only PAYMENT entries used to sync).
        if (isCloudShopId(sale.shopId)) {
          await db.outbox.add({
            id: uid(),
            idempotencyKey: `credit_reversal_${entryId}`,
            entityType: 'CREDIT_LEDGER',
            payload: { id: entryId, customerId: p.customerId, type: 'REVERSAL', amount: p.amount, referenceId: reversalId, shopId: sale.shopId, createdAt: now },
            status: 'PENDING',
            retryCount: 0,
            createdAt: now
          });
        }
        // Balance is derived from the ledger — recompute (no clamp: if the
        // customer had partially paid before the void, the REVERSAL correctly
        // leaves the ledger exact instead of silently eating the difference).
        await syncCreditBalanceCache(p.customerId);
      }
    }

    // Reflect reversal in the daily summary (append-only; the original sale stays).
    const summary = await db.dailySummaries.get(`${sale.shopId}_${todayKey(new Date(sale.createdAt))}`);
    if (summary) {
      // Reverse the items from topSelling — a voided sale's products must not
      // keep counting toward "Top Selling" on the dashboard. Mirror of the
      // aggregation in incrementDailySummary: subtract each line's qty/revenue
      // and drop the entry entirely if it goes to zero (or below, on retries).
      const topMap = new Map<string, { productId: string; productName: string; qty: number; revenue: number }>();
      for (const it of sale.items) {
        const cur = topMap.get(it.productId) ?? { productId: it.productId, productName: it.productName, qty: 0, revenue: 0 };
        cur.qty -= it.quantity;
        cur.revenue -= it.lineTotal;
        topMap.set(it.productId, cur);
      }
      let topList = [...(summary.topSelling ?? [])];
      for (const t of topMap.values()) {
        const found = topList.find((x) => x.productId === t.productId);
        if (found) {
          found.qty += t.qty;
          found.revenue += t.revenue;
          if (found.qty <= 0) topList = topList.filter((x) => x.productId !== t.productId);
        }
      }

      const nextSummary: DailySummary = {
        ...summary,
        salesCount: Math.max(0, summary.salesCount - 1),
        totalRevenue: Math.max(0, summary.totalRevenue - sale.totalAmount),
        totalProfit: Math.max(0, (summary.totalProfit ?? 0) - (sale.profit ?? 0)),
        totalsByMethod: {
          ...summary.totalsByMethod,
          [sale.paymentMethod]: Math.max(0, (summary.totalsByMethod[sale.paymentMethod] ?? 0) - sale.totalAmount)
        },
        topSelling: topList.sort((a, b) => b.qty - a.qty).slice(0, 10),
        lastUpdatedAt: now
      };
      await db.dailySummaries.put(nextSummary);
      // Void also rewrites the summary — mirror it so other devices converge.
      await enqueueDailySummary(nextSummary);
    }

    await db.outbox.add({
      id: uid(),
      idempotencyKey: reversal.idempotencyKey,
      entityType: 'VOID',
      payload: { reversal, originalId: sale.id, reason },
      status: 'PENDING',
      retryCount: 0,
      createdAt: now
    });
  });

  return reversal;
}

export async function nextReceiptNumber(shopId: string): Promise<string> {
  const now = Date.now();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const count = await db.sales
    .where('shopId')
    .equals(shopId)
    .and((s) => s.createdAt >= start.getTime())
    .count();
  const dateKey = todayKey();
  return `${shopId.slice(0, 6).toUpperCase()}-${dateKey.replace(/-/g, '')}-${String(count + 1).padStart(4, '0')}`;
}