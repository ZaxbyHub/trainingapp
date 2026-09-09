// Shared types and configuration for the Electron backend host (issue #61).
//
// The selector contract (acceptance spec b3-backend-default.test.ts /
// b3-backend-selector.test.ts): `createBackendHost(config)` returns ONE of two
// implementations behind the SAME `BackendHost` interface, chosen only by
// `backend.mode` (`"node"` default, or `"sidecar"` per ADR-0003 #57 — that
// ADR is still open, so this issue ships both and defaults to node; flipping
// the default when the ADR lands is a one-line change here).
//
// This module must stay electron-free: it is imported by the headless
// dev-server entry that CI and the acceptance checks run under plain node.

export type BackendMode = 'node' | 'sidecar';

/** The ONE interface B4-B9 (#62-#67) import. Never widen per-mode. */
export interface BackendHost {
  readonly mode: BackendMode;
  /** Bind 127.0.0.1 on an OS-assigned random free port (B3 contract, docs/security/desktop.md). */
  start(): Promise<BackendHandle>;
  /** Idempotent; stops listeners and (sidecar mode) the child process. */
  stop(): Promise<void>;
}

/** FROZEN IPC shape (desktop:get-backend): address only — never add token or
 *  secret fields here; credentials travel exclusively via desktopApi.getAuthToken(). */
export interface BackendHandle {
  mode: BackendMode;
  port: number;
  url: string;
}

export interface SidecarLaunchConfig {
  /** Executable to spawn (e.g. a PyInstaller api_server binary, or `python`). */
  command: string;
  args?: string[];
  /** Working directory for the child (documented in docs/security/desktop.md). */
  cwd?: string;
  /** Extra env merged over process.env for the child. */
  env?: Record<string, string>;
  /** Bounded readiness wait for GET /health (ms). PyInstaller onefile
   *  binaries extract themselves on first boot — give that a wide bound. */
  healthTimeoutMs?: number;
}

export interface BackendHostConfig {
  mode?: BackendMode;
  /** Per-launch transport token (from security/token.ts, or a test token). */
  token: string;
  tokenHeaderName?: string;
  allowedOrigins?: string[];
  sidecar?: Partial<SidecarLaunchConfig> & { port?: number };
  /** Env override for mode resolution (tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Node mode only: an explicit engine (B4); defaults to resolveNodeEngine(env). */
  engine?: EngineSurface;
  /** Surfacing seam (sidecar mode): called once when the restart budget is
   *  exhausted. Bootstrap wires it to a fail-loud user-visible notice; B9
   *  owns any richer UX. Requests keep getting contract-safe 502s. */
  onGiveUp?: (attempts: number) => void;
}

/**
 * Reserved profile-identifying header slot (issue #61, evidence note): B6
 * (#64) will populate profile-scoped storage later. The host ACCEPTS this
 * header on every route (never rejects it) and ignores the value until B6
 * gives it meaning, so wiring B6 in cannot change the wire contract.
 */
export const RESERVED_PROFILE_HEADER_NAME = 'X-Profile-Id';

/** Env var that flips the default backend mode (tests, dev, ADR flip). */
export const BACKEND_MODE_ENV = 'TRAININGAPP_DESKTOP_BACKEND_MODE';

/**
 * Default backend mode. ADR-0003 (#57) is OPEN — recorded as assumption A1 in
 * the issue trace: "node" is the default because it is self-contained and
 * CI-testable without a PyInstaller build, and the selector makes an ADR flip
 * mechanical (config default change only).
 */
export const DEFAULT_BACKEND_MODE: BackendMode = 'node';

/** Resolve the backend mode: explicit config beats env beats the default. */
export function resolveBackendMode(opts?: {
  mode?: BackendMode;
  env?: Record<string, string | undefined>;
}): BackendMode {
  if (opts?.mode) return opts.mode;
  const raw = (opts?.env ?? process.env)[BACKEND_MODE_ENV];
  if (raw === 'node' || raw === 'sidecar') return raw;
  return DEFAULT_BACKEND_MODE;
}

// ---- engine surface (what the guarded routes call in node mode) ------------

export interface CancellationFlag {
  isSet(): boolean;
}

export interface EngineQueryOptions {
  nResults?: number;
  history?: unknown[];
  streamCallback?: (token: string) => void;
  cancellationEvent?: CancellationFlag;
}

export interface EngineQueryResult {
  answer: string;
  sources: string[];
  context_length: number;
  inference_time: number;
  cancelled?: boolean;
}

/**
 * Thrown when inference is requested but no usable model is staged/loadable.
 * Lives in the CONTRACT module (not any engine implementation) so the
 * transport maps it to the 503 `detail` without depending on a concrete
 * engine — every EngineSurface implementation raises this same type.
 */
export class ModelNotConfiguredError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = 'ModelNotConfiguredError';
    this.detail = detail;
  }
}

/**
 * The backend surface the routes need. StubEngine implements it with
 * documented stubs; B4-B7 will provide the real implementation.
 */
export interface EngineSurface {
  query(question: string, opts?: EngineQueryOptions): Promise<EngineQueryResult>;
  /**
   * B4 (issue #62): best-effort readiness check that throws BEFORE any
   * response byte is written — ModelNotConfiguredError when no model is
   * staged, so the stream route can still answer the contract's 503.
   * Optional: StubEngine no-ops; callers must tolerate its absence.
   */
  preflight?(): Promise<void>;
  search(query: string, nResults?: number): Promise<Array<{ text: string; source: string; similarity: number }>>;
  listDocuments(): Promise<{ documents: Array<{ id: string; chunk_count: number }>; total: number }>;
  clearDocuments(): Promise<void>;
  getStats(): Promise<{ document_count: number; chunk_count: number; embedding_model: string; llm_backend: string | null; documents: string[] }>;
  applySettingsPatch(patch: Record<string, unknown>): { ok: true } | { ok: false; status: 400 | 422; detail: string; errors?: string[] };
  responseSettings(): Record<string, unknown>;
  ingestDirectory(directory: string): Promise<{ success: boolean; documents: number; chunks_added: number; message: string | null }>;
  ingestFile(): Promise<{ success: boolean; documents: number; chunks_added: number; message: string | null }>;
  ingestBatch(count: number): Promise<{ total_files: number; successful: number; failed: number; results: Array<{ filename: string; success: boolean; chunks_added?: number; error?: string }> }>;
}
