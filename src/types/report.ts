/**
 * Client mirror of the JSON returned by the `analytics-report` Edge Function.
 * Money is in integer minor units. The server owns the calculations; this file
 * exists only so the preview modal is typed.
 */

export interface ReportKpi {
  key: string;
  label: string;
  kind: 'int' | 'money' | 'percent';
  value: number;
  detailLabel?: string;
  detail?: string;
  detailMoney?: number;
}

export interface ReportPaymentRow {
  method: string;
  count: number;
  amount: number;
  sharePct: number;
}

export interface ReportDailyRow {
  date: string;
  sales: number;
  revenue: number;
  profit: number;
  discounts: number;
  unverifiedCount: number;
  unverifiedAmount: number;
}

export interface ReportTopProductRow {
  rank: number;
  name: string;
  units: number;
  revenue: number;
  profit: number | null;
  marginPct: number | null;
}

export interface ReportStaffRow {
  name: string;
  sales: number;
  revenue: number;
}

export interface ReportLowStockRow {
  sku: string;
  name: string;
  onHand: number;
  minStockLevel: number;
  status: 'OUT' | 'LOW';
}

export interface ReportDebtorRow {
  name: string;
  phoneMasked: string;
  balance: number;
}

export interface ReportModel {
  meta: {
    title: string;
    shopName: string;
    shopId: string;
    fromDate: string;
    toDate: string;
    generatedAt: number;
    generatedBy: string;
    generatedByRole: string;
    confidential: true;
  };
  period: {
    days: number;
    activeDays: number;
    firstSaleDate: string | null;
    lastSaleDate: string | null;
  };
  hasSales: boolean;
  kpis: ReportKpi[];
  payments: {
    rows: ReportPaymentRow[];
    totalCount: number;
    totalAmount: number;
  };
  daily: {
    rows: ReportDailyRow[];
    totals: Omit<ReportDailyRow, 'date'>;
  };
  topProducts: {
    rows: ReportTopProductRow[];
    hasProfit: boolean;
  };
  staff: {
    rows: ReportStaffRow[];
    totalCount: number;
  };
  status: {
    recordedSales: number;
    collectedSales: number;
    unverified: { count: number; amount: number };
    credit: { count: number; amount: number };
    voids: { count: number; amount: number };
  };
  profit: {
    total: number;
    coveredSales: number;
    uncoveredSales: number;
    coveragePct: number;
  };
  stock: {
    units: number;
    value: number;
    lowStockCount: number;
    productsWithoutCost: number;
    rows: ReportLowStockRow[];
    asOf: number;
  };
  receivables: {
    totalOwed: number;
    totalShopOwes: number;
    net: number;
    debtorCount: number;
    shopOwesCount: number;
    newCustomers: number;
    rows: ReportDebtorRow[];
  };
  notes: string[];
}