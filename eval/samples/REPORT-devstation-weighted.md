# Tier-0 Eval Report

- base_url: `http://127.0.0.1:8125`
- timestamp: 2026-09-07T16:28:01+00:00
- label: devstation-weighted-bge-small-ettin-lfm2.5
- backend: embedding_model='models\\bge-small-en-v1.5', llm_backend=None
- questions: 56 (in-corpus 50, out-of-corpus 6, errors 0)

## Metrics

| metric | value |
|---|---|
| recall@1 | 0.100 |
| recall@3 | 0.340 |
| recall@5 | 0.640 |
| MRR | 0.324 |
| abstain accuracy | 0.000 (0/6) |
| latency p50 (ms) | 2885.7 |
| latency p95 (ms) | 4877.6 |
| fallback-phrase answers | 0 |

## Per-category (in-corpus, successful rows)

| category | count | recall@3 | MRR |
|---|---|---|---|
| benefits | 7 | 1.000 | 0.500 |
| compliance | 5 | 1.000 | 1.000 |
| expenses | 5 | 1.000 | 0.333 |
| it-support | 6 | 0.000 | 0.250 |
| policy | 7 | 0.000 | 0.150 |
| safety | 6 | 0.000 | 0.131 |
| security | 7 | 0.000 | 0.176 |
| training-content | 7 | 0.000 | 0.207 |

## Abstain rows (out-of-corpus)

| id | abstained | error |
|---|---|---|
| q51 | false | - |
| q52 | false | - |
| q53 | false | - |
| q54 | false | - |
| q55 | false | - |
| q56 | false | - |
