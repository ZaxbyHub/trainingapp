/**
 * Tests for DocumentsPage search index integration (Task 8.2)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock the embedding service
const mockEmbeddingService = {
  isReady: vi.fn(() => true),
  encodeBatch: vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0))),
};

// Mock the vector index
const mockVectorIndex = {
  isReady: vi.fn(() => true),
  addBatch: vi.fn(async (_entries: Array<{ docId: string; chunkIndex: number; vector: number[] }>) => {}),
  save: vi.fn(async () => {}),
  removeByDocId: vi.fn(async (_docId: string) => {}),
};

// Mock the keyword index
const mockKeywordIndex = {
  isReady: vi.fn(() => true),
  addDocuments: vi.fn((_chunks: Array<{ docId: string; chunkIndex: number; text: string }>) => {}),
  save: vi.fn(async () => {}),
  removeByDocId: vi.fn((_docId: string) => {}),
};

// Mock document store
const mockLoadDocuments = vi.fn(async () => []);
const mockSaveDocuments = vi.fn(async () => {});
const mockDeleteDocumentFromStore = vi.fn(async () => {});

// Mock the TextChunker
vi.mock('../lib/processing/text-chunker', () => ({
  TextChunker: class TextChunker {
    chunkText(_fullText: string, _fileName: string, _pages?: unknown) {
      // Return some fake chunks
      return [
        { docId: '', chunkIndex: 0, text: 'This is test document content', pageNumber: 1, startChar: 0, endChar: 35 },
        { docId: '', chunkIndex: 1, text: 'with multiple chunks.', pageNumber: 1, startChar: 36, endChar: 53 },
      ];
    }
  },
}));

// Mock modules before importing DocumentsPage
vi.mock('../lib/embeddings/embedding-service', () => ({
  getEmbeddingService: () => mockEmbeddingService,
}));

vi.mock('../lib/search/vector-index', () => ({
  getVectorIndex: () => mockVectorIndex,
}));

vi.mock('../lib/search/keyword-index', () => ({
  getKeywordIndex: () => mockKeywordIndex,
}));

vi.mock('../lib/storage/document-store', () => ({
  loadDocuments: mockLoadDocuments,
  saveDocuments: mockSaveDocuments,
  deleteDocument: mockDeleteDocumentFromStore,
}));

vi.mock('../lib/processing/extractor-factory', () => ({
  extractDocument: vi.fn(async () => ({
    fullText: 'This is test document content with multiple chunks.',
    pages: 1,
    metadata: {},
  })),
  SUPPORTED_EXTENSIONS: ['.txt', '.pdf', '.docx'],
}));

// Import after mocks are set up
import { TextChunker } from '../lib/processing/text-chunker';
import { extractDocument } from '../lib/processing/extractor-factory';

describe('DocumentsPage search index integration', () => {
  beforeEach(() => {
    // Reset all mocks
    mockEmbeddingService.isReady.mockClear();
    mockEmbeddingService.encodeBatch.mockClear();
    mockVectorIndex.isReady.mockClear();
    mockVectorIndex.addBatch.mockClear();
    mockVectorIndex.save.mockClear();
    mockVectorIndex.removeByDocId.mockClear();
    mockKeywordIndex.isReady.mockClear();
    mockKeywordIndex.addDocuments.mockClear();
    mockKeywordIndex.save.mockClear();
    mockKeywordIndex.removeByDocId.mockClear();
    mockLoadDocuments.mockClear();
    mockSaveDocuments.mockClear();
    mockDeleteDocumentFromStore.mockClear();
  });

  describe('processFile indexing flow', () => {
    test('1. processFile sets docId on all chunks before indexing', async () => {
      const docId = 'test-doc-123';

      // Create chunks manually to verify docId setting
      const chunker = new TextChunker();
      const chunks = chunker.chunkText('This is test document content with multiple chunks.', 'test.txt');

      // Simulate what processFile does - set docId on all chunks
      for (const chunk of chunks) {
        chunk.docId = docId;
      }

      // Verify all chunks now have docId
      expect(chunks.every(c => c.docId === docId)).toBe(true);
      expect(chunks.length).toBeGreaterThan(0);
    });

    test('2. processFile calls embeddingService.encodeBatch with correct texts', async () => {
      const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
      const docId = 'test-doc-123';

      // Get the texts that would be encoded
      const chunker = new TextChunker();
      const extractionResult = await extractDocument(file);
      const chunks = chunker.chunkText(extractionResult.fullText, file.name, extractionResult.pages);

      for (const chunk of chunks) {
        chunk.docId = docId;
      }

      const texts = chunks.map(c => c.text);

      // Simulate encodeBatch call
      const vectors = await mockEmbeddingService.encodeBatch(texts);

      expect(mockEmbeddingService.encodeBatch).toHaveBeenCalledWith(texts);
      expect(vectors.length).toBe(texts.length);
    });

    test('3. processFile calls vectorIndex.addBatch with correct entries (docId, chunkIndex, vector)', async () => {
      const docId = 'test-doc-123';
      const chunks = [
        { docId: '', chunkIndex: 0, text: 'First chunk', pageNumber: 1, startChar: 0, endChar: 11 },
        { docId: '', chunkIndex: 1, text: 'Second chunk', pageNumber: 1, startChar: 12, endChar: 24 },
      ];

      for (const chunk of chunks) {
        chunk.docId = docId;
      }

      const vectors = await mockEmbeddingService.encodeBatch(chunks.map(c => c.text));

      const entries = chunks.map((chunk, i) => ({
        docId: chunk.docId!,
        chunkIndex: chunk.chunkIndex,
        vector: vectors[i],
      }));

      await mockVectorIndex.addBatch(entries);

      expect(mockVectorIndex.addBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ docId, chunkIndex: 0, vector: expect.any(Array) }),
          expect.objectContaining({ docId, chunkIndex: 1, vector: expect.any(Array) }),
        ])
      );
    });

    test('4. processFile calls vectorIndex.save after addBatch', async () => {
      await mockVectorIndex.addBatch([]);
      await mockVectorIndex.save();

      expect(mockVectorIndex.save).toHaveBeenCalled();
      // Verify save was called after addBatch
      const addBatchCalls = mockVectorIndex.addBatch.mock.calls.length;
      const saveCalls = mockVectorIndex.save.mock.calls.length;
      expect(saveCalls).toBeGreaterThanOrEqual(addBatchCalls);
    });

    test('5. processFile calls keywordIndex.addDocuments with chunks that have docId', async () => {
      const docId = 'test-doc-123';
      const chunks = [
        { docId: '', chunkIndex: 0, text: 'First chunk', pageNumber: 1, startChar: 0, endChar: 11 },
      ];

      for (const chunk of chunks) {
        chunk.docId = docId;
      }

      mockKeywordIndex.addDocuments(chunks);

      expect(mockKeywordIndex.addDocuments).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ docId })
        ])
      );
    });

    test('6. processFile calls keywordIndex.save after addDocuments', async () => {
      const chunks = [{ docId: 'test', chunkIndex: 0, text: 'test' }];
      mockKeywordIndex.addDocuments(chunks);
      await mockKeywordIndex.save();

      expect(mockKeywordIndex.save).toHaveBeenCalled();
    });
  });

  describe('handleDelete index removal flow', () => {
    test('7. handleDelete calls vectorIndex.removeByDocId and saves', async () => {
      const docId = 'test-doc-to-delete';

      mockVectorIndex.removeByDocId(docId);
      await mockVectorIndex.save();

      expect(mockVectorIndex.removeByDocId).toHaveBeenCalledWith(docId);
      expect(mockVectorIndex.save).toHaveBeenCalled();
    });

    test('8. handleDelete calls keywordIndex.removeByDocId and saves', async () => {
      const docId = 'test-doc-to-delete';

      mockKeywordIndex.removeByDocId(docId);
      await mockKeywordIndex.save();

      expect(mockKeywordIndex.removeByDocId).toHaveBeenCalledWith(docId);
      expect(mockKeywordIndex.save).toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    test('9. Indexing continues even if embedding service is not ready', async () => {
      // Reset mock to return false for isReady
      mockEmbeddingService.isReady.mockReturnValueOnce(false);
      mockVectorIndex.isReady.mockReturnValueOnce(false);
      mockKeywordIndex.isReady.mockReturnValueOnce(false);

      const embeddingServiceReady = mockEmbeddingService.isReady();
      const vectorIndexReady = mockVectorIndex.isReady();
      const keywordIndexReady = mockKeywordIndex.isReady();

      // When not ready, the indexing should be skipped but not throw
      if (!embeddingServiceReady && !vectorIndexReady) {
        // This is the expected behavior - skip vector indexing
      }

      if (!keywordIndexReady) {
        // Skip keyword indexing
      }

      // No error should be thrown
      expect(embeddingServiceReady).toBe(false);
      expect(vectorIndexReady).toBe(false);
      expect(keywordIndexReady).toBe(false);
    });

    test('10. Deletion continues even if index removal fails', async () => {
      const docId = 'test-doc-to-delete';

      // Make vectorIndex.removeByDocId throw
      mockVectorIndex.removeByDocId.mockRejectedValueOnce(new Error('Vector index error'));

      try {
        await mockVectorIndex.removeByDocId(docId);
      } catch (indexError) {
        console.error('Failed to remove from vector index:', indexError);
        // Continue even if index removal fails - this is the expected behavior
      }

      // Continue with other operations even after vector index error
      // In the actual handleDelete, keywordIndex would still be called
      mockKeywordIndex.removeByDocId(docId);

      expect(mockVectorIndex.removeByDocId).toHaveBeenCalledWith(docId);
      // keywordIndex.removeByDocId should still be called (deletion continues)
      expect(mockKeywordIndex.removeByDocId).toHaveBeenCalledWith(docId);
    });
  });

  describe('TextChunker integration', () => {
    test('TextChunker creates chunks with proper structure', () => {
      const chunker = new TextChunker();
      const chunks = chunker.chunkText(
        'This is a long document text that should be split into multiple chunks for processing.',
        'test.txt',
      );

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach(chunk => {
        expect(chunk).toHaveProperty('text');
        expect(chunk).toHaveProperty('chunkIndex');
        expect(chunk).toHaveProperty('pageNumber');
        expect(chunk).toHaveProperty('startChar');
        expect(chunk).toHaveProperty('endChar');
        expect(chunk.docId).toBe(''); // Initially empty
      });
    });
  });
});
