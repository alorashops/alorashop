import { useEffect, useState } from 'react';
import { Modal } from './ui';
import { useUiStore } from '../stores/uiStore';
import { getSaleById } from '../db/repos/sales';
import { buildReceiptLines, printThermal, printCss, digitalReceipt, shareReceipt } from '../services/printService';
import { fmtMoney } from '../lib/utils';
import { DEFAULT_SHOP_NAME } from '../config/env';
import type { Sale } from '../types';

export function ReceiptModal() {
  const open = useUiStore((s) => s.receiptOpen);
  const close = useUiStore((s) => s.closeReceipt);
  const saleId = useUiStore((s) => s.lastReceiptSaleId);
  const [sale, setSale] = useState<Sale | undefined>();

  useEffect(() => {
    if (open && saleId) {
      void getSaleById(saleId).then(setSale);
    } else {
      setSale(undefined);
    }
  }, [open, saleId]);

  if (!open || !sale) return null;

  const totalPaid = sale.payments.reduce((s, p) => s + p.amount, 0);
  const change = Math.max(0, totalPaid - sale.totalAmount);

  return (
    <Modal open={open} title={`Receipt ${sale.receiptNumber}`} onClose={close}>
      <div className="receipt-sheet">
        {buildReceiptLines(sale).map((l, i) => (
          <div key={i}>{l || '\u00A0'}</div>
        ))}
      </div>
      {change > 0 && (
        <div style={{ marginTop: 8, fontWeight: 700, fontFamily: 'var(--mono)' }}>
          CHANGE DUE: {fmtMoney(change)}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => void printThermal(sale, DEFAULT_SHOP_NAME)}>🖨️ Print</button>
        <button className="btn btn-secondary" onClick={() => printCss(sale, DEFAULT_SHOP_NAME)}>CSS Print</button>
        <button className="btn btn-secondary" onClick={() => digitalReceipt(sale)}>📱 WhatsApp</button>
        <button className="btn btn-secondary" onClick={() => shareReceipt(sale)}>Share</button>
        <button className="btn btn-ghost" onClick={close} style={{ marginLeft: 'auto' }}>Close</button>
      </div>
    </Modal>
  );
}