# spike/node-backend — issue #57 slice 1 (THROWAWAY)

Electron main-process Node backend: `node:http` loopback server implementing the
frozen `/ask/stream` shape, `node-llama-cpp` (Quality GGUF, ADR-0002),
`@huggingface/transformers` (bge-small-en-v1.5, ADR-0001), `better-sqlite3` +
`sqlite-vec` single-document index. **Deleted in the fast-follow commit after
ADR-0003 merges** — nothing here is production code and nothing may import from
`desktop/`.

Build: `npm ci && npm run build` → NSIS installer in `spike-release/`.
Run (dev): `npm start`. Models: `TRAININGAPP_SPIKE_MODELS` env or
`%USERPROFILE%\.trainingapp\models` (`gemma-4-e2b-it/model.gguf` +
`bge-small-en-v1.5/`). Fixed port for measurement: `TRAININGAPP_SPIKE_PORT`.
