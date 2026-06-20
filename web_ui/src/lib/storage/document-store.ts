/**
 * IndexedDB persistence layer for documents.
 * Provides offline-first storage using raw IndexedDB API.
 */

import type { DocumentEntry } from '../../types/document';

/**
 * Generate a stable, user-scoped prefix for IndexedDB names.
 * Uses sessionStorage UUID if available, else falls back to origin-derived
 * hash. Result is stable across page reloads in the same browser session.
 */
export function getUserPrefix(): string {
  const KEY = 'doc-qa-user-id';
  if (typeof sessionStorage !== 'undefined') {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try { sessionStorage.setItem(KEY, id); } catch { /* private mode */ }
    }
    return id.slice(0, 8); // short prefix
  }
  return 'anon';
}

const USER_PREFIX = getUserPrefix();
export const DB_NAME = `${USER_PREFIX}-doc-qa-documents`;
const DB_VERSION = 1;
const STORE_NAME = 'documents';

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
 * Replaces all existing documents with the provided array.
 *
 * @param docs - Array of DocumentEntry to save
 */
export async function saveDocuments(docs: DocumentEntry[]): Promise<void> {
  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      // Clear existing documents
      store.clear();

      // Add all documents
      for (const doc of docs) {
        store.add(doc);
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
 * Delete a document from IndexedDB by ID.
 *
 * @param docId - ID of the document to delete
 */
export async function deleteDocument(docId: string): Promise<void> {
  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
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
  } catch (error) {
    console.error('Error deleting document from IndexedDB:', error);
  }
}
