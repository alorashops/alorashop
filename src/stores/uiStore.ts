import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info' | 'warn';
  message: string;
}

interface UiState {
  toasts: Toast[];
  receiptOpen: boolean;
  lastReceiptSaleId?: string;
  confirmState?: { title: string; message: string; onConfirm: () => void };
  push: (kind: Toast['kind'], message: string) => void;
  dismiss: (id: number) => void;
  openReceipt: (saleId: string) => void;
  closeReceipt: () => void;
  ask: (title: string, message: string, onConfirm: () => void) => void;
  clearConfirm: () => void;
}

let toastSeq = 1;

export const useUiStore = create<UiState>((set) => ({
  toasts: [],
  receiptOpen: false,
  lastReceiptSaleId: undefined,

  push: (kind, message) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  openReceipt: (saleId) => set({ receiptOpen: true, lastReceiptSaleId: saleId }),
  closeReceipt: () => set({ receiptOpen: false }),

  ask: (title, message, onConfirm) => set({ confirmState: { title, message, onConfirm } }),
  clearConfirm: () => set({ confirmState: undefined })
}));