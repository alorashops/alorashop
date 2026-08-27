import { db } from '../db';
import { todayKey } from '../../lib/utils';
import { enqueueDailySummary } from './outbox';
import type { DailySummary, ProductCosting, Sale } from '../../types';

/**
 * Analytics — dashboards read pre-aggregated dailySummary docs + live local
 * IndexedDB. Never scans raw cloud sales.
 */

export async function getDailySummary(shopId: string, date?: string): Promise<DailySummary | undefined> {
  return db.dailySummaries.get(`${shopId}_${date ?? todayKey()}`);
}

export async function getSummaries(shopId: string, days = 7): Promise<DailySummary[]> {
  const all = await db.dailySummaries.where('shopId').equals(shopId).toArray();
  return all.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, days);
}

/** Date-range summaries, inclusive, ordered oldest → newest for the chart. */
export async function getSummariesRange(shopId: string, fromDate: string, toDate: string): Promise<DailySummary[]> {
  const all = await db.dailySummaries.where('shopId').equals(shopId).toArray();
  return all
    .filter((s) => s.date >= fromDate && s.date <= toDate)
    .sort((a, b) => (a.date > b.date ? 1 : -1));
}

/** Manager backfill: attach costPriceAtSale + profit to each sale for the day. */
export async function backfillProfits(shopId: string, date?: string): Promise<number> {
  const start = date ? new Date(`${date}T00:00:00`) : new Date();
  if (!date) start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000);
  const sales = await db.sales
    .where('shopId')
    .equals(shopId)
    .and((s) => s.createdAt >= start.getTime() && s.createdAt < end.getTime() && !s.voidedBy)
    .toArray();

  const costings = await db.productCosting.toArray();
  const costMap = new Map(costings.map((c) => [c.productId, c.costPrice]));

  let profitSum = 0;
  await db.transaction('rw', db.sales, db.dailySummaries, async () => {
    for (const sale of sales) {
      const items = sale.items.map((it) => ({
        ...it,
        costPriceAtSale: costMap.get(it.productId) ?? it.costPriceAtSale ?? 0
      }));
      const costTotal = items.reduce((sum, it) => sum + (it.costPriceAtSale ?? 0) * it.quantity, 0);
      const profit = sale.totalAmount - costTotal;
      await db.sales.put({ ...sale, items, profit });
      profitSum += profit;
    }
    const key = `${shopId}_${date ?? todayKey()}`;
    const summary = await db.dailySummaries.get(key);
    if (summary) {
      const next = { ...summary, totalProfit: profitSum, lastUpdatedAt: Date.now() };
      await db.dailySummaries.put(next);
      // Backfill rewrites the summary (profit is restricted data) — mirror it.
      await enqueueDailySummary(next);
    }
  });
  return profitSum;
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
  const products = await db.products.where('shopId').equals(shopId).toArray();
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
 * Quantity/revenue come from the pre-aggregated summaries (never a raw-sale
 * scan for those). Per-product PROFIT is the one thing summaries can't carry
 * (they hold no line-level cost), so it is folded in from the raw sales where
 * `costPriceAtSale` exists — i.e. after a manager backfill has run.
 */
export async function getTopSellingRange(shopId: string, fromDate: string, toDate: string, limit = 8): Promise<TopSellingItem[]> {
  const summaries = (await db.dailySummaries.where('shopId').equals(shopId).toArray())
    .filter((s) => s.date >= fromDate && s.date <= toDate);

  const map = new Map<string, TopSellingItem>();
  for (const s of summaries) {
    for (const t of s.topSelling) {
      const cur = map.get(t.productId) ?? { productId: t.productId, productName: t.productName, qty: 0, revenue: 0, profit: undefined };
      cur.qty += t.qty;
      cur.revenue += t.revenue;
      map.set(t.productId, cur);
    }
  }

  const start = new Date(`${fromDate}T00:00:00`).getTime();
  const end = new Date(`${toDate}T23:59:59.999`).getTime();
  const sales = await db.sales
    .where('shopId')
    .equals(shopId)
    .and((s) => s.createdAt >= start && s.createdAt <= end && !s.voidedBy)
    .toArray();

  for (const sale of sales) {
    for (const it of sale.items) {
      if (it.costPriceAtSale === undefined || it.costPriceAtSale === null) continue;
      let cur = map.get(it.productId);
      if (!cur) {
        cur = { productId: it.productId, productName: it.productName, qty: 0, revenue: 0, profit: undefined };
        map.set(it.productId, cur);
      }
      cur.profit = (cur.profit ?? 0) + (it.unitPrice - it.costPriceAtSale) * it.quantity;
    }
  }

  return [...map.values()].sort((a, b) => b.qty - a.qty).slice(0, limit);
}

export type { ProductCosting, Sale };