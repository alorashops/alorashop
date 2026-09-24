import { getSupabase } from './supabase';
import { isSupabaseConfigured } from '../config/env';
import type { Sale } from '../types';

/**
 * P9 — call the `verify-payment` Edge Function to confirm a Paystack charge.
 *
 * The authoritative verification lives SERVER-SIDE (the Edge Function holds the
 * secret key). The client can only ask: "is this reference a real, paid
 * charge?" The Edge Function answers by querying Paystack, then promotes the
 * sale PENDING_VERIFICATION -> PAID in the cloud (service role) and writes an
 * audit row. This client never decides PAID on its own.
 *
 * The sale row must ALREADY be in the cloud - the function reads the STORED
 * amount and will NOT create a row. Until the outbox flush lands it answers
 * `sale_not_synced`; syncService re-verifies flushed card sales automatically.
 */
export interface VerifyPaymentResult {
  verified: boolean;
  reference: string;
  saleId?: string;
  status?: string;
  message?: string;
}

export async function verifyPayment(reference: string, sale: Sale): Promise<VerifyPaymentResult> {
  if (!isSupabaseConfigured) {
    return { verified: false, reference, status: 'not_configured', message: 'Supabase not configured' };
  }
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.functions.invoke('verify-payment', {
      // P9: the verifier reads the amount off the STORED sale row, so the only
      // thing it needs is WHICH sale to look at. Sending the whole document
      // invited the server to trust client-supplied money.
      body: { reference, sale: { id: sale.id } }
    });
    if (error) {
      return { verified: false, reference, status: 'error', message: error.message ?? 'verify call failed' };
    }
    return (data as VerifyPaymentResult) ?? { verified: false, reference, status: 'empty' };
  } catch (err) {
    return { verified: false, reference, status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}