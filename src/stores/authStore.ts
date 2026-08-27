import { create } from 'zustand';
import type { AppUser, Role } from '../types';
import { DEFAULT_SHOP_ID } from '../config/env';
import {
  subscribeToAuth,
  getLocalUser,
  checkCurrentUser,
  probeOnline,
  fetchProfile,
  signIn,
  signUp,
  signOut,
  createShop as rpcCreateShop,
  type AuthProfile
} from '../services/supabase';

interface AuthState {
  user: AppUser | null;
  /** True once the session has been restored on boot (offline-safe). */
  booted: boolean;
  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<{ requiresConfirmation: boolean }>;
  createShop: (name: string, phone?: string) => Promise<void>;
  logout: () => Promise<void>;
  switchShop: (shopId: string) => void;
}

let unsubscribeAuth: (() => void) | undefined;

// ---------------------------------------------------------------------------
// Identity mirror — our OWN persisted copy of "who is signed in".
// Independent from Supabase's session store so that a failed token refresh
// (offline) can never wipe a valid login. Cleared on explicit sign-out or a
// definitive ONLINE server answer.
// ---------------------------------------------------------------------------
const IDENTITY_KEY = 'alorashop.identity.v1';

function readCachedIdentity(): AppUser | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as AppUser) : null;
  } catch {
    return null;
  }
}

function writeCachedIdentity(u: AppUser | null): void {
  try {
    if (u) localStorage.setItem(IDENTITY_KEY, JSON.stringify(u));
    else localStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/**
 * Builds the AppUser for a session row, FALLING BACK to the previously known
 * identity for any field the (re)fetch could not supply. This is what makes
 * the mirror non-downgradable: if the profile fetch fails while offline, the
 * existing shopId / role / displayName survive instead of collapsing to
 * `shopId: null`.
 */
function resolveIdentity(
  user: { id: string; email?: string | null },
  profile: AuthProfile | null,
  fallback: AppUser | null
): AppUser {
  return {
    uid: user.id,
    shopId: profile?.shop_id ?? fallback?.shopId ?? null, // null => signed up but no shop yet
    displayName: profile?.display_name ?? user.email ?? fallback?.displayName ?? 'User',
    role: (profile?.role as Role | undefined) ?? fallback?.role ?? 'cashier'
  };
}

/**
 * Gets the profile from the server. On network failure returns null — the
 * caller falls back to the locally cached identity so offline stays intact.
 */
async function tryFetchProfile(uid: string): Promise<AuthProfile | null> {
  try {
    return await fetchProfile(uid);
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  booted: false,

  initialize: async () => {
    if (get().booted) return;

    // 1. RESTORE FROM OUR OWN MIRROR — synchronous, zero network. This is
    // what makes offline refresh work: even if Supabase's own token-refresh
    // machinery considers the session dead, our identity stays signed in.
    const cached = readCachedIdentity();
    set({ user: cached });
    set({ booted: true }); // boot is instant — the mirror is authoritative

    // 2. Best-effort reconcile with Supabase's local session. Non-blocking:
    //    with an expired access token auth-js may retry a refresh for ~30s,
    //    which must never delay the shell. Only ever UPGRADES identity —
    //    resolveIdentity() keeps existing fields when the profile fetch
    //    fails (offline).
    void (async () => {
      try {
        const local = await getLocalUser();
        if (local) {
          const profile = await tryFetchProfile(local.id);
          const next = resolveIdentity(local, profile, get().user);
          set({ user: next });
          writeCachedIdentity(next);
        }
      } catch {
        // offline / not configured — keep the mirrored identity.
      }
    })();

    // 3. Background revalidation. A null user from getUser() is AMBIGUOUS —
    //    it can mean "server says no session" OR "offline, could not even
    //    ask" (auth-js returns an AuthRetryableFetchError instead of
    //    throwing). Only a definitively ONLINE answer may clear the mirror;
    //    probeOnline() is the final tie-breaker before destroying a valid
    //    login on a flaky connection.
    const revalidate = async () => {
      const { user, offline } = await checkCurrentUser();
      if (user) {
        const profile = await tryFetchProfile(user.id);
        const next = resolveIdentity(user, profile, get().user);
        set({ user: next });
        writeCachedIdentity(next);
      } else if (!offline && get().user) {
        if (await probeOnline()) {
          // Server definitively says this session is gone (revoked/expired).
          set({ user: null });
          writeCachedIdentity(null);
        }
      }
    };
    void revalidate();

    // 4. Live auth subscription. Sign-out events caused by failed OFFLINE
    //    token refresh are NOT real — re-validate against the server before
    //    acting on them; an offline (ambiguous) answer keeps the mirror.
    //
    //    MUST be best-effort like steps 2–3: subscribeToAuth() throws "Supabase
    //    is not configured" when .env is empty, and that rejection must never
    //    escape initialize() and abort the whole app boot (a fresh offline
    //    install would otherwise hang on the "Loading local…" spinner forever,
    //    never seeding, refreshing or mounting). An unconfigured cloud simply
    //    means no live auth events — the mirror still works.
    try {
      unsubscribeAuth = await subscribeToAuth(async (session) => {
      if (!session) {
        const { user, offline } = await checkCurrentUser();
        if (user) {
          const profile = await tryFetchProfile(user.id);
          const next = resolveIdentity(user, profile, get().user);
          set({ user: next });
          writeCachedIdentity(next);
        } else if (!offline && get().user && (await probeOnline())) {
          set({ user: null });
          writeCachedIdentity(null);
        }
        return;
      }
      const profile = await tryFetchProfile(session.user.id);
      const next = session.user ? resolveIdentity(session.user, profile, get().user) : null;
      set({ user: next });
      writeCachedIdentity(next);
    });
    } catch {
      unsubscribeAuth = undefined;
    }

    // 5. When connectivity returns, revalidate so an expired-token session is
    //    restored (auth-js auto-refreshes on the next API call) and the
    //    identity is re-confirmed.
    window.addEventListener('online', () => {
      void revalidate();
    });
  },

  login: async (email: string, password: string) => {
    await signIn(email, password);
    const s = await getLocalUser();
    if (!s) return;
    const profile = await tryFetchProfile(s.id);
    const next = resolveIdentity(s, profile, get().user);
    set({ user: next });
    writeCachedIdentity(next);
  },

  signUp: async (email, password, displayName) => {
    const requiresConfirmation = await signUp(email, password, displayName);
    return { requiresConfirmation };
  },

  createShop: async (name: string, phone?: string) => {
    await rpcCreateShop(name, phone);
    const user = await getLocalUser();
    if (user) {
      const profile = await tryFetchProfile(user.id);
      const next = resolveIdentity(user, profile, get().user);
      set({ user: next });
      writeCachedIdentity(next);
    }
  },

  logout: async () => {
    unsubscribeAuth?.();
    set({ user: null });
    writeCachedIdentity(null);
    try {
      await signOut();
    } catch {
      // offline sign-out — local state already cleared; server clears on next conn.
    }
  },

  switchShop: (shopId: string) => {
    set((s) => {
      if (!s.user) return { user: null };
      const next = { ...s.user, shopId };
      writeCachedIdentity(next);
      return { user: next };
    });
  }
}));

export function canSeeCosting(role: Role | undefined): boolean {
  return role === 'manager' || role === 'admin';
}

export function canManageInventory(role: Role | undefined): boolean {
  return role === 'manager' || role === 'admin';
}

/** May VIEW the staff list and add staff (the staff card on Settings). */
export function canManageStaff(role: Role | undefined): boolean {
  return role === 'admin' || role === 'manager';
}

/** May add MANAGER accounts - admins only (managers add cashiers only). */
export function canAddManager(role: Role | undefined): boolean {
  return role === 'admin';
}

export function shopIdOf(): string {
  return useAuthStore.getState().user?.shopId ?? DEFAULT_SHOP_ID;
}