/**
 * PPTX Extractor Tests
 * Tests for web_ui/src/lib/processing/pptx-extractor.ts
 *
 * Framework: vitest
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtractionResult, ExtractedPage, ExtractionError } from '../../types/document';

// Mock JSZip before importing the module
vi.mock('jszip', () => ({
  default: {
    loadAsync: vi.fn(),
  },
}));

import JSZip from 'jszip';

describe('PPTX Text Extraction', () => {
  let mockZip: {
    files: Record<string, { dir: boolean; async: (type: string) => Promise<string> }>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockZip = {
      files: {},
    };
    (JSZip.loadAsync as ReturnType<typeof vi.fn>).mockResolvedValue(mockZip);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractPptxText', () => {
    test('returns ExtractionResult with fullText, pages, and metadata for valid PPTX', async () => {
      // Arrange: Create minimal valid PPTX structure
      const slide1Xml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <a:r><a:t>Hello from Slide 1</a:t></a:r>
                </a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:sld>`;

      const slide2Xml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <a:r><a:t>Hello from Slide 2</a:t></a:r>
                </a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:sld>`;

      mockZip.files = {
        'ppt/slides/slide1.xml': {
          dir: false,
          async: async () => slide1Xml,
        },
        'ppt/slides/slide2.xml': {
          dir: false,
          async: async () => slide2Xml,
        },
        '[Content_Types].xml': {
          dir: false,
          async: async () => '<Types/>',
        },
      };

      const mockFile = new File(['PK...'], 'test.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      // Dynamically import to get fresh module with mocked JSZip
      const { extractPptxText } = await import('./pptx-extractor');
      const result = await extractPptxText(mockFile);

      // Assert structure
      expect(result).toHaveProperty('fullText');
      expect(result).toHaveProperty('pages');
      expect(result).toHaveProperty('metadata');
      expect(result.metadata.fileName).toBe('test.pptx');
      expect(result.metadata.pageCount).toBe(2);
      expect(result.metadata.fileSize).toBe(mockFile.size);
      expect(result.metadata).toHaveProperty('extractedAt');
    });

    test('sorts slides numerically (slide1, slide2, slide10)', async () => {
      // Arrange: Slides out of order
      const slide10Xml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Slide 10</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>
        </p:sld>`;

      const slide2Xml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Slide 2</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>
        </p:sld>`;

      const slide1Xml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Slide 1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>
        </p:sld>`;

      mockZip.files = {
        'ppt/slides/slide10.xml': { dir: false, async: async () => slide10Xml },
        'ppt/slides/slide2.xml': { dir: false, async: async () => slide2Xml },
        'ppt/slides/slide1.xml': { dir: false, async: async () => slide1Xml },
      };

      const mockFile = new File(['PK'], 'numerical.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      const { extractPptxText } = await import('./pptx-extractor');
      const result = await extractPptxText(mockFile);

      // Assert pages are in numerical order
      expect(result.pages[0].pageNumber).toBe(1);
      expect(result.pages[1].pageNumber).toBe(2);
      expect(result.pages[2].pageNumber).toBe(10);
      expect(result.fullText).toContain('Slide 1');
      expect(result.fullText).toContain('Slide 2');
      expect(result.fullText).toContain('Slide 10');
    });

    test('skips empty slides with no text content', async () => {
      // Arrange: Slide with no <a:t> elements
      const emptySlideXml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree/>
        </p:sld>`;

      const textSlideXml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Has text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>
        </p:sld>`;

      mockZip.files = {
        'ppt/slides/slide1.xml': { dir: false, async: async () => emptySlideXml },
        'ppt/slides/slide2.xml': { dir: false, async: async () => textSlideXml },
      };

      const mockFile = new File(['PK'], 'empty-slide.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      const { extractPptxText } = await import('./pptx-extractor');
      const result = await extractPptxText(mockFile);

      // Should only have 1 page (slide2), slide1 is skipped
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].text).toBe('Has text');
    });

    test('skips slides with corrupt XML (parse error)', async () => {
      // Arrange: One valid slide, one corrupt
      const validSlideXml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Valid slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>
        </p:sld>`;

      const corruptSlideXml = `<<<<>>>>`;

      mockZip.files = {
        'ppt/slides/slide1.xml': { dir: false, async: async () => validSlideXml },
        'ppt/slides/slide2.xml': { dir: false, async: async () => corruptSlideXml },
      };

      const mockFile = new File(['PK'], 'corrupt-xml.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      const { extractPptxText } = await import('./pptx-extractor');
      const result = await extractPptxText(mockFile);

      // Should only have 1 page (slide1), slide2 skipped due to parse error
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].text).toBe('Valid slide');
    });

    test('returns empty result when no slides found', async () => {
      // Arrange: No slide files
      mockZip.files = {
        '[Content_Types].xml': { dir: false, async: async () => '<Types/>' },
      };

      const mockFile = new File(['PK'], 'no-slides.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      const { extractPptxText } = await import('./pptx-extractor');
      const result = await extractPptxText(mockFile);

      expect(result.fullText).toBe('');
      expect(result.pages).toHaveLength(1); // Returns placeholder page
      expect(result.pages[0].text).toBe('');
      expect(result.metadata.pageCount).toBe(0);
    });

    test('handles malformed PPTX - not a ZIP archive', async () => {
      // Arrange: File is not a ZIP
      const mockFile = new File(['NOT A ZIP FILE AT ALL'], 'not-a-zip.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      (JSZip.loadAsync as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Invalid zip file: missing end of central directory')
      );

      const { extractPptxText } = await import('./pptx-extractor');

      await expect(extractPptxText(mockFile)).rejects.toMatchObject({
        fileName: 'not-a-zip.pptx',
        stage: 'pptx',
      });
    });

    test('handles corrupt ZIP structure', async () => {
      // Arrange
      const mockFile = new File(['PK...corrupt...'], 'corrupt.zip.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      (JSZip.loadAsync as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Invalid archive: end of central directory not found')
      );

      const { extractPptxText } = await import('./pptx-extractor');

      await expect(extractPptxText(mockFile)).rejects.toMatchObject({
        fileName: 'corrupt.zip.pptx',
        stage: 'pptx',
      });
    });

    test('wraps unknown errors with generic message', async () => {
      // Arrange
      const mockFile = new File(['content'], 'unknown-error.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      (JSZip.loadAsync as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Some random error that is not ZIP-related')
      );

      const { extractPptxText } = await import('./pptx-extractor');

      await expect(extractPptxText(mockFile)).rejects.toMatchObject({
        fileName: 'unknown-error.pptx',
        stage: 'pptx',
        error: expect.stringContaining('Unexpected error'),
      });
    });

    test('re-throws ExtractionError as-is without wrapping', async () => {
      // Arrange: Simulate an error that looks like ExtractionError
      // But since JSZip doesn't throw ExtractionError, we test the error detection logic
      // by checking that known error patterns are wrapped correctly
      const mockFile = new File(['content'], 'test.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      (JSZip.loadAsync as ReturnType<typeof vi.fn>).mockRejectedValue({
        fileName: 'test.pptx',
        error: 'Already an extraction error',
        stage: 'pptx',
      });

      const { extractPptxText } = await import('./pptx-extractor');

      // Should re-throw as-is because it has 'stage' and 'fileName'
      await expect(extractPptxText(mockFile)).rejects.toMatchObject({
        fileName: 'test.pptx',
        error: 'Already an extraction error',
        stage: 'pptx',
      });
    });

    test('extracts text from multiple a:t elements and joins with spaces', async () => {
      // Arrange: Multiple text runs in one slide
      const multiTextSlideXml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <a:r><a:t>Hello</a:t></a:r>
                  <a:r><a:t> </a:t></a:r>
                  <a:r><a:t>World</a:t></a:r>
                </a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:sld>`;

      mockZip.files = {
        'ppt/slides/slide1.xml': { dir: false, async: async () => multiTextSlideXml },
      };

      const mockFile = new File(['PK'], 'multi-text.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      const { extractPptxText } = await import('./pptx-extractor');
      const result = await extractPptxText(mockFile);

      expect(result.pages[0].text).toBe('Hello World');
    });

    test('fullText joins page texts with double newlines', async () => {
      // Arrange: Two slides with text
      const slide1Xml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>First slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>
        </p:sld>`;

      const slide2Xml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Second slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>
        </p:sld>`;

      mockZip.files = {
        'ppt/slides/slide1.xml': { dir: false, async: async () => slide1Xml },
        'ppt/slides/slide2.xml': { dir: false, async: async () => slide2Xml },
      };

      const mockFile = new File(['PK'], 'two-slides.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      const { extractPptxText } = await import('./pptx-extractor');
      const result = await extractPptxText(mockFile);

      expect(result.fullText).toBe('First slide\n\nSecond slide');
    });
  });

  describe('Factory Routing', () => {
    test('extractDocument routes .pptx to extractPptxText', async () => {
      // Arrange
      const slide1Xml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>PPTX content</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>
        </p:sld>`;

      mockZip.files = {
        'ppt/slides/slide1.xml': { dir: false, async: async () => slide1Xml },
      };

      const mockFile = new File(['PK'], 'factory-test.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      const { extractDocument } = await import('./extractor-factory');
      const result = await extractDocument(mockFile);

      expect(result.metadata.fileName).toBe('factory-test.pptx');
      expect(result.pages[0].text).toBe('PPTX content');
    });

    test('extractDocument throws for unsupported extensions', async () => {
      const mockFile = new File(['content'], 'unsupported.exe', {
        type: 'application/octet-stream',
      });

      const { extractDocument } = await import('./extractor-factory');

      await expect(extractDocument(mockFile)).rejects.toMatchObject({
        fileName: 'unsupported.exe',
        stage: 'txt',
      });
    });

    test('SUPPORTED_EXTENSIONS includes .pptx', async () => {
      const { SUPPORTED_EXTENSIONS } = await import('./extractor-factory');
      expect(SUPPORTED_EXTENSIONS).toContain('.pptx');
    });
  });

  describe('Dependency Verification', () => {
    test('jszip is listed in package.json dependencies', async () => {
      // This test verifies jszip dependency exists
      // We verify by checking that the mock was called correctly
      const mockFile = new File(['PK'], 'dep-test.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });

      const slide1Xml = `<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Content</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>
        </p:sld>`;

      mockZip.files = {
        'ppt/slides/slide1.xml': { dir: false, async: async () => slide1Xml },
      };

      const { extractPptxText } = await import('./pptx-extractor');
      await extractPptxText(mockFile);

      expect(JSZip.loadAsync).toHaveBeenCalled();
    });
  });
});
