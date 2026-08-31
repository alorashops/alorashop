
import { db } from '../db';
import { todayKey } from '../../lib/utils';
import { enqueueDailySummary, enqueueSale } from './outbox';
import { useAuthStore, canSeeCosting } from '../../stores/authStore';
import type { DailySummary, ProductCosting, Sale, SaleItem } from '../../types';

/**
 * Analytics — DERIVED from the live local sales ledger (merge-safe: every row
 * is keyed by its own id, pulled rows are never clobbered), NOT from the shared
 * dailySummary doc. That doc is one row per (shop, date) pushed last-writer-
 * wins, so reading it made devices diverge: the cloud kept whatever device
 * pushed last, and its snapshot overwrote every other device's view. Raw
 * sales rows converge instead, so analytics match what actually happened.
 */

export async function getDailySummary(shopId: string, date?: string): Promise<DailySummary | undefined> {
  return db.dailySummaries.get(`${shopId}_${date ?? todayKey()}`);
}

export async function getSummaries(shopId: string, days = 7): Promise<DailySummary[]> {
  const all = await db.dailySummaries.where('shopId').equals(shopId).toArray();
  return all.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, days);
}

/** Non-voided sales in an inclusive YYYY-MM-DD range. Voided sales never
    contribute revenue/counts — the reversal cancels the original. */
async function getRangeSales(shopId: string, fromDate: string, toDate: string): Promise<Sale[]> {
  const start = new Date(`${fromDate}T00:00:00`).getTime();
  const end = new Date(`${toDate}T23:59:59.999`).getTime();
  return db.sales
    .where('shopId')
    .equals(shopId)
    .and((s) => s.createdAt >= start && s.createdAt <= end && !s.voidedBy)
    .toArray();
}

/**
 * Date-range summaries, inclusive, ordered oldest → newest for the chart.
 *
 * Aggregated live from the raw (merge-safe) sales ledger — the same math
 * incrementDailySummary uses (totalsByMethod keyed on the primary payment
 * method, topSelling from line items), but derived idempotently instead of
 * maintained incrementally. This is what makes every device converge: the
 * numbers come from the same rows every device has, not a last-writer-wins
 * document that only some device wrote.
 */
export async function getSummariesRange(shopId: string, fromDate: string, toDate: string): Promise<DailySummary[]> {
  const sales = await getRangeSales(shopId, fromDate, toDate);
  const byDay = new Map<string, DailySummary>();

  for (const sale of sales) {
    const date = todayKey(new Date(sale.createdAt));
    let sum = byDay.get(date);
    if (!sum) {
      sum = {
        id: `${shopId}_${date}`,
        shopId,
        date,
        salesCount: 0,
        totalsByMethod: { CASH: 0, CARD: 0, PAYSTACK: 0, CREDIT: 0 },
        totalRevenue: 0,
        totalProfit: 0,
        topSelling: [],
        lastUpdatedAt: sale.createdAt
      };
      byDay.set(date, sum);
    }
    sum.salesCount += 1;
    sum.totalRevenue += sale.totalAmount;
    // Profit is restricted data that exists ONLY where a manager backfill
    // attached `sale.profit` locally — exactly the old summary semantics
    // (devices without a backfill show GH₵0 until one runs).
    sum.totalProfit += sale.profit ?? 0;
    sum.totalsByMethod[sale.paymentMethod] = (sum.totalsByMethod[sale.paymentMethod] ?? 0) + sale.totalAmount;
    for (const it of sale.items) {
      const found = sum.topSelling.find((x) => x.productId === it.productId);
      if (found) {
        found.qty += it.quantity;
        found.revenue += it.lineTotal;
      } else {
        sum.topSelling.push({ productId: it.productId, productName: it.productName, qty: it.quantity, revenue: it.lineTotal });
      }
    }
    if (sale.createdAt > sum.lastUpdatedAt) sum.lastUpdatedAt = sale.createdAt;
  }

  for (const sum of byDay.values()) {
    // sort() mutates AND returns; slice() returns a NEW array — the original
    // line threw the slice away, so topSelling stayed unbounded. Assign it so
    // each day's derived summary is capped like the stored summary doc.
    sum.topSelling = sum.topSelling.sort((a, b) => b.qty - a.qty).slice(0, 10);
  }
  return [...byDay.values()].sort((a, b) => (a.date > b.date ? 1 : -1));
}

/**
 * Core profit enrichment over a time window.
 *
 * For every non-voided sale in [startMs, endMs) it attaches costPriceAtSale
 * (current product_costing, falling back to any already-stamped line cost) and
 * computes profit, then pushes the enriched rows through the outbox so the
 * cloud mirror and every OTHER device converge (Problem #3).
 *
 * Idempotent gap-fill by default (`force = false`): a sale that already carries
 * profit is a FINAL snapshot (cost at the time it was first backfilled) and is
 * skipped — so calling this on every Analytics load / after every pull is
 * cheap (steady state is a read-only pass that enqueues nothing). `force`
 * recomputes everything (the manual "Run profit backfill" button).
 *
 * db.outbox is in the transaction scope so the enriched rows + their
 * propagation entries commit atomically with the local writes.
 */
async function backfillSalesWindow(
  shopId: string,
  startMs: number,
  endMs: number,
  force: boolean
): Promise<number> {
  const sales = await db.sales
    .where('shopId')
    .equals(shopId)
    .and((s) => s.createdAt >= startMs && s.createdAt < endMs && !s.voidedBy)
    .toArray();
  if (sales.length === 0) return 0;

  const costings = await db.productCosting.toArray();
  const costMap = new Map(costings.map((c) => [c.productId, c.costPrice]));

  // Group by local calendar day so summaries are keyed exactly like
  // incrementDailySummary (${shopId}_${yyyy-mm-dd}).
  const byDay = new Map<string, Sale[]>();
  for (const s of sales) {
    const d = todayKey(new Date(s.createdAt));
    const list = byDay.get(d);
    if (list) list.push(s);
    else byDay.set(d, [s]);
  }

  let newProfit = 0;
  await db.transaction('rw', db.sales, db.dailySummaries, db.outbox, async () => {
    for (const [date, daySales] of byDay) {
      let dayProfit = 0;
      let dayChanged = false;
      for (const sale of daySales) {
        // Gap-fill: an already-enriched sale is a final snapshot — skip it
        // unless forced. Its profit still counts toward the day total.
        if (!force && typeof sale.profit === 'number') {
          // Upgrade path: profit can predate Problem #3 (it was written
          // locally but NEVER stamped/pushed). A sale with profit but no
          // `updatedAt` would otherwise be skipped forever and its profit
          // would never reach other devices. Re-stamp + re-enqueue it ONCE;
          // the next run sees a numeric updatedAt and settles.
          if (typeof sale.updatedAt !== 'number') {
            const enriched = { ...sale, updatedAt: Date.now() };
            await db.sales.put(enriched);
            await enqueueSale(enriched);
            dayChanged = true;
          }
          dayProfit += sale.profit;
          continue;
        }
        // Cost resolution: prefer the CURRENT costing row, fall back to the
        // cost already stamped on the line at an earlier backfill. NEVER
        // fabricate a zero cost in auto mode — stamping profit = full revenue
        // for a product with no known cost, then pushing it with a newer
        // updatedAt, would let every other device pull that WRONG profit
        // wholesale (the pull applies the newer row verbatim) and silently
        // clobber correct profit everywhere. A sale missing a cost is left
        // profit-less and re-attempted once its costing row arrives (the
        // gap-fill self-heals). Only a FORCED manual recompute tolerates a
        // missing cost (explicit manager intent; zero = current known state).
        const costedItems: SaleItem[] = [];
        let missingCost = false;
        for (const it of sale.items) {
          const cost = costMap.get(it.productId) ?? it.costPriceAtSale;
          if (cost === undefined) {
            if (!force) {
              missingCost = true;
              break;
            }
            costedItems.push({ ...it, costPriceAtSale: 0 });
          } else {
            costedItems.push({ ...it, costPriceAtSale: cost });
          }
        }
        if (missingCost) continue; // no cost data yet — skip until it arrives
        const costTotal = costedItems.reduce((sum, it) => sum + (it.costPriceAtSale ?? 0) * it.quantity, 0);
        const profit = sale.totalAmount - costTotal;
        // Stamp `updatedAt` (NEWER than the original createdAt) so the next
        // push advances the cloud `updated_at` and other devices' delta pulls
        // re-deliver this enriched row. (Problem #3.)
        const enriched = { ...sale, items: costedItems, profit, updatedAt: Date.now() };
        await db.sales.put(enriched);
        // Push the enriched sale itself (not just the summary) — profit lives
        // on the sale row, so that row must travel.
        await enqueueSale(enriched);
        dayProfit += profit;
        dayChanged = true;
        newProfit += profit;
      }
      if (dayChanged) {
        const key = `${shopId}_${date}`;
        const summary = await db.dailySummaries.get(key);
        if (summary) {
          const next = { ...summary, totalProfit: dayProfit, lastUpdatedAt: Date.now() };
          await db.dailySummaries.put(next);
          // Backfill rewrites the summary (profit is restricted data) — mirror it.
          await enqueueDailySummary(next);
        }
      }
    }
  });
  return newProfit;
}

/** Manager FORCE re-backfill for a single day (the manual button). */
export async function backfillProfits(shopId: string, date?: string): Promise<number> {
  // Same internal gate as autoBackfillProfit: only cost-capable devices may
  // compute (and then PUSH) profit. Without it, a stray call on another role
  // would fabricate costs and propagate wrong profit — the UI button is
  // already manager-gated; this is the defense-in-depth backstop.
  if (!canSeeCosting(useAuthStore.getState().user?.role)) return 0;
  const start = date ? new Date(`${date}T00:00:00`) : new Date();
  if (!date) start.setHours(0, 0, 0, 0);
  return backfillSalesWindow(shopId, start.getTime(), start.getTime() + 86_400_000, true);
}

/**
 * Auto-profit — the no-click path.
 *
 * Idempotent gap-fill over a date range (default: last 30 days). Safe to call
 * on every Analytic load and after every pull: sales that already carry profit
 * are skipped, so steady state is a cheap read-only pass that writes/enqueues
 * nothing. Triggers only on devices that can see costing (manager/admin) — see
 * AnalyticsPage.load and syncService.pullDelta.
 */
export async function autoBackfillProfit(
  shopId: string,
  fromDate?: string,
  toDate?: string,
  force = false
): Promise<number> {
  // Internal gate (defense in depth): only devices that can see costing ever
  // compute profit, no matter who calls this — a cashier device returns before
  // any scan/write, so a stray call can neither spend local work nor expose
  // restricted numbers. Call-site gates (AnalyticsPage, pullDelta) make this
  // doubly safe; this is the backstop that leaves no silent path open.
  if (!canSeeCosting(useAuthStore.getState().user?.role)) return 0;
  // Exclusive end-of-day, the SAME way backfillProfits does it: start of the
  // NEXT day (`< endMs`). Using `23:59:59.999` here would EXCLUDE a sale at
  // exactly that millisecond while getRangeSales (`<=` that instant) COUNTS
  // it — leaving that sale permanently unbackfilled (profit stuck at 0).
  // These two must agree so every counted sale gets its profit computed.
  const endMs = toDate ? new Date(`${toDate}T00:00:00`).getTime() + 86_400_000 : Date.now();
  // Default window: the last 30 days (covers every default Analytics range).
  const startMs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : endMs - 30 * 86_400_000;
  return backfillSalesWindow(shopId, startMs, endMs, force);
}

/** Weighted average cost update after a restock (WAC preferred costing). */
export async function applyWeightedAverageCost(productId: string, qtyAdded: number, unitCost: number): Promise<void> {
  const existing = await db.productCosting.where('productId').equals(productId).first();
  const current = existing?.weightedAverageCost ?? 0;
  const currentQty = existing?.currentQty ?? 0;
  const newQty = currentQty + qtyAdded;
  const wac = newQty > 0 ? (current * currentQty + unitCost * qtyAdded) / newQty : unitCost;
  await db.productCosting.put({
    productId,
    costPrice: unitCost,
    weightedAverageCost: wac,
    supplierInfo: existing?.supplierInfo,
    updatedAt: Date.now(),
    currentQty: newQty
  });
}

export async function getStockValue(shopId: string): Promise<{ count: number; value: number }> {
  // Archived (soft-deleted) products are hidden from inventory and checkout —
  // their leftover stock must not inflate "Stock on hand" on Analytics.
  // getLowStock/getAllProducts already filter archived; this one did not.
  const products = (await db.products.where('shopId').equals(shopId).toArray()).filter((p) => !p.archived);
  const costings = await db.productCosting.toArray();
  const costMap = new Map(costings.map((c) => [c.productId, c.weightedAverageCost ?? c.costPrice]));
  let value = 0;
  let count = 0;
  for (const p of products) {
    count += p.stockQuantity;
    value += p.stockQuantity * (costMap.get(p.id) ?? 0);
  }
  return { count, value };
}

export async function getTopSelling(shopId: string, limit = 8): Promise<DailySummary['topSelling']> {
  const summaries = await db.dailySummaries.where('shopId').equals(shopId).toArray();
  const map = new Map<string, { productId: string; productName: string; qty: number; revenue: number }>();
  for (const s of summaries) {
    for (const t of s.topSelling) {
      const cur = map.get(t.productId) ?? { productId: t.productId, productName: t.productName, qty: 0, revenue: 0 };
      cur.qty += t.qty;
      cur.revenue += t.revenue;
      map.set(t.productId, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty).slice(0, limit);
}

export interface TopSellingItem {
  productId: string;
  productName: string;
  qty: number;
  revenue: number;
  /** Gross profit for the line (minor units). Present ONLY when a manager
      backfill has attached costPriceAtSale to the underlying sales — otherwise
      undefined so the UI can show "—" instead of a fake GH₵0. */
  profit?: number;
}

/**
 * Top sellers within an inclusive date range.
 *
 * Quantity, revenue AND profit are all derived from the raw (merge-safe)
 * sales ledger in ONE pass — no summary doc involved. profit is accumulated
 * only where `costPriceAtSale` exists (i.e. after a manager backfill ran on
 * this device), so products with no backfilled cost still render as "—".
 * Deriving everything from the same rows also removes the old phantom rows
 * (a sales scan could inject a {qty:0, revenue:0} product that the summary's
 * top-10 cap had dropped — the infamous "0 units, +GH₵profit" entry).
 */
export async function getTopSellingRange(shopId: string, fromDate: string, toDate: string, limit = 8): Promise<TopSellingItem[]> {
  const sales = await getRangeSales(shopId, fromDate, toDate);
  const map = new Map<string, TopSellingItem>();

  for (const sale of sales) {
    // Remainder-corrected per-line discount allocation, keyed by the line
    // object itself (identity) — rebuilt fresh for every sale, never leaks.
    const alloc = new Map<SaleItem, number>();
    if (sale.discount > 0 && sale.subtotal > 0 && sale.items.length > 0) {
      const base = sale.items.map((it) => Math.floor((sale.discount * it.lineTotal) / sale.subtotal));
      sale.items.forEach((it, i) => alloc.set(it, base[i]));
      // leftover = Σ(floor) < items.length — hand it out one minor unit to the
      // largest fractional remainders so Σ allocated == sale.discount EXACTLY
      // (no ±1 drift across thousands of sales).
      const left = sale.discount - base.reduce((s, b) => s + b, 0);
      const byFrac = base
        .map((b, i) => ({ i, f: (sale.discount * sale.items[i].lineTotal) / sale.subtotal - b }))
        .sort((a, b) => b.f - a.f);
      for (let k = 0; k < left; k++) {
        const idx = byFrac[k % byFrac.length]?.i;
        if (idx !== undefined) alloc.set(sale.items[idx], (alloc.get(sale.items[idx]) ?? 0) + 1);
      }
    }
    // Why: a sale-level discount is real margin reduction. Without allocating
    // it per line, per-product profit (pure gross) summed to MORE than the
    // Profit stat (which subtracts the discount) — the two silently disagreed
    // whenever a discount was applied. With this, Σ line profit == sale.profit
    // (totalAmount − costTotal) exactly, per product and in total.

    for (const it of sale.items) {
      let cur = map.get(it.productId);
      if (!cur) {
        cur = { productId: it.productId, productName: it.productName, qty: 0, revenue: 0, profit: undefined };
        map.set(it.productId, cur);
      }
      cur.qty += it.quantity;
      cur.revenue += it.lineTotal;
      if (typeof it.costPriceAtSale === 'number') {
        const gross = (it.unitPrice - it.costPriceAtSale) * it.quantity;
        cur.profit = (cur.profit ?? 0) + gross - (alloc.get(it) ?? 0);
      }
    }
  }

  return [...map.values()].sort((a, b) => b.qty - a.qty).slice(0, limit);
}

export type { ProductCosting, Sale };