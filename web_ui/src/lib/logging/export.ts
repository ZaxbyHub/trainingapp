/**
 * Diagnostics export (issue #248, AC4): write the admitted-entry ring to a
 * user-chosen file via showSaveFilePicker where available, falling back to a
 * browser download where it is not. The picker call happens synchronously
 * within user activation (the bundle is built before any await).
 *
 * Outcome policy (05-fix-plan.md): user cancel -> 'cancelled'; picker
 * UNAVAILABLE or picker-open failure (non-abort) -> 'fallback' (the
 * downloadTextFile reuse from lib/export/conversation-export.ts); picker
 * WRITE/close failure -> 'error' (no silent download fallback — a half-written
 * destination must be surfaced, not papered over).
 */
import { admittedEntries, type LogEntry } from './index';
import { persistedForm } from './redact';
import { downloadTextFile } from '../export/conversation-export';

// Narrow local declaration: the DOM lib does not model showSaveFilePicker.
interface SaveFilePickerWritable {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}
interface SaveFilePickerHandle {
  createWritable(): Promise<SaveFilePickerWritable>;
}
type ShowSaveFilePicker = (options?: { suggestedName?: string }) => Promise<SaveFilePickerHandle>;

export interface DiagnosticsExportOutcome {
  outcome: 'saved' | 'cancelled' | 'fallback' | 'error';
  detail?: string;
}

/** Stable bundle shape for the browser/renderer diagnostics export. */
export interface DiagnosticsBundle {
  exportedAt: string;
  version: 1;
  entries: LogEntry[];
}

/** Assemble the export JSON (every persisted field passes the gate again). */
export function buildDiagnosticsBundle(): string {
  const bundle: DiagnosticsBundle = {
    exportedAt: new Date().toISOString(),
    version: 1,
    entries: admittedEntries().map((entry) => ({ ...entry, message: persistedForm(entry.message) })),
  };
  return JSON.stringify(bundle, null, 2);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Export the ring now. Returns the outcome; never throws. */
export async function exportDiagnostics(): Promise<DiagnosticsExportOutcome> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `trainingapp-diagnostics-${stamp}.json`;
  // Synchronous, before the first await: the picker call below stays inside
  // the click's user-activation window.
  const content = buildDiagnosticsBundle();

  const picker = (window as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (typeof picker !== 'function') {
    downloadTextFile(content, filename, 'application/json');
    return { outcome: 'fallback' };
  }
  let handle: SaveFilePickerHandle;
  try {
    handle = await picker.call(window, { suggestedName: filename });
  } catch (err) {
    if (isAbortError(err)) return { outcome: 'cancelled' };
    // Picker-open failure (non-abort): automatic download fallback.
    downloadTextFile(content, filename, 'application/json');
    return { outcome: 'fallback', detail: detailOf(err) };
  }
  try {
    const writable = await handle.createWritable();
    await writable.write(new Blob([content], { type: 'application/json' }));
    await writable.close();
    return { outcome: 'saved' };
  } catch (err) {
    // Write/close failure: surfaced, never a silent fallback download.
    return { outcome: 'error', detail: detailOf(err) };
  }
}
