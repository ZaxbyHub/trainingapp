# Web App Overhaul — Staged Roadmap

**Owner:** Agent Jack (PM) · **Diary author:** (zaxbysauce) · **Branch:** `claude/gifted-allen-9987ed`
**Date:** 2026-06-20

## Goal
Ship TWO first-class delivery options:
1. **Desktop app** (existing Python + PyInstaller + llama.cpp/GGUF) — keep first-class.
2. **HTML5 web app** — a *fully self-contained, offline, STIG-scannable* archive. No runtime
   downloads; all models packaged locally.

## Locked decisions (from product owner, 2026-06-20)
- **Scope:** Full overhaul, staged into phases with a check-in between each phase.
- **Browser inference:** BOTH engines, user-selectable —
  - **wllama** (llama.cpp WASM, CPU/SIMD, **no WebGPU required**) — primary, robust on i5/Iris Xe.
  - **WebLLM** (WebGPU/MLC) — optional fast path when WebGPU is usable.
- **Chat model → multimodal:** `Google Gemma 4 E2B-it` (vision-language) to enable
  **screenshot/image upload** for support. (Originally `LiquidAI/LFM2.5-VL-450M`;
  swapped to Gemma 4 E2B-it for a ~5× quality jump — see PR #39.)

## Feasibility verdict (validated 2026-06-20)
- The GGUF + `mmproj` projector family (originally LFM2-VL, now Gemma 4 E2B-it) ships as
  GGUF + mmproj and runs in llama.cpp multimodal (`libmtmd`/`llama-mtmd-cli`).
- **wllama V3** supports **multimodal via mmproj in-browser**, WASM SIMD, CPU-only (no WebGPU),
  with `loadModelFromUrl` (same-origin / split files), 2 GB/file ArrayBuffer limit (split with
  `llama-gguf-split`), and **OPFS caching**. → Offline, packaged, multimodal browser inference is
  feasible on target hardware.
- **Risk:** GGUF + mmproj may need packaging-time conversion from
  safetensors (`convert_hf_to_gguf` + mmproj). Mitigation: prepare-models pipeline + validation.
- **Risk:** WebLLM has no guaranteed multimodal MLC build → WebLLM stays a **text** fast-path;
  multimodal routes through **wllama** or **server**.

## Ground-truth corrections to the Grok report
- The web UI is **not "very crude."** It already has a persistent nav rail, design-token theming
  with dark mode, error boundary, toasts, skeletons, empty states, virtualized doc list with
  per-file progress, interactive source citations, XSS-safe markdown, and a large settings page.
- The **real** ship-blocker is **offline model packaging**, which is genuinely absent:
  embeddings + WebLLM both fetch from CDNs at runtime; no `public/models/`, no local-first config.

## Phases (check in after each)
- **Phase 1 — Offline packaging foundation (P0 keystone). ✅ DONE.** Local-first embeddings
  (`allowLocalModels`, `allowRemoteModels=false`, `localModelPath`, local ORT wasm), packaged-model
  manifest + readiness gate (present vs missing), `prepare-models` script, `PACKAGING.md`.
  No runtime downloads for embeddings.
- **Phase 2 — wllama engine. ✅ DONE.** `LLMService` interface; `WllamaService` (GGUF + mmproj,
  CPU/WASM, no WebGPU); engine factory + persisted `browserEngine` preference; orchestrator
  injection; packaged wllama runtime + **offline compat build** (no jsdelivr) + Gemma 4 E2B-it weights;
  pre-load presence probe. Independent review caught + fixed: wasm-path-as-file, CDN compat
  fallback, missing presence check.
- **Phase 3 — Engine selection + hardware tiering. ✅ DONE.** `detectEngineCapability()`
  (WebGPU adapter probe, cross-origin isolation, memory tier → recommended engine + green/yellow/red);
  engine-aware `ModelReadinessGate` (WebGPU hard-required only for WebLLM; wllama gated on packaged
  GGUF + memory); Settings UX (engine selector, capability panel, packaged-models status). Readiness
  trigger extracted to a light module + wired into ChatPage so the engine choice actually reaches the
  gate. Independent review caught + fixed: the fix was half-wired (boot defaulted to webllm; cache
  check was WebLLM-only) → now genuinely engine-aware end-to-end.
- **Phase 4 — Multimodal / image upload. ✅ DONE (browser path).** LLMMessage content extended to
  text/image parts; image attach UI (validate + downscale → ArrayBuffer), threaded through
  orchestrator → wllama mmproj; WebLLM flattens to text; thumbnails render in the user bubble.
  Attach gated on wllama + model ready; readiness now requires BOTH gguf + mmproj (review fix).
  Server VLM path deferred to Phase 6 (desktop/server integration).
- **Phase 5 — UX gap-fill. ✅ DONE (core).** Regenerate last answer (pure, tested cut-loop),
  conversation export (JSON/Markdown download, no image-byte leakage), RAG presets
  (Fast/Balanced/Quality) persisted + wired into queries. Review fixes: clear regen-ref on Clear,
  preset-scope note. (Onboarding/sample-dataset + citation-highlight deferred as lower-value.)
- **Phase 6 — Self-contained HTML5 archive build. ✅ DONE (server VLM deferred).** Relative-base
  build (`base: './'`); `validate-build` fails the build on missing packaged models; FastAPI serves
  the archive at root with COOP/COEP middleware (and the SPA index at `/`); `build.py` + spec bundle
  `web_ui/dist`. Review fixes: dropped the counterproductive CDN-hostname grep (false-failed on
  vendored constants); fixed the root route shadowing the SPA. Server-side VLM endpoint deferred
  (needs llama-cpp-python multimodal verified on real hardware; browser path already does multimodal).
- **Phase 7 — Quality gates. ✅ DONE (core).** New flows are covered by focused unit tests across
  every phase (offline packaging, engine factory/capability/readiness, multimodal content,
  regenerate, presets, export); README documents the overhauled offline web app. All changed
  subsystems are green; remaining failures are pre-existing (web-llm/webgpu-watchdog, pdf/pptx/xlsx
  extractors) and identical on `master`. (Deeper a11y audit + CI perf budgets noted for follow-up.)

## Status: Phases 1–7 complete and pushed to `claude/gifted-allen-9987ed`.
Each phase: parallel exploration → scoped implementation → independent adversarial review → review
fixes + regression checks vs `master` baseline → commit. Independent review caught and fixed real
ship-blockers in every phase (offline env-clobber + ORT filename; wllama wasm-path + CDN compat
fallback; half-wired engine-aware readiness; multimodal mmproj readiness gap; validate-build
false-fail + root-route SPA shadowing).

## Standing constraints
- Fully offline after packaging; zero CDN/HF/MLC fetches at runtime.
- Target HW: 12th-gen i5 mobile, Iris Xe (WebGPU unreliable), 16 GB RAM, 512 GB SSD.
- Keep the existing test suite green; add tests for new behavior.
- Model **binaries are never committed** (kept like desktop GGUF); assembled at package time.
