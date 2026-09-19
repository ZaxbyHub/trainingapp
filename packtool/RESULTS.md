# Fixture-pack build results (issue #73, informational)

The issue's exit gate asks for a RESULTS.md-style note on build time for the
fixture pack. This is informational, not gated.

## Method

```
node packtool/dist/cli.js build-docs contracts/fixtures/source-docs/ \
  --id test-pack --version 1.0.0 -o out.zip --embedder hash
node packtool/dist/cli.js verify out.zip
```

Measured on the author's workstation (Windows, Node 22, warm filesystem
cache), hash embedder (deterministic; the CI fixture job uses the same so no
model weights are needed):

| Metric | Value |
|---|---|
| Source documents | 3 (.md, .json, .txt) |
| Chunks emitted | 3 |
| Pack size | ~18 KB |
| build-docs wall time (warm) | ~0.3 s |
| verify wall time (warm) | ~0.2 s |

Notes:

- With the production `--embedder onnx` (bge-small-en-v1.5, staged under
  `models/`), embedding dominates; on the same machine the 3-document fixture
  embeds in a few seconds. Real corpora scale with chunk count (~1-3 ms per
  chunk on a desktop CPU, single-threaded ONNX by design for reproducibility).
- Determinism: two builds with a fixed `--published-at` are byte-identical
  (zip included) on the same tool version and platform; the `hash` embedder is
  byte-identical cross-platform, ONNX builds are float-identical
  cross-platform but not guaranteed bit-identical (PR #108 review scope note).
