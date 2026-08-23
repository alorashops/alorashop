import type { Sale } from '../types';
import { fmtMoney, fmtDateTime } from '../lib/utils';
import { DEFAULT_SHOP_NAME } from '../config/env';

/**
 * Receipt printing.
 *
 * 1. Thermal: ESC/POS via WebUSB/WebBluetooth when a device is available.
 * 2. Fallback: a print-CSS template window (works on any printer).
 * 3. Digital: WhatsApp deep link / native share — free and device-side.
 */

export async function printThermal(sale: Sale, shopName = DEFAULT_SHOP_NAME): Promise<boolean> {
  // ESC/POS bytes: 80mm at ~32 chars/line. This is the 58mm-friendly core.
  const lines = buildReceiptLines(sale, shopName);
  const esc = [
    '\x1B@', // init
    '\x1B\x61\x01', // center
    ...lines.slice(0, 3),
    '\x1B\x61\x00', // left
    ...lines.slice(3)
  ];
  const text = esc.join('\n');
  try {
    const device = await requestPrinter();
    if (device) {
      await device.transferOut(1, new TextEncoder().encode(text + '\n\x1D\x56\x41\x10'));
      return true;
    }
  } catch {
    /* fall through to CSS print */
  }
  return printCss(sale, shopName);
}

interface PrinterDevice {
  claimInterface: (interfaceNumber: number) => Promise<void>;
  transferOut: (endpoint: number, data: Uint8Array) => Promise<unknown>;
}

async function requestPrinter(): Promise<PrinterDevice | null> {
  // WebUSB picker — users select their 58/80mm thermal printer once.
  try {
    const nav = navigator as Navigator & { usb?: { requestDevice: (o: unknown) => Promise<PrinterDevice> } };
    if (!nav.usb) return null;
    const device = await nav.usb.requestDevice({ filters: [] });
    await device.claimInterface(0);
    return device;
  } catch {
    return null;
  }
}

export function buildReceiptLines(sale: Sale, shopName = DEFAULT_SHOP_NAME): string[] {
  const lines: string[] = [];
  lines.push(shopName);
  lines.push('Tel: 0302-000-000');
  lines.push('--------------------------------');
  lines.push(`RCPT: ${sale.receiptNumber}`);
  lines.push(`DATE: ${fmtDateTime(sale.createdAt)}`);
  lines.push(`CASHIER: ${sale.cashierName ?? sale.cashierId}`);
  lines.push('--------------------------------');
  for (const it of sale.items) {
    lines.push(it.productName.slice(0, 30));
    lines.push(`  ${it.quantity} x ${fmtMoney(it.unitPrice)}  ${fmtMoney(it.lineTotal)}`);
  }
  lines.push('--------------------------------');
  lines.push(`SUBTOTAL        ${fmtMoney(sale.subtotal)}`);
  if (sale.discount > 0) lines.push(`DISCOUNT       -${fmtMoney(sale.discount)}`);
  lines.push(`TOTAL           ${fmtMoney(sale.totalAmount)}`);
  for (const p of sale.payments) {
    lines.push(`${p.method.padEnd(12)} ${fmtMoney(p.amount)}`);
  }
  lines.push('--------------------------------');
  lines.push('THANK YOU FOR SHOPPING WITH US!');
  return lines;
}

export function printCss(sale: Sale, shopName = DEFAULT_SHOP_NAME): boolean {
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) return false;
  const body = buildReceiptLines(sale, shopName)
    .map((l) => `<div>${l.replace(/ /g, '&nbsp;')}</div>`)
    .join('');
  w.document.write(`<!doctype html><html><head><title>Receipt</title><style>
    @page { size: 80mm auto; margin: 2mm; }
    body { font-family: 'Courier New', monospace; font-size: 12px; white-space: pre; }
    .no-print { display: block; margin-bottom: 8px; }
    @media print { .no-print { display: none; } }
  </style></head><body>
    <button class="no-print" onclick="window.print()">Print Receipt</button>
    ${body}
  </body></html>`);
  w.document.close();
  return true;
}

/** Digital receipt — WhatsApp deep link (free, device-side, no SMS cost). */
export function digitalReceipt(sale: Sale, phone?: string, shopName = DEFAULT_SHOP_NAME): void {
  const text = encodeURIComponent(buildReceiptLines(sale, shopName).join('\n'));
  const url = phone
    ? `https://wa.me/${phone.replace(/[^\d]/g, '')}?text=${text}`
    : `https://wa.me/?text=${text}`;
  window.open(url, '_blank');
}

export function shareReceipt(sale: Sale, shopName = DEFAULT_SHOP_NAME): void {
  const text = buildReceiptLines(sale, shopName).join('\n');
  if (navigator.share) {
    void navigator.share({ title: `Receipt ${sale.receiptNumber}`, text }).catch(() => undefined);
  } else {
    void navigator.clipboard?.writeText(text);
  }
}