# Desktop memory soak harness (B8, issue #66 / AC1)

`memory-soak.mjs` boots the real desktop backend host (node mode — the same
`NodeBackendHost` the Electron shell runs, including the B8 memory governance
stack, real B4 inference when weights are staged, real B6/B7 ingest +
retrieval) and runs a sustained ingest+query workload while sampling
`GET /telemetry/memory` every cycle.

It exits 0 when the host survived the whole workload with well-formed
telemetry (the no-OOM/crash proof) and 1 otherwise. Whether the Quality->Fast
downgrade TRIGGERED is reported, not asserted — triggering requires free RAM
below `memory.pressureThresholdGb` (6 GiB) sustained for
`memory.pressureSustainedMs` (10 s).

## Reference-laptop procedure (the AC1 evidence the issue demands)

The physical soak is run on the 16 GB i5 reference laptop ("needs-hardware";
no CI run substitutes for it). Checklist:

1. Machine state: 16 GB i5 laptop, AC power, lid open, no other heavy
   applications; record the hardware tuple (CPU model, RAM, OS build,
   inference-library version from `desktop/package.json`, ONNX Runtime
   version, model SHA256 for both profiles via `sha256sum models/*/*/model.gguf`).
2. Build and stage:
   ```
   npm --prefix desktop ci
   npm --prefix desktop run compile
   # stage models/gemma-4-e2b-it/ and models/lfm2.5-vl-450m/ (both profiles)
   ```
3. The reference laptop idles near ~8-12 GB free; to reach AC1's "~6 GB free"
   condition, close background apps until `os.freemem()` is at/below 6 GiB,
   or run from a machine with more headroom using the ballast flag:
   ```
   node desktop/test/soak/memory-soak.mjs --duration-s 1800 --target-free-gb 6 --report soak-16gb-i5.log
   ```
   (`--target-free-gb` ballast-allocates until free RAM is at/below the
   target; on machines below `--min-total-gb` (default 12) it refuses to
   BALLAST — logging a safety notice and continuing WITHOUT ballast — so it
   can never starve the target laptop itself. On a machine already at
   ~6 GB free, omit the flag. `--queries-per-cycle <n>` (default 1) controls
   the concurrent /ask load per cycle.)
4. While it runs: watch the telemetry lines — sustained sub-6 GiB free RAM
   must flip `profile:quality downgraded:false` to `downgraded:true` within
   ~10-20 s, and the host must keep serving ingest+query without OOM/crash.
5. Attach `soak-16gb-i5.log` (telemetry log + verdict JSON) to the issue and
   mirror the final component table into `bench/RESULTS.md` +
   `docs/adr/0008-memory-budget.md`. The soak is invalidated if B4/B7 change
   their resource footprint (different reranker, larger KV cache) — re-run.

## Quick smoke (any machine, seconds)

```
npm --prefix desktop run compile
node desktop/test/soak/memory-soak.mjs --duration-s 20 --docs 6 --embedder hash
```

`--embedder hash` skips ONNX weights (deterministic fixture embedder) so the
harness runs on CI-like machines; the LLM still loads if a GGUF is staged —
add `--model-dir` pointing at an empty dir to skip native inference.

## Devstation provisional runs

Runs on non-reference machines (e.g. the 128 GB devstation) produce valid
per-component RSS numbers but are NOT the AC1 evidence; record them in
`bench/RESULTS.md` as machine-tagged provisional rows and keep the
reference-laptop rows explicitly marked. Ballasting a 128 GB machine down to
6 GB free is supported (`--target-free-gb 6`) and exercises the downgrade
path, but the pressure numbers are only acceptance-grade on the reference
hardware.
