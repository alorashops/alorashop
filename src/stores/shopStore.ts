import { create } from 'zustand';
import { DEFAULT_SHOP_ID, DEFAULT_SHOP_NAME, isSupabaseConfigured } from '../config/env';
import { fetchShopName, updateShopName as rpcUpdateShopName } from '../services/supabase';
import { isCloudShopId } from '../lib/utils';
import { useAuthStore } from './authStore';

/**
 * Shop display name — drives the sidebar brand and receipts.
 *
 * Offline-first, same model as the auth identity mirror:
 *  - localStorage cache is the synchronous source → the sidebar renders
 *    instantly on reload, no network wait.
 *  - When the shop is a REAL Supabase shop and we're online, `refresh()`
 *    pulls the authoritative `shops.name` from the cloud and re-caches it
 *    (RLS-scoped to members). A newer cloud name always wins.
 *  - `updateName()` saves locally IMMEDIATELY (offline-safe), then pushes to
 *    the cloud via the admin-only `update_shop_name` RPC when possible. A
 *    failure to reach the cloud keeps the local name — other devices see the
 *    new name once the RPC succeeds on a connected save.
 *  - Non-cloud shops (offline `shop_default` demo) are local-only: no fetch,
 *    no RPC, name lives entirely in the cache.
 *
 * Long names: capped at 40 chars (client + server). Receipt/thermal wrapping
 * and sidebar ellipsis handle the rest — no silent truncation of data.
 */
const NAME_KEY = 'alorashop.shopname.v1';

/** Character cap for shop names — same on client UI and the update RPC. */
export const MAX_SHOP_NAME = 40;

function readCachedName(): string | null {
  try {
    const raw = localStorage.getItem(NAME_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

function writeCachedName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Clears the cached name (used by "erase local data" + sign out flows). */
export function clearShopNameCache(): void {
  try {
    localStorage.removeItem(NAME_KEY);
  } catch {
    /* non-fatal */
  }
}

interface ShopState {
  name: string;
  loaded: boolean;
  refresh: () => Promise<void>;
  /**
   * Validated save. Returns true when the cloud accepted the new name; false
   * when it was saved locally only (offline / non-cloud shop). Throws only on
   * invalid input (empty / too long) — the UI validates before calling.
   */
  updateName: (raw: string) => Promise<boolean>;
}

export const useShopStore = create<ShopState>((set) => ({
  name: DEFAULT_SHOP_NAME,
  loaded: false,

  refresh: async () => {
    const shopId = useAuthStore.getState().user?.shopId ?? DEFAULT_SHOP_ID;
    const cached = readCachedName();
    let name = cached ?? DEFAULT_SHOP_NAME;
    // Only real Supabase shops have a cloud row to pull from. The offline
    // demo shop (`shop_default`) is local-only by design.
    if (isCloudShopId(shopId) && isSupabaseConfigured) {
      try {
        const cloud = await fetchShopName(shopId);
        if (cloud && cloud.trim()) {
          name = cloud.trim();
          writeCachedName(name);
        }
      } catch {
        // offline / RLS hiccup — keep the cached (or default) name.
      }
    }
    set({ name, loaded: true });
  },

  updateName: async (raw: string) => {
    const name = raw.trim();
    if (!name) throw new Error('Shop name cannot be empty');
    if (name.length > MAX_SHOP_NAME) {
      throw new Error(`Shop name must be ${MAX_SHOP_NAME} characters or fewer`);
    }
    // Local first — the UI updates instantly and survives reloads offline.
    writeCachedName(name);
    set({ name });
    const shopId = useAuthStore.getState().user?.shopId ?? DEFAULT_SHOP_ID;
    if (!isCloudShopId(shopId) || !isSupabaseConfigured) return false; // local-only shop
    try {
      await rpcUpdateShopName(name);
      return true; // cloud accepted
    } catch (err) {
      // Offline / transient / server rejection (e.g. non-admin signing in) —
      // keep the local name; re-push on a later online save. Server-side role
      // guardrails still protect the cloud from non-admin renames.
      console.warn('Shop name saved locally; cloud update deferred:', err);
      return false;
    }
  }
}));

/** Convenience read of the current effective shop name (sidebar + prints). */
export function shopNameOf(): string {
  return useShopStore.getState().name;
}