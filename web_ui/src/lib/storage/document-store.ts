/**
 * IndexedDB persistence layer for documents.
 * Provides offline-first storage using raw IndexedDB API.
 */

import type { DocumentEntry } from '../../types/document';
import { getProfilePrefix, getStorageDbNames } from './profile';
import { createStoreChannel } from './cross-tab-channel';

/**
 * Generate a stable, user-scoped prefix for IndexedDB names.
 *
 * F1: this previously read a per-session UUID from `sessionStorage`, which is
 * cleared on browser-session end and isolated per tab — destroying persistence
 * and splitting tabs. It now delegates to the stable `localStorage`-backed
 * profile id in `./profile`. Kept as a thin re-export for existing importers
 * (the document-store test) and any external callers.
 */
export function getUserPrefix(): string {
  return getProfilePrefix();
}

const DB_NAMES = getStorageDbNames();
export const DB_NAME = DB_NAMES.documents;
const DB_VERSION = 1;
const STORE_NAME = 'documents';

/**
 * Change announcements for the documents store (#270): successful commits
 * (upsert/delete) notify other tabs so they can reload instead of serving
 * stale in-memory state. Merge/addition-only semantics do not depend on
 * delivery.
 */
const changeChannel = createStoreChannel(`${DB_NAME}-changes`);

function postChange(): void {
  changeChannel.postChange();
}

/** Subscribe to document-store changes made by other tabs/instances. */
export function onDocumentsRemoteChange(callback: () => void): () => void {
  return changeChannel.onRemoteChange(callback);
}

let dbInstance: IDBDatabase | null = null;

/**
 * Open or get the existing database connection.
 * Uses singleton pattern to avoid multiple open connections.
 */
async function openDatabase(): Promise<IDBDatabase> {
  if (dbInstance) {
    return dbInstance;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error(`Failed to open database: ${request.error}`));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('uploadedAt', 'uploadedAt', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
    };
  });
}

/**
 * Load all documents from IndexedDB.
 *
 * @returns Promise resolving to array of DocumentEntry
 */
export async function loadDocuments(): Promise<DocumentEntry[]> {
  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onerror = () => {
        reject(new Error(`Failed to load documents: ${request.error}`));
      };

      request.onsuccess = () => {
        const results = request.result || [];
        // Sort by uploadedAt descending (newest first)
        results.sort((a, b) => b.uploadedAt - a.uploadedAt);
        resolve(results);
      };
    });
  } catch (error) {
    console.error('Error loading documents from IndexedDB:', error);
    return [];
  }
}

/**
 * Save all documents to IndexedDB.
 *
 * #270: this was a whole-table replace (`clear()` + re-add of the caller's
 * list), so a tab holding a stale list deleted every document another tab
 * added since its mount-time load. It is now an ADDITION-ONLY upsert: every
 * provided doc is written (add-or-replace) and rows absent from the list are
 * left untouched. Document deletion belongs to `deleteDocument`, which the
 * page calls explicitly. The whole-list helper therefore never resurrects a
 * deleted row by removing rows, and a stale list can only re-add a row that
 * the caller itself still holds — cross-tab deletion safety is guaranteed by
 * the per-document production path (`upsertDocument`/`deleteDocument`), not
 * by this helper.
 *
 * @param docs - Array of DocumentEntry to upsert
 */
export async function saveDocuments(docs: DocumentEntry[]): Promise<void> {
  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      // #270: upsert only — no clear(). Rows absent from `docs` survive.
      for (const doc of docs) {
        store.put(doc);
      }

      transaction.onerror = () => {
        reject(new Error(`Failed to save documents: ${transaction.error}`));
      };

      transaction.oncomplete = () => {
        resolve();
      };
    });
  } catch (error) {
    console.error('Error saving documents to IndexedDB:', error);
  }
}

/**
 * Add or replace a single document row (#270).
 *
 * The per-document production write path: the page calls this for every
 * new/changed document instead of re-writing its whole in-memory list, so a
 * row another tab added is never overwritten by this tab's stale snapshot.
 * Announces a change to other tabs on success.
 */
export async function upsertDocument(doc: DocumentEntry): Promise<void> {
  try {
    const db = await openDatabase();

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put(doc);

      transaction.onerror = () => {
        reject(new Error(`Failed to upsert document: ${transaction.error}`));
      };

      transaction.oncomplete = () => {
        resolve();
      };
    });
    postChange();
  } catch (error) {
    console.error('Error upserting document to IndexedDB:', error);
    throw error;
  }
}

/**
 * Delete a document from IndexedDB by ID.
 *
 * #270: announces the change to other tabs on success so they reload instead
 * of serving (and later re-saving) a stale list that still contains the
 * deleted row.
 *
 * @param docId - ID of the document to delete
 */
export async function deleteDocument(docId: string): Promise<void> {
  try {
    const db = await openDatabase();

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(docId);

      request.onerror = () => {
        reject(new Error(`Failed to delete document: ${request.error}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
    postChange();
  } catch (error) {
    console.error('Error deleting document from IndexedDB:', error);
    throw error;
  }
}
