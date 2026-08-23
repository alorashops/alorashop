import { create } from 'zustand';
import { outboxBreakdown, getTodayQuota } from '../db/repos/outbox';
import { DAILY_SYNC_LIMITS } from '../config/env';
import type { QuotaUsage } from '../types';

interface SyncState {
  online: boolean;
  syncing: boolean;
  /** TRUE "queued to sync": PENDING entries that can reach the cloud. */
  pending: number;
  /** Stuck entries that could sync but keep failing (see lastError). */
  failed: number;
  /** Demo/offline entries that can never sync — excluded from `pending`. */
  localOnly: number;
  lastSyncAt?: number;
  /** The last error that stopped a flush — surfaced so it is never silent. */
  lastError?: string;
  quota: QuotaUsage;
  /** >0 => degraded (quota warning); never blocks staff work. */
  quotaPct: number;
  refresh: () => Promise<void>;
  setOnline: (v: boolean) => void;
  setSyncing: (v: boolean) => void;
  markSynced: () => void;
  markSyncError: (msg: string) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  syncing: false,
  pending: 0,
  failed: 0,
  localOnly: 0,
  lastSyncAt: undefined,
  lastError: undefined,
  quota: { reads: 0, writes: 0, deletes: 0, date: '' },
  quotaPct: 0,

  refresh: async () => {
    const [breakdown, quota] = await Promise.all([outboxBreakdown(), getTodayQuota()]);
    // Per-kind ratio against its own cap — reads were previously scored against
    // the writes cap (20k), hugely overstating the real traffic.
    const pct = Math.round(
      Math.max(
        quota.reads / DAILY_SYNC_LIMITS.reads,
        quota.writes / DAILY_SYNC_LIMITS.writes,
        quota.deletes / DAILY_SYNC_LIMITS.deletes
      ) * 100
    );
    set({
      pending: breakdown.pending,
      failed: breakdown.failed,
      localOnly: breakdown.localOnly,
      quota,
      quotaPct: pct
    });
  },

  setOnline: (v) => set({ online: v }),
  setSyncing: (v) => set({ syncing: v }),
  markSynced: () => set((s) => ({ lastSyncAt: Date.now(), syncing: false, lastError: undefined, pending: 0 })),
  markSyncError: (msg) => set({ syncing: false, lastError: msg })
}));

export function quotaLevel(pct: number): 'ok' | 'warn' | 'critical' {
  if (pct >= 100) return 'critical';
  if (pct >= 70) return 'warn';
  return 'ok';
}