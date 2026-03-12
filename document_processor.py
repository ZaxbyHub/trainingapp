"""
Document Processor Module
Handles extraction and chunking of PDF, DOCX, and PPTX files.
"""

import os
import re
from typing import List, Tuple, Optional
from dataclasses import dataclass
from pathlib import Path


@dataclass
class DocumentChunk:
    """Represents a chunk of text from a document."""
    text: str
    source: str
    page: Optional[int] = None
    chunk_index: int = 0


class DocumentProcessor:
    """Processes various document formats and extracts text."""
    
    SUPPORTED_EXTENSIONS = {'.pdf', '.docx', '.doc', '.pptx', '.ppt', '.txt', '.md'}
    
    def __init__(self, chunk_size: int = 256, chunk_overlap: int = 50):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
    
    def extract_pdf(self, filepath: str) -> Tuple[str, List[Tuple[int, str]]]:
        """Extract text from PDF with page information."""
        try:
            import pdfplumber
            pages_text = []
            full_text = []
            
            with pdfplumber.open(filepath) as pdf:
                for i, page in enumerate(pdf.pages, 1):
                    text = page.extract_text() or ""
                    if text.strip():
                        pages_text.append((i, text))
                        full_text.append(text)
            
            return "\n\n".join(full_text), pages_text
        except ImportError:
            from pypdf import PdfReader
            reader = PdfReader(filepath)
            pages_text = []
            full_text = []
            
            for i, page in enumerate(reader.pages, 1):
                text = page.extract_text() or ""
                if text.strip():
                    pages_text.append((i, text))
                    full_text.append(text)
            
            return "\n\n".join(full_text), pages_text
    
    def extract_docx(self, filepath: str) -> str:
        """Extract text from DOCX file."""
        from docx import Document
        doc = Document(filepath)
        paragraphs = []
        
        for para in doc.paragraphs:
            if para.text.strip():
                paragraphs.append(para.text)
        
        for table in doc.tables:
            for row in table.rows:
                row_text = []
                for cell in row.cells:
                    if cell.text.strip():
                        row_text.append(cell.text.strip())
                if row_text:
                    paragraphs.append(" | ".join(row_text))
        
        return "\n\n".join(paragraphs)
    
    def extract_pptx(self, filepath: str) -> str:
        """Extract text from PPTX file."""
        from pptx import Presentation
        prs = Presentation(filepath)
        slides_text = []
        
        for slide_num, slide in enumerate(prs.slides, 1):
            slide_content = [f"[Slide {slide_num}]"]
            
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text.strip():
                    slide_content.append(shape.text)
                
                if shape.has_table:
                    table = shape.table
                    for row in table.rows:
                        row_text = []
                        for cell in row.cells:
                            if cell.text.strip():
                                row_text.append(cell.text.strip())
                        if row_text:
                            slide_content.append(" | ".join(row_text))
            
            if len(slide_content) > 1:
                slides_text.append("\n".join(slide_content))
        
        return "\n\n".join(slides_text)
    
    def extract_text_file(self, filepath: str) -> str:
        """Extract text from plain text or markdown files."""
        encodings = ['utf-8', 'utf-16', 'latin-1', 'cp1252']
        
        for encoding in encodings:
            try:
                with open(filepath, 'r', encoding=encoding) as f:
                    return f.read()
            except (UnicodeDecodeError, UnicodeError):
                continue
        
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    
    def extract_document(self, filepath: str) -> str:
        """Extract text from any supported document type."""
        filepath = str(filepath)
        ext = Path(filepath).suffix.lower()
        
        if ext == '.pdf':
            text, _ = self.extract_pdf(filepath)
            return text
        elif ext in {'.docx', '.doc'}:
            return self.extract_docx(filepath)
        elif ext in {'.pptx', '.ppt'}:
            return self.extract_pptx(filepath)
        elif ext in {'.txt', '.md'}:
            return self.extract_text_file(filepath)
        else:
            raise ValueError(f"Unsupported file format: {ext}")

    def clean_text(self, text: str) -> str:
        """Clean and normalize text."""
        text = re.sub(r'\s+', ' ', text)
        text = re.sub(r'\n\s*\n', '\n\n', text)
        text = text.strip()
        return text

    def chunk_text(self, text: str, source: str) -> List[DocumentChunk]:
        """Split text into overlapping chunks respecting paragraph and sentence boundaries."""
        text = self.clean_text(text)
        paragraphs = [p.strip() for p in text.split('\n\n') if p.strip()]
        
        chunks = []
        chunk_index = 0
        current_chunk_sentences = []
        current_chunk_word_count = 0
        
        for paragraph in paragraphs:
            sentences = re.split(r'(?<=[.!?])\s+', paragraph)
            
            for sentence in sentences:
                sentence = sentence.strip()
                if not sentence:
                    continue
                    
                sentence_word_count = len(sentence.split())
                
                # If sentence alone exceeds chunk_size and we're starting fresh
                if sentence_word_count > self.chunk_size and not current_chunk_sentences:
                    # Split sentence into word chunks
                    words = sentence.split()
                    while words:
                        chunk_words = words[:self.chunk_size]
                        chunk_text = ' '.join(chunk_words)
                        chunks.append(DocumentChunk(text=chunk_text, source=source, chunk_index=chunk_index))
                        chunk_index += 1
                        words = words[self.chunk_size:]
                        if words:
                            # Overlap handling for split sentence
                            overlap_words = chunk_words[-self.chunk_overlap//2:] if self.chunk_overlap > 0 else []
                            words = overlap_words + words
                    continue  # Move to next sentence
                
                # If adding this sentence would exceed chunk_size, finalize current chunk
                if current_chunk_sentences and (current_chunk_word_count + sentence_word_count > self.chunk_size):
                    chunk_text = ' '.join(current_chunk_sentences)
                    chunks.append(DocumentChunk(text=chunk_text, source=source, chunk_index=chunk_index))
                    chunk_index += 1
                    
                    # Handle overlap: keep last N sentences for next chunk
                    overlap_sentences = []
                    overlap_word_count = 0
                    for s in reversed(current_chunk_sentences):
                        s_word_count = len(s.split())
                        if overlap_word_count + s_word_count <= self.chunk_overlap:
                            overlap_sentences.insert(0, s)
                            overlap_word_count += s_word_count
                        else:
                            break
                    current_chunk_sentences = overlap_sentences
                    current_chunk_word_count = overlap_word_count
                
                current_chunk_sentences.append(sentence)
                current_chunk_word_count += sentence_word_count
        
        # Don't forget the last chunk
        if current_chunk_sentences:
            chunk_text = ' '.join(current_chunk_sentences)
            chunks.append(DocumentChunk(text=chunk_text, source=source, chunk_index=chunk_index))
        
        return chunks
    
    def process_file(self, filepath: str, source_name: Optional[str] = None) -> List[DocumentChunk]:
        """Process a single file and return chunks."""
        filepath = str(filepath)
        # Use provided source_name or fall back to filename from path
        filename = source_name if source_name else Path(filepath).name

        try:
            text = self.extract_document(filepath)
            if not text.strip():
                print(f"[WARN] Empty content: {filename}")
                return []

            chunks = self.chunk_text(text, filename)
            print(f"[OK] Processed: {filename} ({len(chunks)} chunks)")
            return chunks
        except Exception as e:
            print(f"[FAIL] Failed: {filename} - {e}")
            return []
    
    def process_directory(self, directory: str) -> List[DocumentChunk]:
        """Process all supported documents in a directory recursively."""
        all_chunks = []
        directory = Path(directory)
        
        for root, _, files in os.walk(directory):
            for file in files:
                filepath = Path(root) / file
                ext = filepath.suffix.lower()
                
                if ext in self.SUPPORTED_EXTENSIONS:
                    chunks = self.process_file(str(filepath))
                    all_chunks.extend(chunks)
        
        print(f"\n📊 Total: {len(all_chunks)} chunks from {directory}")
        return all_chunks


if __name__ == "__main__":
    processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
    
    import sys
    if len(sys.argv) > 1:
        path = sys.argv[1]
        if os.path.isdir(path):
            chunks = processor.process_directory(path)
        else:
            chunks = processor.process_file(path)
        
        print(f"\nExtracted {len(chunks)} chunks")
        if chunks:
            print(f"\nFirst chunk preview:\n{chunks[0].text[:200]}...")
