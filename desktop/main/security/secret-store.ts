// Main-process secret store (universal-provider-settings-overhaul, AC7).
//
// Holds the external model API key (and its bound origin) encrypted at rest
// with Electron's safeStorage (Windows DPAPI, macOS Keychain, Linux secret
// service). Electron-free by construction: the caller INJECTS a
// safeStorage-shaped object, so the backend modules stay importable in plain
// Node (vitest, the headless dev-server).
//
// File format (`filePath`, e.g. <profileDir>/secrets.bin):
//   {"v":1,"entries":{"<name>":"<base64 of safeStorage ciphertext>"}}
// Only ciphertext ever reaches disk — never plaintext and never a plaintext
// base64/hex encoding. Writes are atomic (tmp + rename in the same directory).
//
// Contract (frozen by trace check C7):
//   - get/set/delete are synchronous; the file is decrypted once, lazily, on
//     first access (after app ready) and served from memory afterwards;
//   - set() THROWS when encryption is unavailable and writes nothing — the
//     store never falls back to plaintext (the host then keeps the key for
//     the session only);
//   - a missing, corrupt or undecryptable file / entry reads as null.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

/** Structurally Electron's `safeStorage`. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export interface SecretStore {
  get(name: string): string | null;
  /** Throws when the value cannot be stored securely. */
  set(name: string, value: string): void;
  delete(name: string): void;
}

interface SecretFile {
  v: 1;
  entries: Record<string, string>;
}

function readCipherEntries(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const entries = (parsed as { entries?: unknown }).entries;
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value === 'string') out[name] = value;
    }
    return out;
  } catch {
    // Corrupt file: never fatal, reads as empty.
    return {};
  }
}

function writeAtomic(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w', 0o600);
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}

export function createSafeStorageSecretStore(opts: { safeStorage: SafeStorageLike; filePath: string }): SecretStore {
  const { safeStorage, filePath } = opts;
  let cipher: Record<string, string> | null = null;
  const plain = new Map<string, string | null>();

  const ciphers = (): Record<string, string> => {
    if (cipher === null) cipher = readCipherEntries(filePath);
    return cipher;
  };
  const persist = (next: Record<string, string>): void => {
    const file: SecretFile = { v: 1, entries: next };
    writeAtomic(filePath, JSON.stringify(file));
    cipher = next;
  };

  return {
    get(name: string): string | null {
      if (plain.has(name)) return plain.get(name) ?? null;
      const encoded = ciphers()[name];
      if (encoded === undefined) return null;
      let value: string | null = null;
      try {
        value = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      } catch {
        value = null; // undecryptable (other user / corrupted) reads as null
      }
      plain.set(name, value);
      return value;
    },
    set(name: string, value: string): void {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('secure storage is not available on this system; the secret was not saved');
      }
      const encrypted = safeStorage.encryptString(value).toString('base64');
      persist({ ...ciphers(), [name]: encrypted });
      plain.set(name, value);
    },
    delete(name: string): void {
      const current = ciphers();
      plain.delete(name);
      if (!(name in current)) return;
      const next = { ...current };
      delete next[name];
      persist(next);
    },
  };
}

/** Process-memory secret store (headless dev-server, tests): nothing touches disk. */
export function createMemorySecretStore(): SecretStore {
  const data = new Map<string, string>();
  return {
    get: (name) => data.get(name) ?? null,
    set: (name, value) => {
      data.set(name, value);
    },
    delete: (name) => {
      data.delete(name);
    },
  };
}
