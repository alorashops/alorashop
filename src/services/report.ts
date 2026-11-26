/**
 * Client bridge for the server-generated analytics report.
 *
 * The report is ONLINE-ONLY on purpose: it is generated from cloud-synced
 * data by the `analytics-report` Edge Function, which also enforces the
 * manager/admin role server-side. This service pushes any queued local rows
 * first (best-effort) so the cloud snapshot is as fresh as possible, then
 * invokes the function and downloads the returned PDF.
 *
 * No HTML is built here and no PDF is generated in the browser.
 */
import { getSupabase } from './supabase';
import { isSupabaseConfigured } from '../config/env';
import { flushOutbox } from './syncService';
import { isOnline } from '../db/db';
import { useSyncStore } from '../stores/syncStore';
import type { ReportModel } from '../types';

export type ReportErrorCode =
  | 'not_configured'
  | 'offline'
  | 'unauthenticated'
  | 'forbidden'
  | 'range_too_large'
  | 'report_failed';

export class ReportError extends Error {
  code: ReportErrorCode;
  status?: number;

  constructor(message: string, code: ReportErrorCode, status?: number) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
    this.status = status;
  }
}

export interface CloudReportResponse {
  report: ReportModel;
  pdfBase64: string;
  fileName: string;
  generatedAt: string;
  salesRows?: number;
}

export interface CloudReportResult extends CloudReportResponse {
  /** Local records still queued after the best-effort flush (not in the PDF). */
  pendingSkipped: number;
  /** Local records that are failing sync (not in the PDF). */
  failedSkipped: number;
}

interface FunctionPayload {
  ok?: boolean;
  report?: ReportModel;
  pdfBase64?: string;
  fileName?: string;
  generatedAt?: string;
  salesRows?: number;
  error?: string;
  message?: string;
}

/**
 * Flush first, then ask the server for the report. A flush failure is
 * deliberately non-fatal: the report still runs, and the caller shows the
 * unsynced count so the manager knows the cloud snapshot is incomplete.
 */
export async function generateCloudReport(fromDate: string, toDate: string): Promise<CloudReportResult> {
  if (!isSupabaseConfigured) {
    throw new ReportError('Report generation is not configured on this deployment.', 'not_configured');
  }
  if (!(await isOnline())) {
    throw new ReportError('Generating a report needs an internet connection.', 'offline');
  }

  let pendingSkipped = 0;
  let failedSkipped = 0;
  try {
    await flushOutbox(true);
    await useSyncStore.getState().refresh();
    pendingSkipped = useSyncStore.getState().pending;
    failedSkipped = useSyncStore.getState().failed;
  } catch {
    // The report is still useful with whatever the cloud already has.
  }

  const sb = await getSupabase();
  const { data, error } = await sb.functions.invoke('analytics-report', {
    body: { fromDate, toDate }
  });

  if (error) {
    let status: number | undefined;
    let payload: FunctionPayload | null = null;
    const context = (error as { context?: unknown }).context as Response | undefined;
    if (context && typeof context.status === 'number') {
      status = context.status;
      if (typeof context.json === 'function') {
        try {
          payload = (await context.json()) as FunctionPayload;
        } catch {
          // Not JSON (network/relay) — fall through to the generic message.
        }
      }
    }
    const code: ReportErrorCode =
      status === 401
        ? 'unauthenticated'
        : status === 403
          ? 'forbidden'
          : status === 413
            ? 'range_too_large'
            : 'report_failed';
    throw new ReportError(
      payload?.message ?? error.message ?? 'The report could not be generated.',
      code,
      status
    );
  }

  const result = data as FunctionPayload | null;
  if (
    !result?.ok ||
    !result.report ||
    typeof result.pdfBase64 !== 'string' ||
    !result.pdfBase64 ||
    !result.fileName
  ) {
    throw new ReportError(
      result?.message ?? 'The report service returned an incomplete response.',
      'report_failed'
    );
  }

  return {
    report: result.report,
    pdfBase64: result.pdfBase64,
    fileName: result.fileName,
    generatedAt: result.generatedAt ?? new Date().toISOString(),
    salesRows: result.salesRows,
    pendingSkipped,
    failedSkipped
  };
}

/** Decode the server PDF and hand it to the browser's download mechanism. */
export function downloadReportPdf(base64: string, fileName: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const safeName = (fileName || 'AloraShop_Report.pdf').replace(/[\\/:*?"<>|]+/g, '_');
  const name = safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}