import { create } from 'zustand';
import { getAllProducts, getLowStock, getProductCosting } from '../db/repos/products';
import type { Product, ProductCosting } from '../types';
import { shopIdOf } from './authStore';

interface InventoryState {
  products: Product[];
  costing: Map<string, ProductCosting>;
  loading: boolean;
  lowStock: Product[];
  lastRefresh: number;
  refresh: () => Promise<void>;
  loadCosting: () => Promise<void>;
}

export const useInventoryStore = create<InventoryState>((set) => ({
  products: [],
  costing: new Map(),
  loading: false,
  lowStock: [],
  lastRefresh: 0,

  refresh: async () => {
    const shopId = shopIdOf();
    set({ loading: true });
    const products = await getAllProducts(shopId);
    const lowStock = products.filter((p) => p.stockQuantity <= p.minStockLevel);
    set({ products, lowStock, loading: false, lastRefresh: Date.now() });
  },

  loadCosting: async () => {
    const products = useInventoryStore.getState().products;
    const map = new Map<string, ProductCosting>();
    for (const p of products) {
      const c = await getProductCosting(p.id);
      if (c) map.set(p.id, c);
    }
    set({ costing: map });
  }
}));

/** Live low-stock listener (allowed: stock visibility during an active sale). */
export function subscribeLowStock(cb: (count: number) => void): () => void {
  const run = async () => {
    // getLowStock reads through the ledger-derived stock pass (see stock.ts),
    // so the badge can never disagree with the Inventory table on a device
    // that is still catching up on product snapshots.
    const low = (await getLowStock(shopIdOf())).length;
    cb(low);
  };
  void run();
  const timer = setInterval(run, 30_000);
  return () => clearInterval(timer);
}