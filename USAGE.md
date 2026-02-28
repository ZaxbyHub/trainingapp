# User Guide

Complete user guide for the Document Q&A Assistant, covering GUI usage, CLI commands, and API integration.

## Table of Contents

1. [Quick Start](#quick-start)
2. [GUI User Guide](#gui-user-guide)
3. [CLI User Guide](#cli-user-guide)
4. [API User Guide](#api-user-guide)
5. [Best Practices](#best-practices)
6. [Advanced Usage](#advanced-usage)
7. [Common Workflows](#common-workflows)

## Quick Start

### Installation

```powershell
# Install dependencies
pip install -r requirements.txt

# Download GGUF model
# Save qwen2.5-1.5b-instruct-q4_k_m.gguf to a known location

# Run application
python main.py
```

### First Usage

1. **Launch the application**
   - Double-click `main.py` or run `python main.py`

2. **Configure LLM backend**
   - Click "⚙ Settings" button
   - Select GGUF model path
   - Save and restart

3. **Ingest documents**
   - Click "📁 Ingest" button
   - Select document folder
   - Wait for processing

4. **Ask questions**
   - Type your question in the input field
   - Press Enter or click "Ask"
   - View answer with sources

## GUI User Guide

### Main Window

```
┌─────────────────────────────────────────────────────────────┐
│ Document Q&A Assistant                    [⚙ Settings] [📁 Ingest] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Status: Initializing...                                     │
│  Model: qwen2.5-1.5b-instruct-q4_k_m.gguf (1.5GB)           │
│  Documents: 5                                               │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                     │   │
│  │  [Chat Area - Questions and Answers]               │   │
│  │                                                     │   │
│  │  You: What are the main findings?                  │   │
│  │  Assistant: Based on the documents, the main       │   │
│  │  findings indicate that...                         │   │
│  │  Sources: report1.pdf, report2.pdf                 │   │
│  │                                                     │   │
│  │  You: Can you elaborate on that?                   │   │
│  │  Assistant: Certainly! The report states...        │   │
│  │  Sources: report1.pdf, report2.pdf                 │   │
│  │                                                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Ask a question about your documents...              │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  [Ask]  [Clear]                                              │
└─────────────────────────────────────────────────────────────┘
```

### Settings Dialog

**LLM Settings Section**:

1. **GGUF Model Path**
   - Manual entry with file browser
   - Must end with `.gguf`
   - Example: `C:\Models\qwen2.5-1.5b-instruct-q4_k_m.gguf`

2. **Ollama Settings**
   - URL: `http://localhost:11434` (default)
   - Model: `phi3:mini` (default)

3. **API Settings**
   - URL: Your OpenAI-compatible API endpoint
   - Model: API model name

**RAG Settings Section**:

1. **Chunk Size**
   - Default: `512` words
   - Range: `128-1024`
   - Smaller = more precise, larger = faster

2. **Results to Retrieve**
   - Default: `3` chunks
   - Range: `1-10`
   - Combined with window expansion

3. **Max Tokens**
   - Default: `512` tokens
   - Range: `256-1024`

4. **Temperature**
   - Default: `0.3`
   - Range: `0.0-1.0`
   - Lower = more factual, Higher = more creative

**Advanced Settings Section**:

1. **Hybrid Search Toggle**
   - Default: **ON** (recommended)
   - Combines BM25 and vector search
   - Improves accuracy

2. **Window Expansion**
   - Default: `1` chunk
   - Fetches adjacent chunks around retrieved results
   - Range: `0-3`

3. **Cross-Encoder Reranking**
   - Default: **OFF**
   - Re-ranks chunks for better accuracy
   - Slower but more precise

### Ingestion Process

**Step-by-Step**:

1. Click "📁 Ingest" button
2. Select document folder
3. Application scans directory
4. Extracts text from supported files
5. Creates semantic chunks
6. Generates embeddings
7. Builds BM25 index
8. Displays completion message

**Status Updates**:
```
Scanning directory...
Processing: report1.pdf (3 chunks)
Processing: report2.pdf (5 chunks)
Processing: slides.pptx (12 chunks)
Embedding 20 chunks...
Building BM25 index...
[OK] Ingested 3 documents (20 new chunks) in 5.2s
```

### Asking Questions

**Simple Questions**:
```
You: What is the company's annual revenue?
Assistant: According to the annual report, the company's revenue was $10M.
Sources: annual_report_2024.pdf
```

**Multi-Part Questions**:
```
You: What are the benefits and challenges of the new initiative?
Assistant: The new initiative offers several benefits, including improved efficiency and cost savings. However, there are challenges such as implementation time and resource requirements.
Sources: project_plan.pdf, requirements.docx
```

**Specific Questions**:
```
You: What is the warranty period for the product?
Assistant: The product comes with a 2-year warranty covering manufacturing defects.
Sources: product_manual.pdf
```

### Query Tips

**Good Questions**:
- Specific and focused
- Include key terms
- Reference document types

**Examples**:
```
✓ What are the main conclusions of the Q3 report?
✓ How many users signed up last month?
✓ What are the security requirements?
✓ Explain the API limitations in section 3.2
```

**Avoid**:
- Vague or general
- Too broad
- Ambiguous phrasing

**Examples**:
```
✗ What do you think about the report? (too vague)
✗ Everything about the project (too broad)
✗ The thing (too ambiguous)
```

### Customization

**Performance Mode** (faster queries):
- Chunk size: 128
- Results: 2
- Max tokens: 256
- Hybrid search: OFF
- Window: 0

**Quality Mode** (better answers):
- Chunk size: 512
- Results: 5
- Max tokens: 1024
- Hybrid search: ON
- Window: 2
- Reranking: ON

**Balanced Mode** (recommended):
- Chunk size: 256
- Results: 3
- Max tokens: 512
- Hybrid search: ON
- Window: 1
- Reranking: OFF

## CLI User Guide

### Installation

```powershell
# Install Python dependencies
pip install -r requirements.txt

# Download GGUF model manually
```

### Basic Commands

#### Ingest Documents

**Single File**:
```powershell
python main.py --ingest "C:\Documents\report.pdf"
```

**Directory**:
```powershell
python main.py --ingest "C:\Documents\reports"
```

**Recursive** (subdirectories):
```powershell
python main.py --ingest "C:\Documents\all_reports"
```

#### Ask Questions

**Single Question**:
```powershell
python main.py --query "What are the main findings?"
```

**Interactive Mode**:
```powershell
python main.py --cli
```

**Interactive Session**:
```
> What are the main findings?
  The main findings indicate improved efficiency and reduced costs.

> Can you elaborate?
  The report shows a 15% increase in efficiency and a 20% reduction in operational costs.

> What about risks?
  The primary risks identified are implementation challenges and potential integration issues.

> quit
```

#### API Server

**Start Server**:
```powershell
python main.py --api --port 8080
```

**Default Settings**:
- Port: `8080`
- Auto-load settings
- Run in background

**Test Server**:
```powershell
curl http://localhost:8080/
# Returns: {"status": "ok"}
```

### Configuration Options

#### LLM Backend

**Use GGUF**:
```powershell
python main.py --gguf-path "C:\Models\qwen2.5-1.5b-instruct-q4_k_m.gguf"
```

**Use OpenVINO**:
```powershell
python main.py --model-path "C:\AImodels\phi3.5-mini-instruct-int4-cw-ov"
```

**Use Ollama**:
```powershell
python main.py --ollama-model "phi3:mini" --ollama-url "http://localhost:11434"
```

**Use API**:
```powershell
python main.py --api-url "https://api.openai.com/v1" --api-key "sk-..." --api-model "gpt-4"
```

#### RAG Parameters

**Adjust Chunk Size**:
```powershell
python main.py --chunk-size 256 --ingest "C:\Documents"
```

**Adjust Results**:
```powershell
python main.py --n-results 5 --query "What are the findings?"
```

**Adjust Temperature**:
```powershell
python main.py --temperature 0.2 --query "Explain the results"
```

**Enable Hybrid Search**:
```powershell
python main.py --hybrid-search --ingest "C:\Documents"
```

**Enable Window Expansion**:
```powershell
python main.py --retrieval-window 2 --query "Explain the process"
```

**Enable Reranking**:
```powershell
python main.py --reranking --query "What are the requirements?"
```

#### Combine Options

**Full Example**:
```powershell
python main.py \
  --gguf-path "C:\Models\qwen2.5-1.5b-instruct-q4_k_m.gguf" \
  --chunk-size 256 \
  --n-results 3 \
  --max-tokens 512 \
  --temperature 0.3 \
  --hybrid-search \
  --retrieval-window 1 \
  --ingest "C:\Documents\reports"
```

### Batch Processing

**Create Script** (`process.sh` on Linux/Mac, `process.bat` on Windows):

```batch
@echo off
python main.py --gguf-path "C:\Models\qwen2.5-1.5b-instruct-q4_k_m.gguf"
python main.py --query "What are the main findings?"
python main.py --query "Can you summarize the key points?"
python main.py --query "What are the next steps?"
```

**Run Batch**:
```powershell
.\process.bat
```

## API User Guide

### Setup

1. **Install Dependencies**:
```powershell
pip install -r requirements.txt
```

2. **Start API Server**:
```powershell
python main.py --api --port 8080
```

3. **Verify Server**:
```powershell
curl http://localhost:8080/
# Response: {"status": "ok"}
```

### API Endpoints

#### Health Check

```python
import requests

response = requests.get("http://localhost:8080/")
print(response.json())
# {"status": "ok"}
```

#### Get Statistics

```python
response = requests.get("http://localhost:8080/stats")
print(response.json())
# {
#   "document_count": 5,
#   "chunk_count": 20,
#   "llm": {"backend": "GGUF", "model": "qwen2.5-1.5b-instruct-q4_k_m.gguf"},
#   "config": {...}
# }
```

#### Ask Question

```python
import requests

response = requests.post("http://localhost:8080/ask", json={
    "question": "What are the main findings?",
    "n_results": 3
})

result = response.json()
print(f"Answer: {result['answer']}")
print(f"Sources: {result['sources']}")
print(f"Time: {result['inference_time']:.2f}s")
```

#### Search Documents

```python
response = requests.post("http://localhost:8080/search", json={
    "query": "annual revenue"
})

matches = response.json()
for doc, meta, score in matches:
    print(f"[{score:.3f}] {doc}")
```

#### Ingest Directory

```python
response = requests.post("http://localhost:8080/ingest", json={
    "directory": "C:/Documents/reports"
})

stats = response.json()
print(f"Success: {stats['success']}")
print(f"Documents: {stats['documents']}")
print(f"Chunks: {stats['chunks_added']}")
```

#### Ingest File

```python
import requests

with open("report.pdf", "rb") as f:
    files = {"file": f}
    response = requests.post("http://localhost:8080/ingest/file", files=files)

stats = response.json()
print(f"Success: {stats['success']}")
print(f"Chunks: {stats['chunks_added']}")
```

#### List Documents

```python
response = requests.get("http://localhost:8080/documents")
documents = response.json()
print(f"Documents: {documents}")
# ["report1.pdf", "report2.pdf", "slides.pptx"]
```

#### Clear Documents

```python
response = requests.delete("http://localhost:8080/documents")
print(response.json())
# {"success": true}
```

### Python Integration

#### Basic Example

```python
import requests
import os

# Configure
os.environ["RAG_GGUF_PATH"] = "C:\Models\qwen2.5-1.5b-instruct-q4_k_m.gguf"

# Start server in separate process (or use background thread)
# python main.py --api --port 8080

def ask_question(question):
    response = requests.post("http://localhost:8080/ask", json={
        "question": question,
        "n_results": 3
    })
    return response.json()

# Use
result = ask_question("What are the main findings?")
print(f"Answer: {result['answer']}")
print(f"Sources: {result['sources']}")
```

#### Flask Integration

```python
from flask import Flask, request, jsonify
import requests

app = Flask(__name__)

# RAG API URL
RAG_API = "http://localhost:8080"

@app.route('/ask', methods=['POST'])
def ask():
    question = request.json.get('question', '')
    n_results = request.json.get('n_results', 3)

    response = requests.post(f"{RAG_API}/ask", json={
        "question": question,
        "n_results": n_results
    })

    return jsonify(response.json())

if __name__ == '__main__':
    app.run(port=5000)
```

#### Django Integration

```python
from django.http import JsonResponse
import requests

RAG_API = "http://localhost:8080"

def ask_question(request):
    if request.method == 'POST':
        data = request.json
        question = data.get('question', '')
        n_results = data.get('n_results', 3)

        response = requests.post(f"{RAG_API}/ask", json={
            "question": question,
            "n_results": n_results
        })

        return JsonResponse(response.json())
```

### Testing API

#### Test Script

```python
import requests
import time

BASE_URL = "http://localhost:8080"

def test_api():
    # Health check
    r = requests.get(f"{BASE_URL}/")
    assert r.json()['status'] == 'ok'
    print("✓ Health check passed")

    # Get stats
    r = requests.get(f"{BASE_URL}/stats")
    stats = r.json()
    print(f"✓ Stats: {stats['document_count']} documents, {stats['chunk_count']} chunks")

    # Ask question
    r = requests.post(f"{BASE_URL}/ask", json={
        "question": "Test question",
        "n_results": 1
    })
    result = r.json()
    assert 'answer' in result
    print(f"✓ Answer received: {len(result['answer'])} chars")

    # Search
    r = requests.post(f"{BASE_URL}/search", json={
        "query": "test"
    })
    assert len(r.json()) > 0
    print(f"✓ Search found {len(r.json())} results")

    print("\n✓ All tests passed!")

if __name__ == '__main__':
    test_api()
```

## Best Practices

### Document Preparation

1. **Organize Documents**:
   - Use clear file names
   - Organize by topic or date
   - Include metadata in document headers

2. **Formatting**:
   - Use standard document formats (PDF, DOCX)
   - Avoid tables in single cells
   - Use consistent headings

3. **Length**:
   - Keep documents under 100 pages
   - Split very long documents
   - Use section dividers

### Query Optimization

1. **Be Specific**:
   ```
   ✗ What does the report say?
   ✓ What are the main findings in the Q3 report?
   ```

2. **Include Keywords**:
   ```
   ✗ Explain the project.
   ✓ Explain the Q3 project timeline and deliverables.
   ```

3. **Use Multiple Questions**:
   ```
   ✗ What are the benefits, challenges, and next steps?
   ✓ What are the benefits of the new initiative?
   What are the challenges?
   What are the next steps?
   ```

### Performance Tips

1. **Chunk Size**:
   - Start with 256 words
   - Adjust based on document length
   - Smaller for long documents

2. **Results Count**:
   - Start with 3 results
   - Increase for complex questions
   - Decrease for fast queries

3. **Window Expansion**:
   - Use 1 for most cases
   - Increase for detailed questions
   - Disable for speed

### Quality Tips

1. **Enable Hybrid Search**:
   - Always ON for best results
   - Combines keyword and semantic search

2. **Temperature**:
   - Use 0.2-0.3 for factual
   - Use 0.5-0.7 for creative

3. **Max Tokens**:
   - Use 512 for general
   - Use 1024 for detailed answers

## Advanced Usage

### Custom Models

#### Use Different GGUF Model

```powershell
python main.py --gguf-path "C:\Models\qwen2.5-7b-instruct-q4_k_m.gguf"
```

#### Use Different Embedding Model

```python
from rag_engine import RAGConfig

config = RAGConfig(
    embedding_model="all-MiniLM-L6-v2"
)
engine = RAGEngine(config=config)
```

### Batch Queries

```python
import requests
from concurrent.futures import ThreadPoolExecutor

BASE_URL = "http://localhost:8080"

questions = [
    "What are the main findings?",
    "Can you summarize the report?",
    "What are the next steps?",
]

def ask(question):
    response = requests.post(f"{BASE_URL}/ask", json={"question": question})
    return response.json()

with ThreadPoolExecutor(max_workers=5) as executor:
    results = list(executor.map(ask, questions))

for i, result in enumerate(results):
    print(f"Q{i+1}: {result['answer'][:100]}...")
```

### Export Answers

```python
import json
import requests

BASE_URL = "http://localhost:8080"

answers = []

questions = ["Question 1", "Question 2", "Question 3"]

for q in questions:
    response = requests.post(f"{BASE_URL}/ask", json={"question": q})
    result = response.json()
    answers.append(result)

# Save to file
with open("answers.json", "w") as f:
    json.dump(answers, f, indent=2)

print("Answers saved to answers.json")
```

### Real-time Streaming (Python)

```python
import requests
import json

BASE_URL = "http://localhost:8080"

response = requests.post(
    f"{BASE_URL}/ask",
    json={"question": "Tell me about the project"},
    stream=True
)

for line in response.iter_lines():
    if line:
        data = json.loads(line.decode())
        if data.get('type') == 'chunk':
            print(data['text'], end='', flush=True)

print("\n")
```

## Common Workflows

### Workflow 1: Initial Setup

**Goal**: Get started with the application

1. Install dependencies
2. Download GGUF model
3. Configure settings
4. Ingest sample documents
5. Test queries

```powershell
# 1. Install
pip install -r requirements.txt

# 2. Download model
# Save qwen2.5-1.5b-instruct-q4_k_m.gguf

# 3. Configure (GUI)
python main.py
# Click Settings → Browse GGUF model → Save

# 4. Ingest
python main.py --ingest "C:\Documents\sample"

# 5. Test
python main.py --query "What are the documents about?"
```

### Workflow 2: Production Deployment

**Goal**: Deploy for regular use

1. Create batch script
2. Configure offline settings
3. Set up auto-start
4. Monitor performance

**Batch Script** (`launch.bat`):
```batch
@echo off
start python main.py --api --port 8080
```

**Task Scheduler**:
- Action: Start a program
- Program: `launch.bat`
- Trigger: At system startup

### Workflow 3: Document Analysis

**Goal**: Analyze multiple documents

1. Ingest all documents
2. Create list of questions
3. Process batch
4. Export results

```python
import requests
import json

documents = ["doc1.pdf", "doc2.pdf", "doc3.pdf"]
questions = [
    "What are the main themes?",
    "What are the key findings?",
    "What are the recommendations?"
]

results = []

for doc in documents:
    response = requests.post("http://localhost:8080/ingest", json={"directory": doc})
    print(f"Ingested {doc}")

for q in questions:
    response = requests.post("http://localhost:8080/ask", json={"question": q})
    results.append(response.json())

with open("analysis.json", "w") as f:
    json.dump(results, f, indent=2)
```

---

**Version**: 1.0.0
**Last Updated**: 2026-02-28
