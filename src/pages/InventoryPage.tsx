import { useEffect, useMemo, useState } from 'react';
import { useAuthStore, shopIdOf, canManageInventory, canSeeCosting } from '../stores/authStore';
import { useInventoryStore } from '../stores/inventoryStore';
import { useUiStore } from '../stores/uiStore';
import { createProduct, updateProduct, restockProduct, deleteProduct } from '../db/repos/products';
import { Modal, EmptyState } from '../components/ui';
import { fmtMoney, parseMoneyInput } from '../lib/utils';
import type { Product } from '../types';

export default function InventoryPage() {
  const user = useAuthStore((s) => s.user);
  const { products, costing, refresh, loadCosting } = useInventoryStore();
  const toast = useUiStore();
  const [query, setQuery] = useState('');
  const [showLowOnly, setShowLowOnly] = useState(false);
  const [modal, setModal] = useState<'new' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  /** Raw text for the selling-price field — kept as a string so the caret never
      jumps while typing (the old toFixed(2) reformat on every keystroke made
      editing a fight with the decimal point). Converted to minor units live. */
  const [priceText, setPriceText] = useState('');
  const [restockId, setRestockId] = useState<string | null>(null);
  const [restockQty, setRestockQty] = useState('10');

  const manage = canManageInventory(user?.role);
  const seeCost = canSeeCosting(user?.role);

  useEffect(() => {
    void refresh().then(() => (seeCost ? loadCosting() : undefined));
  }, [refresh, loadCosting, seeCost]);

  /** Reload products AND costing after any mutation — fixes cost/margin showing
      blank until app refresh (the old `refresh()` only reloaded products). */
  const reload = async () => {
    await refresh();
    if (seeCost) await loadCosting();
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter(
      (p) =>
        (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)) &&
        (!showLowOnly || p.stockQuantity <= p.minStockLevel)
    );
  }, [products, query, showLowOnly]);

  const handleCreate = async (form: FormData) => {
    try {
      await createProduct(shopIdOf(), user?.uid ?? 'admin-1', {
        sku: String(form.get('sku') ?? ''),
        name: String(form.get('name') ?? ''),
        description: String(form.get('description') ?? ''),
        category: String(form.get('category') ?? 'General'),
        sellingPrice: parseMoneyInput(String(form.get('price') ?? '0')),
        stockQuantity: Number(form.get('stock') ?? 0),
        minStockLevel: Number(form.get('min') ?? 0),
        costPrice: seeCost ? parseMoneyInput(String(form.get('cost') ?? '0')) : undefined,
        supplierInfo: seeCost ? String(form.get('supplier') ?? '') : undefined
      });
      toast.push('success', 'Product created');
      setModal(null);
      void reload();
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    }
  };

  const handleEdit = async () => {
    if (!editing) return;
    try {
      await updateProduct(editing.id, {
        name: editing.name,
        description: editing.description,
        category: editing.category,
        // editing.sellingPrice is already minor units (converted on input change)
        sellingPrice: editing.sellingPrice,
        minStockLevel: Number(editing.minStockLevel)
      });
      toast.push('success', 'Product updated');
      setModal(null);
      void reload();
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Arrow-key form navigation: ↑ / ↓ move focus straight up/down through the
   * fields (inputs → selects → buttons). No Tab needed — most people never
   * touch Tab. Only intercepts when there's actually a field to move to, so
   * plain scrolling and number spinners elsewhere are untouched.
   */
  const onFormKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const fields = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input, select, textarea, button'));
    const idx = fields.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) return;
    const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
    if (next < 0 || next >= fields.length) return;
    e.preventDefault();
    fields[next]?.focus();
    fields[next]?.scrollIntoView({ block: 'nearest' });
  };

  /** Opens the edit modal, seeding the price field with the current amount. */
  const openEdit = (p: Product) => {
    setEditing(p);
    setPriceText((p.sellingPrice / 100).toFixed(2));
    setModal('edit');
  };

  const doRestock = async (p: Product) => {
    const qty = Number(restockQty);
    if (!qty || qty <= 0) {
      toast.push('warn', 'Enter a positive quantity');
      return;
    }
    try {
      await restockProduct(shopIdOf(), p.id, qty, user?.uid ?? 'mgr-1');
      toast.push('success', `${p.name} restocked +${qty}`);
      setRestockId(null);
      void reload();
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Inventory</h1>
          <p className="page-sub">Local-first stock. Every change is an append-only StockLedger entry — quantities are never silently overwritten.</p>
        </div>
        {manage && (
          <button className="btn btn-primary" onClick={() => setModal('new')}>+ New Product</button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <input className="input" placeholder="Search name or SKU…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 320 }} />
        <button
          className={`btn ${showLowOnly ? 'btn-danger' : 'btn-secondary'}`}
          onClick={() => setShowLowOnly((v) => !v)}
        >
          {showLowOnly ? 'Showing low stock' : 'Show low stock'}
        </button>
        {seeCost && (
          <button className="btn btn-secondary" onClick={() => void loadCosting()}>Reload costing</button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="card"><EmptyState title="No products" hint="Add your first product or adjust filters." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>Category</th>
                <th className="num">Price</th>
                {seeCost && <th className="num">Cost</th>}
                {seeCost && <th className="num">Margin</th>}
                <th className="num">Stock</th>
                <th className="num">Min</th>
                <th>Status</th>
                {manage && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const c = costing.get(p.id);
                const low = p.stockQuantity <= p.minStockLevel;
                const margin = c && c.costPrice > 0 ? Math.round(((p.sellingPrice - c.costPrice) / p.sellingPrice) * 100) : null;
                return (
                  <tr key={p.id}>
                    <td className="mono">{p.sku}</td>
                    <td style={{ fontWeight: 700 }} title={p.description}>{p.name}</td>
                    <td>{p.category}</td>
                    <td className="num">{fmtMoney(p.sellingPrice)}</td>
                    {seeCost && <td className="num">{fmtMoney(c?.costPrice ?? 0)}</td>}
                    {seeCost && <td className="num">{margin !== null ? `${margin}%` : '—'}</td>}
                    <td className="num" style={{ fontWeight: 800, color: low ? 'var(--danger)' : 'inherit' }}>{p.stockQuantity}</td>
                    <td className="num">{p.minStockLevel}</td>
                    <td>{low ? <span className="tag red">LOW STOCK</span> : <span className="tag green">OK</span>}</td>
                    {manage && (
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-sm btn-secondary" onClick={() => openEdit(p)}>Edit</button>
                          <button className="btn btn-sm btn-success" onClick={() => setRestockId(p.id)}>Restock</button>
                          <button
                            className="btn btn-sm btn-ghost"
                            style={{ color: 'var(--danger)' }}
                            onClick={() =>
                              toast.ask(
                                'Delete product?',
                                `"${p.name}" — deleted forever if it has no sales. If it has history, it's archived (hidden but kept for records).`,
                                async () => {
                                  try {
                                    const res = await deleteProduct(p.id);
                                    toast.push('success', res.archived ? `${p.name} moved to archive` : `${p.name} deleted`);
                                    void reload();
                                  } catch (err) {
                                    toast.push('error', err instanceof Error ? err.message : String(err));
                                  }
                                }
                              )
                            }
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* New product modal */}
      <Modal open={modal === 'new'} title="New Product" onClose={() => setModal(null)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate(new FormData(e.currentTarget));
          }}
          onKeyDown={onFormKeyDown}
        >
          {/* One field per row, top → bottom — ↑ / ↓ moves focus in a straight line. */}
          <div className="field">
            <label>Product name</label>
            <input className="input" name="name" required autoFocus placeholder="e.g. HP EliteBook 840" />
          </div>
          <div className="field">
            <label>Description (optional)</label>
            <input className="input" name="description" placeholder="e.g. brand, model, flash size…" />
          </div>
          <div className="field">
            <label>Category</label>
            <input className="input" name="category" defaultValue="General" placeholder="e.g. Electronics" />
          </div>
          {seeCost && (
            <div className="field">
              <label>Cost price (GH₵) — manager only</label>
              <input className="input" name="cost" defaultValue="0" inputMode="decimal" />
            </div>
          )}
          <div className="field">
            <label>Selling price (GH₵)</label>
            <input className="input" name="price" defaultValue="0" inputMode="decimal" required />
          </div>
          <div className="field">
            <label>Quantity on hand</label>
            <input className="input" name="stock" type="number" defaultValue="0" required />
          </div>
          <div className="field">
            <label>Lowest level (low-stock alert)</label>
            <input className="input" name="min" type="number" defaultValue="0" />
          </div>
          <div className="field">
            <label>Barcode / SKU (optional)</label>
            <input className="input" name="sku" placeholder="Only if you use a barcode scanner" />
          </div>
          {seeCost && (
            <div className="field">
              <label>Supplier (optional)</label>
              <input className="input" name="supplier" />
            </div>
          )}
          {!seeCost && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Costing fields are hidden for cashier accounts (document splitting enforced in Firestore rules).
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create</button>
          </div>
        </form>
      </Modal>

      {/* Edit modal */}
      <Modal open={modal === 'edit' && !!editing} title={`Edit ${editing?.name ?? ''}`} onClose={() => setModal(null)}>
        {editing && (
          <div onKeyDown={onFormKeyDown}>
            <div className="field">
              <label>Name</label>
              <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="field">
              <label>Description (optional)</label>
              <input className="input" value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <div className="field">
              <label>Category</label>
              <input className="input" value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
            </div>
            <div className="field">
              <label>Selling price (GH₵)</label>
              <input
                className="input"
                inputMode="decimal"
                value={priceText}
                onFocus={(e) => e.target.select()}
                onChange={(e) => {
                  const t = e.target.value;
                  setPriceText(t);
                  setEditing({ ...editing, sellingPrice: parseMoneyInput(t) });
                }}
              />
            </div>
            <div className="field">
              <label>Lowest level (low-stock alert)</label>
              <input className="input" type="number" value={editing.minStockLevel} onChange={(e) => setEditing({ ...editing, minStockLevel: Number(e.target.value) })} />
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Stock quantity changes go through the Restock flow — never edit quantity here (audit trail).
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void handleEdit()}>Save</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Restock modal */}
      <Modal open={restockId !== null} title="Restock" onClose={() => setRestockId(null)}>
        {restockId && (
          <div onKeyDown={onFormKeyDown}>
            <div className="modal-sub">
              {products.find((p) => p.id === restockId)?.name} — adds an append-only RESTOCK ledger entry + weighted-average cost update.
            </div>
            <div className="field">
              <label>Quantity to add</label>
              <input className="input" type="number" value={restockQty} onChange={(e) => setRestockQty(e.target.value)} min={1} />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setRestockId(null)}>Cancel</button>
              <button className="btn btn-success" onClick={() => void doRestock(products.find((p) => p.id === restockId)!)}>Restock</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
