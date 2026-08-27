/**
 * AloraShop — Domain model.
 * Mirrors the plain-text data model in the architecture spec exactly.
 * Local-only fields (outbox / sync metadata) are kept on the row so a sale is
 * "done" the moment it lands in IndexedDB.
 */

export type Role = 'cashier' | 'manager' | 'admin';

export type PaymentMethod = 'CASH' | 'CARD' | 'PAYSTACK' | 'CREDIT';
export type PaymentStatus = 'PAID' | 'PENDING_VERIFICATION' | 'CREDIT_OPEN';

export type LedgerType = 'SALE' | 'RESTOCK' | 'DAMAGE' | 'RETURN' | 'VOID';
export type CreditLedgerType = 'CHARGE' | 'PAYMENT' | 'REVERSAL';

export type OutboxStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';
export type OutboxEntity =
  | 'SALE'
  | 'RESTOCK'
  | 'VOID'
  | 'PRODUCT'
  | 'PRODUCT_COSTING'
  | 'CUSTOMER'
  | 'CREDIT_LEDGER'
  | 'DAILY_SUMMARY';

// ---------------------------------------------------------------------------
// Product (public face — cashier can read)
// ---------------------------------------------------------------------------
export interface Product {
  id: string;
  sku: string; // also used as the scan barcode
  name: string;
  /** Optional detail — e.g. brand/model/spec for one-off items like laptops. */
  description?: string;
  category: string;
  sellingPrice: number; // money stored as kobo / minor units (integer)
  stockQuantity: number;
  minStockLevel: number;
  /** Soft-delete: archived products are hidden from checkout + inventory list
      but kept so historical sales/ledgers/summaries still resolve. */
  archived?: boolean;
  /** When the product was archived (epoch ms) — the seed for a future
      retention purge. Undefined on live products. */
  archivedAt?: number;
  shopId: string;
  updatedAt: number;
}

// Restricted subcollection — manager/admin read only. Never exposed to cashier UI.
export interface ProductCosting {
  productId: string;
  costPrice: number;
  weightedAverageCost: number;
  supplierInfo?: string;
  /** Units on hand at last costing update — used for weighted-average costing. */
  currentQty?: number;
  /** Owning shop — tenant key used for cloud mirror scoping (RLS/sync). */
  shopId?: string;
  updatedAt: number;
}

export interface SaleItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number; // snapshot of selling price at sale time
  lineTotal: number;
  costPriceAtSale?: number; // only present when manager backfill ran locally
}

export interface PaymentSplit {
  method: PaymentMethod;
  amount: number;
  customerId?: string; // required when method === 'CREDIT'
}

export interface Sale {
  id: string;
  receiptNumber: string; // sequential per shop per day
  shopId: string;
  cashierId: string;
  cashierName?: string;
  items: SaleItem[];
  subtotal: number;
  discount: number;
  totalAmount: number;
  payments: PaymentSplit[];
  paymentMethod: PaymentMethod; // primary method (for quick filters)
  paymentStatus: PaymentStatus;
  createdAt: number;
  voidedBy?: string; // reversal doc id, if any
  // --- manager backfill (profit) ---
  profit?: number;
  // --- local-only sync metadata (never synced as-is to the cloud) ---
  syncedToCloud: boolean;
  outboxRetryCount: number;
  idempotencyKey: string;
  outboxId?: string;
}

export interface StockLedgerEntry {
  id: string;
  productId: string;
  type: LedgerType;
  quantityDelta: number;
  referenceId: string;
  actorId: string;
  shopId: string;
  createdAt: number;
}

export interface DailySummary {
  id: string; // `${shopId}_${yyyy-mm-dd}`
  shopId: string;
  date: string; // yyyy-mm-dd
  salesCount: number;
  totalsByMethod: Record<PaymentMethod, number>;
  totalRevenue: number;
  totalProfit: number; // restricted read
  topSelling: Array<{ productId: string; productName: string; qty: number; revenue: number }>;
  lastUpdatedAt: number;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  creditBalance: number; // minor units; > 0 means the shop is owed money (customer owes shop)
  /** Per-customer credit guardrail — false blocks CREDIT checkout for this customer. */
  allowCredit: boolean;
  shopId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreditLedgerEntry {
  id: string;
  customerId: string;
  type: CreditLedgerType;
  amount: number;
  referenceId: string; // saleId or payment id
  shopId: string;
  createdAt: number;
  /** Who recorded the entry (cashier). Set on PAYMENT; CHARGE/REVERSAL resolve via the sale. */
  actorId?: string;
  actorName?: string;
}

export interface UserProfile {
  uid: string;
  shopId: string;
  displayName: string;
  role: Role; // UX convenience mirror — real enforcement lives in Firestore rules / claims
}

// ---------------------------------------------------------------------------
// Outbox — the durability backbone. A sale is durable the moment it lands here.
// ---------------------------------------------------------------------------
export interface OutboxEntry {
  id: string;
  idempotencyKey: string;
  entityType: OutboxEntity;
  payload: unknown; // full document to write to Firestore
  status: OutboxStatus;
  retryCount: number;
  createdAt: number;
  lastAttemptAt?: number;
  error?: string;
}

export interface SyncState {
  /** The stable deviceId this sync state belongs to — one cursor per device. */
  id: string;
  lastSyncCursor: number; // epoch ms watermark for delta pulls
  lastSyncedAt: number;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
export interface CartLine {
  productId: string;
  sku: string;
  name: string;
  unitPrice: number;
  quantity: number;
  stockAvailable: number;
}

export interface QuotaUsage {
  reads: number;
  writes: number;
  deletes: number;
  date: string;
}

export interface AppUser {
  uid: string;
  /** Null when the user signed up but hasn't created/joined a shop yet. */
  shopId: string | null;
  displayName: string;
  role: Role;
}
