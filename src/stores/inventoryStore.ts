import { create } from 'zustand';
import { db } from '../db';
import { getAllProducts, getProductCosting } from '../db/repos/products';
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
    const shopId = shopIdOf();
    const low = await db.products
      .where('shopId')
      .equals(shopId)
      .filter((p) => !p.archived && p.stockQuantity <= p.minStockLevel)
      .count();
    cb(low);
  };
  void run();
  const timer = setInterval(run, 30_000);
  return () => clearInterval(timer);
}