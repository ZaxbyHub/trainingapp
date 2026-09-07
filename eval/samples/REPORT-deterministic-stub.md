# Tier-0 Eval Report

- base_url: `http://127.0.0.1:8478`
- timestamp: 2026-09-07T16:13:07+00:00
- label: deterministic-stub
- backend: embedding_model='models\\bge-small-en-v1.5', llm_backend='scripted-eval-stub'
- questions: 56 (in-corpus 50, out-of-corpus 6, errors 0)

## Metrics

| metric | value |
|---|---|
| recall@1 | 0.600 |
| recall@3 | 0.800 |
| recall@5 | 0.800 |
| MRR | 0.697 |
| abstain accuracy | 0.667 (4/6) |
| latency p50 (ms) | 4.2 |
| latency p95 (ms) | 5.7 |
| fallback-phrase answers | 0 |

## Per-category (in-corpus, successful rows)

| category | count | recall@3 | MRR |
|---|---|---|---|
| benefits | 7 | 1.000 | 0.857 |
| compliance | 5 | 1.000 | 0.800 |
| expenses | 5 | 1.000 | 0.900 |
| it-support | 6 | 1.000 | 0.500 |
| policy | 7 | 1.000 | 0.429 |
| safety | 6 | 1.000 | 0.500 |
| security | 7 | 1.000 | 0.714 |
| training-content | 7 | 1.000 | 0.905 |

## Abstain rows (out-of-corpus)

| id | abstained | error |
|---|---|---|
| q51 | true | - |
| q52 | true | - |
| q53 | false | - |
| q54 | false | - |
| q55 | true | - |
| q56 | true | - |
