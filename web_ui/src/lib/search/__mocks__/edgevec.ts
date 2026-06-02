/**
 * Mock implementation of edgevec for testing.
 */

export const init = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

export interface MockEdgeVec {
  insert: ReturnType<typeof vi.fn<(_vector: Float32Array) => number>>;
  insertBatchWithProgress: ReturnType<typeof vi.fn<(_vectors: Float32Array[], _onProgress?: (done: number, total: number) => void) => Promise<void>>>;
  search: ReturnType<typeof vi.fn<(_query: Float32Array, k: number) => Array<{ id: number; score: number }>>>;
  softDelete: ReturnType<typeof vi.fn<(id: number) => void>>;
  save: ReturnType<typeof vi.fn<(_name: string) => Promise<void>>>;
  load: ReturnType<typeof vi.fn<(_name: string) => Promise<MockEdgeVec | null>>>;
  liveCount: ReturnType<typeof vi.fn<() => number>>;
  canInsert: ReturnType<typeof vi.fn<() => boolean>>;
  ef_search: number;
  free: ReturnType<typeof vi.fn<() => void>>;
}

export function createMockEdgeVec(): MockEdgeVec {
  return {
    insert: vi.fn<(_vector: Float32Array) => number>().mockReturnValue(0),
    insertBatchWithProgress: vi.fn<(_vectors: Float32Array[], _onProgress?: (done: number, total: number) => void) => Promise<void>>().mockResolvedValue(undefined),
    search: vi.fn<(_query: Float32Array, k: number) => Array<{ id: number; score: number }>>().mockReturnValue([]),
    softDelete: vi.fn<(id: number) => void>(),
    save: vi.fn<(_name: string) => Promise<void>>().mockResolvedValue(undefined),
    load: vi.fn<(_name: string) => Promise<MockEdgeVec | null>>().mockResolvedValue(null),
    liveCount: vi.fn<() => number>().mockReturnValue(0),
    canInsert: vi.fn<() => boolean>().mockReturnValue(true),
    ef_search: 50,
    free: vi.fn<() => void>(),
  };
}

// Default mock instance
const defaultInstance = createMockEdgeVec();

// Static load method (used in load())
export const load = vi.fn<(_name: string) => Promise<MockEdgeVec | null>>().mockResolvedValue(null);

const mockEdgeVec = {
  ...defaultInstance,
  load,
};

export default vi.fn<() => MockEdgeVec>().mockReturnValue(mockEdgeVec);
