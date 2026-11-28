# Release contract — full offline testers bundle

**Rule (maintainer-stated, 2026-11-27):** a TrainingApp release for testers must
contain every file needed to test the application **fully offline**. Notes-only
releases and the `build.yml` Windows ZIP are not releases testers can use:
the ZIP built from `scripts/build.py` does not carry the staged real weights
and both knowledge packs. Never publish one as a testers artifact.

## Required payload

A release bundle is a 7z archive of the packaged `win-unpacked` tree with:

1. `TrainingApp.exe`, `resources/app.asar`, and the renderer at `resources/web_ui/`.
2. `resources/manifest.json` and **every** file it lists, with exact byte sizes:
   - real model groups: `embedding` (`bge-small-en-v1.5`), `reranker`
     (`ettin-reranker-32m-v1`), `llm-quality` (`lfm2.5-2.6b` Q4_K_M),
     `llm-fast` (`lfm2-1.2b-rag` Q4_K_M);
   - both knowledge packs: `bundled-docs/opmed-initial-1.0.0` and
     `training/opmed-cdp-mlc-1.0.1`;
   - docs/licenses.
3. Browser offline runtime assets under `resources/web_ui/` (ONNX Runtime WASM,
   wllama WASM, arctic embedder) staged by `web_ui/scripts/prepare-models.mjs`.
4. `README-portable.txt` with unsigned-build and offline instructions.

Stub/fixture weights are forbidden. A ~1 KB GGUF means a fixture slipped into
the bundle — the build must fail, not ship.

## Canonical build recipe

```bash
node scripts/build-portable-release.mjs --out .release-portable
```

The script is the single recipe: it checks the real model/pack sources,
runs `prepare-models` → renderer `build:desktop` → desktop `compile` →
`stage-installer-resources.mjs` → `build-installer-manifest.mjs` →
`electron-builder --win --dir --x64`, runs the fail-closed
`scripts/check-portable-bundle.mjs` gate, creates and tests the 7z archive,
splits it into sub-2 GiB parts, and writes all checksums. To verify an
already-built tree without rebuilding:

```bash
node scripts/check-portable-bundle.mjs desktop/desktop-release/win-unpacked
node scripts/check-portable-bundle.mjs desktop/desktop-release/win-unpacked --verify-hashes
```

## Release assets (all mandatory)

- `TrainingApp-portable-<version>-<sha>-win64.7z.part-00`, `part-01`, …
  (split at 1900 MiB; never exceed GitHub's 2 GiB per-asset cap)
- `SHA256SUMS-parts.txt` (per-part hashes)
- `TrainingApp-portable-<version>-<sha>-win64.7z.sha256` (whole-archive hash)
- `README-portable.txt`

The release body must name the merge commit, list the changes, give the
rejoin/verify/extract commands, and state the whole-archive SHA-256. Use
`gh release upload <tag> <asset>` for each asset and verify `state=uploaded`
with `gh release view <tag>` before telling testers it is ready.

## Anti-patterns (observed failures)

- Publishing curated notes with no assets — useless to testers.
- Attaching only `DocumentQAApp-windows.zip` from `build.yml` — missing the
  staged real weights and packs.
- Using `7z -v` volume mode at high compression — failed with "Can't allocate
  required memory" despite free RAM; build a single verified archive and split
  it with `split`/the build script instead.
- Building with fixture models (`--fixture-models`) or a weights-less checkout.

Tag pushes still trigger `build.yml` (its `softprops/action-gh-release` step
may fail on the generate-release-notes API with the default token). That
workflow is not the source of the testers bundle; do not treat its ZIP as a
substitute for the artifacts above.
