# Offline and low-RAM validation matrix (E3 / issue #86)

Owner: workstream E slot E3 (issue #86). This document enumerates the issue's
ten acceptance-matrix scenarios with pass/fail criteria, exact reproduction
steps, the hardware/software tuple template every row references, and the
results-capture channel into `bench/RESULTS.md` (section
`## Offline validation matrix (E3/#86)`).

Two leg classes are kept explicitly apart:

- **Environment legs** are automated by the harness
  (`bench/run_offline_matrix.mjs`, thin Windows launcher
  `bench/run_offline_matrix.ps1`): header-strip proxy, RAM-pressure filler,
  network-disconnect toggle. The egress observation for S1 is NOT automated:
  it is the operator-run PowerShell procedure in its own section below.
- **Proof legs** are the measured assertions only the reference laptop can
  produce. Every scenario row below carries `BLOCKED: reference laptop`
  because its Required proof needs the tuple's hardware conditions; the
  harness arranges the environment and never claims the measured proof.

The harness scenario registry is exactly this table's ids (`--list` prints
them; the frozen consistency check compares the two sets). Rows in
`bench/RESULTS.md` stay `PENDING` until the operator's measured rows land.

## Hardware/software tuple

Recorded ONCE per machine run, before the first scenario, and referenced by
every scenario row through the anchor id this template declares: `{{TUPLE}}`.
Any change to the reference hardware/OS, a bundled model sha256, or a later
A6 model change invalidates the whole matrix (the issue's exit-gate clause) —
re-record the tuple and re-run, never hand-patch.

| field | value |
|---|---|
| CPU model | PENDING — record on the reference laptop (12th-gen Core i5 mobile expected) |
| RAM (total + typical free) | PENDING — total physical bytes plus the typical idle free bytes observed before the scenario legs |
| OS build | PENDING — exact Windows build (e.g. `Get-CimInstance Win32_OperatingSystem | Select-Object Version,BuildNumber`) |
| GPU driver | PENDING — integrated GPU driver version, recorded exactly |
| llama.cpp | PENDING — llama-cpp-python / external llama-bench build identifiers of the run |
| wllama | PENDING — @wllama/wllama pin the browser surface runs |
| node-llama-cpp | PENDING — version the shipped desktop backend runs |
| sha256 | PENDING — sha256 of every bundled model file staged for the run |
| adapter (egress leg) | PENDING — the `Get-NetAdapter` interface name the egress observation of scenario 1 measured |

## Scenario matrix

| Scenario | Id | Tuple / status | Pass/fail criteria | Repro steps |
|---|---|---|---|---|
| Cold install, full network disconnect | S1 | {{TUPLE}} — BLOCKED: reference laptop | Wizard completes; `/ask` answers with citations; zero egress observed (adapter-wide sent-byte delta <= 1 MiB over the fixed window, per "Egress observation (S1)") | "Scenario S1" below: fresh install, adapter disabled via the harness before launch, fixed 10-minute egress window with control leg |
| 16 GB, ~9 GB free | S2 | {{TUPLE}} — BLOCKED: reference laptop | Quality loads if the A3 RAM gate clears, else Fast auto-selects; no misdirecting message shown | "Scenario S2" below: harness RAM filler holds system free near the 9000 MiB floor, then launch and load per the operator steps |
| 16 GB, <6 GB free | S3 | {{TUPLE}} — BLOCKED: reference laptop | Fast auto-selects; no OOM and no crash; tok/s recorded | "Scenario S3" below: harness RAM filler drives system free below 6 GiB (target 5600 MiB), then launch, load, and measure |
| Cold-start timing | S4 | {{TUPLE}} — BLOCKED: reference laptop | p50 and p95 of launch-to-first-token over 5 runs recorded (real disk re-read cost measured, not estimated) | "Scenario S4" below: five cold starts timed per the operator steps; no automated environment leg |
| Thread utilization | S5 | {{TUPLE}} — BLOCKED: reference laptop | tok/s at the shipped default and at `min(cores, 8)` both recorded; the delta is quantified | "Scenario S5" below: the two thread configurations of the runbook bench loop, recorded side by side |
| Reranker on clean install | S6 | {{TUPLE}} — BLOCKED: reference laptop | Reranker loads (E1 HF-cache packaging), or falls back with a VISIBLE indicator — never silently | "Scenario S6" below: fresh install with no manual precache step, then the indicator/logs check |
| Cross-origin isolation stripped | S7 | {{TUPLE}} — BLOCKED: reference laptop | Falls back to single-thread WASM without crash; tok/s recorded; UI shows degraded mode | "Scenario S7" below: harness strip proxy fronting the app origin, browser pointed at the proxy for the window |
| GPU acceleration default | S8 | {{TUPLE}} — BLOCKED: reference laptop | B4's GPU-off default confirmed; manual enable does not reproduce the llama.cpp #17389 pattern, or is gated with a warning | "Scenario S8" below: default-off probe record plus the gated manual-enable check |
| Ingestion under low RAM | S9 | {{TUPLE}} — BLOCKED: reference laptop | No OOM while ingesting a 200-page PDF below 6 GiB free; time recorded and compared to the <60 s target | "Scenario S9" below: RAM filler at the 5600 MiB target, then the 200-page ingest per the operator steps |
| Full offline restart persistence | S10 | {{TUPLE}} — BLOCKED: reference laptop | After scenario 1 plus a machine restart with no reconnect, the app launches to working chat state and the wizard does not spuriously re-trigger | "Scenario S10" below: persistent disabled adapter survives the restart, then the launch check and `--recover` |

## Scenario S1 — Cold install, full network disconnect

Setup: fresh install of the exact build recorded in the tuple; the network
adapter is disabled BEFORE first launch (the issue's setup condition).

Automated environment legs (administrator PowerShell at the repo root):

```
node bench/run_offline_matrix.mjs --scenario S1 --prep --adapter "<adapter name>" --confirm-network-toggle
```

The toggle is fail-closed: it refuses without `--confirm-network-toggle`,
without an elevated shell, and without an explicit `--adapter` (it never
guesses an adapter). It journals before acting, disables via
`netsh interface set interface "<adapter name>" disable`, and verifies by
read-back; the adapter is PERSISTENT — it stays disabled across the operator
window (this scenario's whole point) until `--recover` or the detached
recovery watchdog restores it.

Operator steps:

1. Record the tuple (including the adapter name the egress leg will measure).
2. Run the prep command above; confirm the "disabled and verified by
   read-back" line, then keep the shell for the restore step.
3. Install fresh; launch the app with the adapter still disabled.
4. Complete the first-run wizard end to end.
5. Ask a `/ask` question against the default pack; record the answer and its
   citations.
6. Run the "Egress observation (S1)" procedure over a fixed 10-minute window.
7. Record the row per "Results capture", then restore the adapter:

```
node bench/run_offline_matrix.mjs --recover
```

Pass/fail: wizard completes; `/ask` answers with citations; the egress
procedure's adapter-wide delta is within the 1 MiB tolerance (or the verdict
is recorded as inconclusive-for-app-egress with the number, never silently
passed).

## Scenario S2 — 16 GB, ~9 GB free

Setup: the machine is brought to roughly 9 GiB of free system memory before
launch (the issue's "browser tabs/Office" pressure, produced repeatably by
the harness filler instead of hand-loaded apps).

Automated environment legs:

```
node bench/run_offline_matrix.mjs --scenario S2 --prep --ram-free-target-mb 9000
```

Supervised chunk workers allocate in 256 MiB steps until
`os.freemem() <= target + 512 MiB` tolerance; a 2048 MiB reserve floor
refuses any target below reserve + tolerance before allocating; the fill
holds while the scenario window runs and releases (with a free-memory re-read)
when the harness is interrupted.

Operator steps: start the prep, wait for the attainment line, launch the app
while the filler holds, load the Quality profile, observe the profile choice
and any message, then end the window (Ctrl+C tears the filler down and writes
the capture row).

Pass/fail: Quality loads if the A3 gate clears, else Fast auto-selects; the
message shown must not misdirect (the A3 diagnostic contract).

## Scenario S3 — 16 GB, <6 GB free

Automated environment legs (target 5600 MiB: attainment at
target + 512 MiB = 6112 MiB free keeps the floor strictly below 6 GiB):

```
node bench/run_offline_matrix.mjs --scenario S3 --prep --ram-free-target-mb 5600
```

Operator steps: start the prep, wait for attainment, launch the app, let the
profile auto-selection run under the pressure, record tok/s during a fixed
query, then Ctrl+C to release.

Pass/fail: Fast auto-selects; no OOM and no crash; tok/s recorded.

## Scenario S4 — Cold-start timing

No automated environment leg (a timing measurement, not an environment
manipulation).

Operator steps: for 5 runs — cold-start the installed app (no warm process),
measure launch-to-first-token wall clock (the first streamed token of a fixed
first question), record all 5 samples. The tuple's disk/OS fields are part of
the measurement identity.

Pass/fail: p50 and p95 recorded in the row's `measured` field. This measures
the actual disk re-read cost (the browser path's re-stream), not an estimate.

## Scenario S5 — Thread utilization

No automated environment leg.

Operator steps: run the same model/quant/prompt cell of the
`bench/llama_bench_driver.py` loop documented in
`bench/RESULTS.md` ("Reproducing on the reference laptop") twice — once at
the shipped default thread count, once at `min(physical cores, 8)` — and
record both rows through `bench/append_results.py` as usual.

Pass/fail: both tok/s numbers recorded; the delta quantified in the row notes.

## Scenario S6 — Reranker on clean install

No automated environment leg.

Operator steps: install fresh on a clean OS user profile (no manual HF-cache
precache step), ingest one default-pack document, ask a question that should
trigger reranking, then check both the visible indicator surface and the app
logs for the reranker load outcome.

Pass/fail: the reranker loads (E1's HF-cache packaging), or retrieval falls
back with a VISIBLE indicator; a silent drop to plain top-k fails this row.

## Scenario S7 — Cross-origin isolation stripped

Setup: the harness reverse proxy fronts the app's loopback origin and strips
the isolation headers the corporate-proxy simulation removes.

Automated environment legs:

```
node bench/run_offline_matrix.mjs --scenario S7 --prep --proxy-upstream http://127.0.0.1:<app port>
```

The proxy binds `127.0.0.1` (OS-assigned port, printed as
`proxy:<host>:<port>`), strips Cross-Origin-Opener-Policy /
Cross-Origin-Embedder-Policy / Cross-Origin-Resource-Policy on every response
class (200/3xx/4xx/5xx, HEAD included), re-anchors redirect Locations onto
the proxy origin (absolute and scheme-relative upstream references alike),
and names upstream failures (502 refused / 504 timeout).

Operator steps: start the app origin, start the prep, point the browser at
the printed proxy base URL for the whole window, load the browser LLM path,
record tok/s and the degraded-mode UI state, then Ctrl+C.

Pass/fail: the app falls back to single-thread WASM without crashing; tok/s
recorded; the UI shows degraded mode.

## Scenario S8 — GPU acceleration default

No automated environment leg.

Operator steps: on the default configuration, run the GPU probe reproduce
command recorded in `bench/RESULTS.md` ("GPU device matrix (issue #155)") and
record the probe's verdict; then, in a throwaway profile, manually enable GPU
offload and run a short generation, watching for the llama.cpp #17389 crash
pattern (or the gating warning, whichever B4 ships).

Pass/fail: GPU acceleration confirmed off by default; the manual enable does
not reproduce the #17389 pattern, or is gated with a warning.

## Scenario S9 — Ingestion under low RAM

Automated environment legs (same filler target as the below-6-GiB scenario):

```
node bench/run_offline_matrix.mjs --scenario S9 --prep --ram-free-target-mb 5600
```

Operator steps: start the prep, wait for attainment, ingest the 200-page
test PDF through the app's Documents flow while the filler holds, record the
ingest wall clock, then Ctrl+C to release.

Pass/fail: no OOM; ingest time recorded and compared to the <60 s target
(the B6 budget) in the row notes.

## Scenario S10 — Full offline restart persistence

Setup: continues scenario 1's state — the adapter disable is deliberately
PERSISTENT so it survives the restart.

Automated environment legs (the same persistent toggle; run before the
restart if not already disabled):

```
node bench/run_offline_matrix.mjs --scenario S10 --prep --adapter "<adapter name>" --confirm-network-toggle
```

Operator steps: with the adapter disabled (from scenario 1 or the command
above), restart the machine and DO NOT reconnect; launch the app; confirm the
chat state is working and the first-run wizard does not spuriously re-trigger;
record the row; then restore:

```
node bench/run_offline_matrix.mjs --recover
```

Pass/fail: app launches to working chat state; the wizard does not re-trigger.

## Egress observation (S1)

LITERAL bounded procedure, honestly scoped: `Get-NetAdapterStatistics` counts
ADAPTER-WIDE traffic (every process on the machine, plus control-plane
noise), not per-process egress. The verdict below therefore leans on a
tolerance and a control leg, and never claims per-process attribution.

```powershell
$a = Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -First 1   # record $a.Name into the tuple
$t0 = Get-Date; $s0 = ($a | Get-NetAdapterStatistics).SentBytes
# --- run the scenario window here: fixed 10-minute interval, timestamps recorded ---
$s1 = (Get-NetAdapterStatistics -Name $a.Name).SentBytes; $t1 = Get-Date
$delta = $s1 - $s0; $window = $t1 - $t0   # adapter-wide sent bytes over the window
```

1. Select the adapter (first `Up` adapter) and record `$a.Name` into the
   tuple — the egress number is meaningless without it.
2. Capture `$t0`/`$s0` immediately before the window opens.
3. Run the scenario window for a fixed 10-minute interval; record both
   timestamps in the row notes.
4. Capture `$s1`/`$t1` immediately after the window closes and compute the
   delta.
5. PASS iff `delta <= 1 MiB` (1,048,576 bytes) over the window. The tolerance
   covers adapter-wide control-plane noise — ARP/IPv6 neighbor discovery/
   DHCP renewals are bounded and rare on a quiet LAN; the 1 MiB constant is a
   recorded judgment, not a measured baseline.
6. `delta > tolerance` -> the verdict is INCONCLUSIVE-for-app-egress with the
   adapter-wide number recorded. A later `Get-NetTCPConnection` snapshot can
   show CURRENT connections only — it is never cited as retroactive
   attribution for the closed window.
7. Errors (the adapter vanishes mid-window, the cmdlet is unavailable) abort
   the capture with the named reason and the verdict is NOT-RUN — never a
   pass.

Control leg: run the same procedure once with the app closed (same adapter,
same 10-minute shape) and record that baseline delta next to the scenario
delta, so the tolerance can be read against the machine's own quiet-LAN
noise.

## Results capture

Every prep/run writes one JSON row under `bench/offline-matrix-results/`
named `<S-id>-<machine>-<YYYYMMDDTHHMMSSZ>.json` (colon-free filename; the
real ISO timestamp is inside the JSON). Row schema (surface
`offline-matrix`, registered in `bench/append_results.py`):

```json
{
  "surface": "offline-matrix",
  "machine": "reference-i5",
  "scenario_id": "S3",
  "scenario": "16 GB, <6 GB free",
  "outcome": "PENDING",
  "tuple_ref": "{{TUPLE}}",
  "automated_legs": "ram-filler:attained",
  "blocked_marker": "BLOCKED: reference laptop",
  "measured": "ram-filler attained; chunks 24; free-after-release 14890 MiB (target 5600 MiB, tolerance 512 MiB)",
  "notes": "node v24.16.0; win32/x64; ended by SIGINT"
}
```

- `outcome` is `PENDING` in harness rows: the scenario's pass/fail verdict is
  the operator's measured proof, never the harness's. The operator's final
  row (outcome `pass`/`fail` with the measured numbers in `measured`) fills
  the PENDING placeholder in `bench/RESULTS.md`.
- Machine-tag discipline: `BENCH_MACHINE_TAG` must name a machine registered
  under `## Machine registry` in `bench/RESULTS.md` (`reference-i5` for the
  laptop run); the harness refuses to write a capture row without it, and
  `bench/append_results.py` refuses unregistered tags at merge time.
- Merge path (fail-closed, duplicate-refusing on machine + scenario_id):

```
python bench/append_results.py --row-file bench/offline-matrix-results/<file>.json
```

## Network toggle safety and honest limits

The toggle's mitigation chain: journal-before-act
(`bench/.offline-matrix-journal.json` is written BEFORE the disable, carrying
mode, adapter, prior state, timestamp, pid and lease), read-back
verification, a DETACHED recovery watchdog child (re-reads the journal,
restores at lease expiry — default 45 minutes from the journal timestamp),
the idempotent `--recover`, and the printed manual command
`netsh interface set interface "<adapter name>" enable`.

Size `--recover-lease-min` to the whole scenario window: scenario 1's fixed
10-minute egress observation plus install time can exceed the 45-minute
default lease, and the watchdog restores the adapter silently at expiry —
pick a lease longer than the full operator window (disable through restore)
so the adapter is still disabled when the scenario's pass/fail evidence is
being taken.
Watchdog restore outcomes are silent by design (detached stdio); observe them via the journal rows and a `--recover` pass, which reprints any restore-failure remedy.

RAM-leg limits: `--ram-reserve-mb` (default 2048 MiB) sets the reserve floor
the filler never allocates past, and values below 512 MiB are refused
outright at both the parse and fill steps — that floor is what keeps the
filler away from a near-zero free system. A fill that cannot attain the
requested floor (reserve abort, stall, allocation failure) releases every
held chunk, prints the named outcome and reason, and exits 3 — it never
holds partial pressure for a scenario window.

Disclosed residual: if the harness process is SIGKILLed in the exact window
between the disable and the detached watchdog's first journal check, the
adapter stays disabled until `--recover`, the watchdog's later check, or the
manual command. That window is not claimed to be covered — the journal row is
on disk from before the act, which is what makes every recovery path
possible. The parent intentionally does NOT restore the adapter on exit for
scenarios 1 and 10: persistence across the operator's disconnect/restart
window is those scenarios' design.
