# Packaged models (`public/models/`)

This directory holds **all** model assets the web app loads. Everything here is
served **same-origin** and loaded **offline** — the app never fetches a model from
a CDN or the HuggingFace Hub at runtime. This is what makes the build a fully
self-contained, air-gapped / STIG-scannable archive.

## Layout

```
public/models/
├── manifest.json                     # version + checksums of what should be here
├── embeddings/
│   └── bge-small-en-v1.5/            # Transformers.js model, addressed as embeddings/bge-small-en-v1.5
│       ├── config.json
│       ├── tokenizer.json
│       ├── tokenizer_config.json
│       └── onnx/model.onnx
├── ort/                              # ONNX Runtime WASM (env.backends.onnx.wasm.wasmPaths)
│   ├── ort-wasm-simd-threaded.jsep.wasm   # the JSEP build transformers.js v3 actually fetches
│   └── ort-wasm-simd-threaded.jsep.mjs    # its ESM loader (also fetched same-origin)
├── reranker/                         # OPTIONAL cross-encoder (app degrades gracefully if absent)
│   └── ms-marco-MiniLM-L-6-v2/
│       ├── config.json
│       ├── tokenizer.json
│       ├── tokenizer_config.json
│       └── onnx/model.onnx
├── wllama/                           # wllama WASM runtime (browser LLM engine)
│   ├── wasm/wllama.wasm              # passed to wllama as AssetsPathConfig.default
│   └── compat/                       # offline fallback for browsers w/o JSPI/Mem64
│       ├── wllama.wasm
│       └── wllama.js
└── llm/                              # GGUF browser-LLM weights for wllama (optional)
    └── lfm2.5-vl-450m/
        ├── model.gguf               # LiquidAI LFM2.5-VL-450M Q4_K_M (~229 MB)
        └── mmproj.gguf              # multimodal vision projector (~99 MB, enables image input)
```

## How files get here

The weight binaries are **not committed to git** (they are large, and mirror the
desktop app's GGUF policy). They are copied/converted into place at packaging time:

```bash
cd web_ui
npm run prepare-models      # copies embeddings + ORT wasm from the repo
```

See [`../../../PACKAGING.md`](../../../PACKAGING.md) for the full procedure,
including GGUF conversion/splitting for the LLM (Phase 2) and the build-time
validation that fails if a required file is missing.

## Runtime readiness

`src/lib/models/model-manifest.ts` declares the required files and
`checkPackagedModels()` verifies their presence so the UI can show a clear
"models packaged & ready" vs "models missing — see packaging guide" state.
