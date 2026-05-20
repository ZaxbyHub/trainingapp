# Context
Swarm: modelrelay
Project: Chat System Bug Fixes

## Status
- **Phase**: Planning — spec written, plan pending critic review
- **Spec**: .swarm/spec.md (chat system bug fixes — 12 verified findings)

## Deep Dive Findings Summary
- DD-001 [CRITICAL]: stream_end destroys frame without calling _add_message — messages disappear after streaming
- DD-002 [HIGH]: _do_clear_chat misses _streaming_message_ref/frame reset — stale refs
- DD-003 [MEDIUM]: Exception vs cancel path uses stream_end vs stream_destroy — maintenance hazard
- DD-004 [LOW]: No queue tuple validation — IndexError risk on malformed messages
- DD-005 [LOW]: Unbounded string concatenation — low risk given LLM limits
- DD-006 [MEDIUM]: chat_frame grows unbounded — no auto-pruning
- DD-007 [LOW]: Message processor has no shutdown flag
- DD-008 [REJECTED]: Thread race on _streaming_message_ref — not real
- DD-009 [LOW]: No control character filtering — display artifacts possible
- DD-010 [LOW]: Bare except Exception: pass — masks real errors
- DD-011 [LOW]: TOCTOU race on cancellation — mitigated by main thread guard
- DD-012 [REJECTED]: No lock on _is_operation_active — not needed (tkinter single-threaded)

## Pending QA Gate Selection
- reviewer: true
- test_engineer: true
- sme_enabled: true
- critic_pre_plan: true
- sast_enabled: true
- council_mode: false
- hallucination_guard: false
- mutation_test: false
- council_general_review: false
- drift_check: true
- final_council: true
- recorded_at: 2026-05-19T00:00:00Z

## Pending Parallelization Config
- parallelization_enabled: true
- max_concurrent_tasks: 2
- council_parallel: false
- locked: true
- recorded_at: 2026-05-19T00:00:00Z

## Available Skills
- writing-tests: Guidelines for writing tests (tests/ directory, bun:test framework)
- engineering-conventions: Engineering invariants (src/ directory)

## Agent Activity

| Tool | Calls | Success | Failed | Avg Duration |
|------|-------|---------|--------|--------------|
| read | 13210 | 13163 | 47 | 230ms |
| bash | 7261 | 7233 | 28 | 11797ms |
| grep | 3761 | 3738 | 23 | 7753ms |
| edit | 3735 | 3725 | 10 | 626ms |
| task | 2226 | 2220 | 6 | 144203ms |
| glob | 1827 | 1825 | 2 | 180ms |
| test_runner | 978 | 975 | 3 | 136ms |
| update_task_status | 726 | 726 | 0 | 56ms |
| write | 661 | 652 | 9 | 55635ms |
| search | 461 | 461 | 0 | 14204ms |
| pre_check_batch | 370 | 365 | 5 | 880ms |
| todowrite | 341 | 337 | 4 | 4ms |
| declare_scope | 312 | 312 | 0 | 2ms |
| syntax_check | 256 | 256 | 0 | 61ms |
| invalid | 194 | 194 | 0 | 1ms |
| save_plan | 180 | 180 | 0 | 18ms |
| placeholder_scan | 125 | 125 | 0 | 123ms |
| phase_complete | 123 | 123 | 0 | 2970ms |
| lint | 104 | 104 | 0 | 1367ms |
| skill | 99 | 99 | 0 | 83ms |
| diff | 94 | 94 | 0 | 51ms |
| imports | 78 | 78 | 0 | 313ms |
| write_retro | 74 | 74 | 0 | 13ms |
| check_gate_status | 73 | 73 | 0 | 1ms |
| convene_council | 69 | 69 | 0 | 11ms |
| todo_extract | 68 | 68 | 0 | 3ms |
| retrieve_summary | 57 | 57 | 0 | 3ms |
| write_drift_evidence | 45 | 45 | 0 | 9ms |
| build_check | 37 | 37 | 0 | 1148ms |
| declare_council_criteria | 37 | 37 | 0 | 22ms |
| knowledgeAdd | 30 | 30 | 0 | 9ms |
| symbols | 28 | 28 | 0 | 2ms |
| webfetch | 27 | 27 | 0 | 1098ms |
| knowledge_add | 27 | 27 | 0 | 36ms |
| evidence_check | 16 | 16 | 0 | 31ms |
| secretscan | 16 | 16 | 0 | 674ms |
| batch_symbols | 15 | 15 | 0 | 4ms |
| get_qa_gate_profile | 15 | 15 | 0 | 48ms |
| completion_verify | 14 | 14 | 0 | 2ms |
| sast_scan | 13 | 13 | 0 | 54ms |
| mystatus | 12 | 12 | 0 | 1809ms |
| set_qa_gates | 12 | 12 | 0 | 8ms |
| get_approved_plan | 12 | 12 | 0 | 4ms |
| curator_analyze | 8 | 8 | 0 | 46251ms |
| apply_patch | 6 | 6 | 0 | 182ms |
| write_hallucination_evidence | 6 | 6 | 0 | 33ms |
| sbom_generate | 6 | 6 | 0 | 27ms |
| req_coverage | 6 | 6 | 0 | 7ms |
| write_final_council_evidence | 6 | 6 | 0 | 8ms |
| checkpoint | 3 | 3 | 0 | 11ms |
| gitingest | 3 | 3 | 0 | 16856ms |
| suggest_patch | 3 | 3 | 0 | 2ms |
| diff_summary | 3 | 3 | 0 | 241ms |
| knowledgeRecall | 2 | 2 | 0 | 3ms |
| detect_domains | 2 | 2 | 0 | 2ms |
| complexity_hotspots | 2 | 2 | 0 | 81ms |
| repo_map | 2 | 2 | 0 | 96ms |
| spec_write | 2 | 2 | 0 | 6ms |
| todoread | 1 | 1 | 0 | 6ms |
| pkg_audit | 1 | 1 | 0 | 5ms |
| submit_phase_council_verdicts | 1 | 1 | 0 | 7ms |
| knowledge_query | 1 | 1 | 0 | 7ms |
| web_search | 1 | 1 | 0 | 2559ms |
| skill_inspect | 1 | 1 | 0 | 1ms |
| skill_list | 1 | 1 | 0 | 1ms |
| swarm_command | 1 | 1 | 0 | 1ms |
