import { create } from 'zustand';
import type { CartLine, PaymentMethod, PaymentSplit } from '../types';

interface CartState {
  lines: CartLine[];
  discount: number; // minor units
  payments: PaymentSplit[];
  activePayment: PaymentMethod;
  customerId?: string;
  cashTendered: number; // minor units
  lastSaleId?: string;

  add: (line: CartLine) => void;
  setQty: (productId: string, qty: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
  setDiscount: (minor: number) => void;
  setActivePayment: (m: PaymentMethod) => void;
  setCustomerId: (id?: string) => void;
  /** Jump from the Customers page straight into a credit checkout for this customer. */
  startCreditSale: (customerId: string) => void;
  clearCustomer: () => void;
  setCashTendered: (minor: number) => void;
  addPayment: (split: PaymentSplit) => void;
  removePayment: (method: PaymentMethod) => void;
  resetPayments: () => void;
  setLastSaleId: (id?: string) => void;
}

const initialPayments: PaymentSplit[] = [];

export const useCartStore = create<CartState>((set) => ({
  lines: [],
  discount: 0,
  payments: initialPayments,
  activePayment: 'CASH',
  cashTendered: 0,
  lastSaleId: undefined,

  add: (line) =>
    set((s) => {
      const existing = s.lines.find((l) => l.productId === line.productId);
      if (existing) {
        return {
          lines: s.lines.map((l) =>
            l.productId === line.productId
              ? { ...l, quantity: Math.min(line.stockAvailable, l.quantity + 1) }
              : l
          )
        };
      }
      return { lines: [...s.lines, { ...line, quantity: 1 }] };
    }),

  setQty: (productId, qty) =>
    set((s) => ({
      lines: s.lines.map((l) =>
        l.productId === productId
          ? { ...l, quantity: Math.max(0, Math.min(l.stockAvailable, Math.floor(qty))) }
          : l
      )
    })),

  remove: (productId) => set((s) => ({ lines: s.lines.filter((l) => l.productId !== productId) })),

  clear: () => set({ lines: [], discount: 0, payments: [], cashTendered: 0, customerId: undefined }),

  setDiscount: (minor) => set({ discount: Math.max(0, minor) }),

  setActivePayment: (m) => set({ activePayment: m }),

  setCustomerId: (id) => set({ customerId: id }),

  startCreditSale: (customerId) => set({ customerId, activePayment: 'CREDIT' }),

  clearCustomer: () => set({ customerId: undefined }),

  setCashTendered: (minor) => set({ cashTendered: minor }),

  addPayment: (split) =>
    set((s) => {
      const rest = s.payments.filter((p) => p.method !== split.method);
      return { payments: [...rest, split] };
    }),

  removePayment: (method) => set((s) => ({ payments: s.payments.filter((p) => p.method !== method) })),

  resetPayments: () => set({ payments: [], cashTendered: 0 }),

  setLastSaleId: (id) => set({ lastSaleId: id })
}));

/** Derived helpers (pure selectors used by components). */
export function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
}

export function cartTotal(lines: CartLine[], discountMinor: number): number {
  return Math.max(0, cartSubtotal(lines) - discountMinor);
}

export function changeDue(tendered: number, total: number): number {
  return Math.max(0, tendered - total);
}

export { parseMoneyInput } from '../lib/utils';