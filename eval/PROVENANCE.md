# Provenance — eval/a8-*.png

`a8-embed-coep.png` and `a8-jump-01..10.png` are annotated screenshots of the
**Articulate Storyline 360** publish output (course id `5fox24EQH9w`,
Storyline version `3.114.36620.0` — the same third-party publish as
`desktop/e2e/fixtures/storyline-nav`), captured by `eval/a8-probe.mjs` during
the issue #58 (A8) probe run. They are the visual evidence for the A8 spike's
acceptance rows (iframe-under-COEP embedding, 10 exact slide jumps).

Per `desktop/e2e/fixtures/storyline-nav/FIXTURE_CONTRACT.md` (§9), this
content **is not covered by this repository's MIT license** and must not be
redistributed outside the organization. All 10 screenshotted slides are a
subset of the already-committed 12-slide frozen e2e manifest; the screenshots
add rendered views of that same material, nothing from any other source.

Regenerate with `node eval/a8-probe.mjs --root <publishDir>` (requires
desktop's installed playwright-core). The committed transcript
`eval/a8-recipe-probe.json` is the machine-written record of the same run.
