/**
 * Supabase adapter — lazily initialized so the offline shell never pays the
 * bundle cost until auth is actually used. The Supabase session persists in
 * localStorage automatically; our app never stores secrets itself.
 */
import {
  createClient,
  isAuthRetryableFetchError,
  type SupabaseClient,
  type Session,
  type User
} from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey, isSupabaseConfigured } from '../config/env';
import type { Role } from '../types';

let clientPromise: Promise<SupabaseClient> | undefined;

/** Lazily build the shared client. Throws if .env is not configured. */
function getSupabase(): Promise<SupabaseClient> {
  if (!isSupabaseConfigured) {
    return Promise.reject(new Error('Supabase is not configured. Add VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY to .env'));
  }
  if (!clientPromise) {
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    clientPromise = Promise.resolve(client);
  }
  return clientPromise;
}

/** Mirrors a row in the public.profiles table. */
export interface AuthProfile {
  id: string;
  shop_id: string | null;
  role: 'cashier' | 'manager' | 'admin' | null;
  display_name: string | null;
}

export async function getSession(): Promise<Session | null> {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  return data.session;
}

/**
 * Current user from the LOCALLY persisted session. This is 100% offline —
 * it reads Supabase's own localStorage cache and never touches the network.
 * Returns null only when no session has ever been stored locally.
 */
export async function getLocalUser(): Promise<User | null> {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  return data.session?.user ?? null;
}

/**
 * VALIDATES the session against the server (network call — refreshes the token
 * when possible).
 *
 * Returns:
 * - `{ user, offline: false }` when the server answered. `user` may still be
 *   null — that is a DEFINITIVE "no session" answer and callers may clear
 *   their local identity.
 * - `{ user: null, offline: true }` when the request could not be completed
 *   (offline / network degradation). Callers MUST keep any locally stored
 *   identity in that case — it is NOT a sign-out.
 *
 * IMPORTANT: `getUser()` does NOT throw on network failures — it returns an
 * `AuthRetryableFetchError` in the error field (a subclass of `AuthError`).
 * `isAuthRetryableFetchError` is the only reliable way to tell "could not
 * reach the server" from "the server says this session is gone".
 */
export async function checkCurrentUser(): Promise<{ user: User | null; offline: boolean }> {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.auth.getUser();
    if (error) {
      return { user: null, offline: isAuthRetryableFetchError(error) };
    }
    return { user: data.user ?? null, offline: false };
  } catch {
    // getSupabase() rejected (not configured) or a non-AuthError escaped.
    return { user: null, offline: true };
  }
}

/**
 * Cheap connectivity probe. Any HTTP response — even 4xx/5xx — proves the
 * network is reachable; only a fetch failure (no response / abort) means
 * offline. Used as a final safety net before destroying the local identity
 * mirror on a flaky connection.
 */
export async function probeOnline(timeoutMs = 4000): Promise<boolean> {
  if (!supabaseUrl) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(`${supabaseUrl}/auth/v1/health`, { signal: ctrl.signal, cache: 'no-store' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchProfile(uid: string): Promise<AuthProfile | null> {
  const sb = await getSupabase();
  const { data, error } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (error) throw error;
  return (data as AuthProfile | null) ?? null;
}

export async function signIn(email: string, password: string): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/** Returns true when email confirmation is still required (session not yet active). */
export async function signUp(email: string, password: string, displayName: string): Promise<boolean> {
  const sb = await getSupabase();
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } }
  });
  if (error) throw error;
  return !data.session; // falsy session => a verification email was dispatched
}

export async function signOut(): Promise<void> {
  const sb = await getSupabase();
  await sb.auth.signOut();
}

/** Calls the SECURITY DEFINER RPC that creates a shop and makes the caller its admin. */
export async function createShop(shopName: string, phone?: string): Promise<string> {
  const sb = await getSupabase();
  const { data, error } = await sb.rpc('create_shop', { shop_name: shopName, phone: phone ?? null });
  if (error) throw error;
  return data as string; // the new shop_id
}

/**
 * Adds a staff member via the SECURITY DEFINER RPC. Role guardrails run
 * server-side: admin may add manager/cashier, manager may add cashier only.
 * Returns the new user's id.
 *
 * IMPORTANT: this only CREATES the account (email-unconfirmed, unusable
 * password). The caller must then call `sendStaffInvite()` so the new hire
 * receives an email with a recovery link to set their own password.
 */
export async function addStaff(email: string, displayName: string, role: Role): Promise<string> {
  const sb = await getSupabase();
  const { data, error } = await sb.rpc('add_staff', {
    staff_email: email.trim(),
    staff_name: displayName.trim(),
    staff_role: role
  });
  if (error) throw error;
  return data as string;
}

/**
 * Emails the staff member a password-recovery link (GoTrue's default recovery
 * template) — the invite mechanism. Clicking it purports to set a password; we
 * guide them to it, which both verifies their email and completes the signup.
 * Uses the public anon-key endpoint, so no service-role secret is required.
 * `#/reset` matches the HashRouter route for the invite landing screen.
 */
export async function sendStaffInvite(email: string): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${window.location.origin}${window.location.pathname}#/reset`
  });
  if (error) throw error;
}

/** Sets a new password for the currently-authenticated (recovery) session. */
export async function updatePassword(newPassword: string): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/** True when an active session exists (a recovery link / invite has been opened). */
export async function hasActiveSession(): Promise<boolean> {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  return Boolean(data.session);
}

/**
 * Subscribes to auth changes (sign in / out / refresh). Returns an unsubscribe
 * function. The callback receives the latest session (or null on sign-out).
 */
export async function subscribeToAuth(cb: (session: Session | null) => void): Promise<() => void> {
  const sb = await getSupabase();
  const { data } = sb.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}