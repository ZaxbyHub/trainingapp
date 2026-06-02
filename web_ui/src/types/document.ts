/**
 * Document processing types for the Document Q&A application.
 */

/**
 * Entry representing a document in the document list.
 */
export interface DocumentEntry {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  status: 'uploading' | 'processing' | 'ready' | 'error';
  progress: number;
  chunkCount?: number;
  uploadedAt: number;
  errorMessage?: string;
}

/**
 * Metadata about a processed document.
 */
export interface DocumentMetadata {
  fileName: string;
  pageCount: number;
  fileSize: number;
  extractedAt: number;
}

/**
 * Text extracted from a single page.
 */
export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

/**
 * Complete result of PDF text extraction.
 */
export interface ExtractionResult {
  fullText: string;
  pages: ExtractedPage[];
  metadata: DocumentMetadata;
}

/**
 * Error types for document extraction.
 */
export interface ExtractionError {
  fileName: string;
  error: string;
  stage: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'txt';
}

/**
 * Represents a chunk of text from a document.
 */
export interface DocumentChunk {
  text: string;
  source: string;
  page?: number;
  chunkIndex: number;
  docId?: string;
  sourcePath?: string;
}
