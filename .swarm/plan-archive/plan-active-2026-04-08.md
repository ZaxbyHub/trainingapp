<!-- PLAN_HASH: 1vsf2gautil03 -->
# Comprehensive Codebase QA Review — AI-Hardened Edition v5.1
Swarm: paid
Phase: 1 [IN PROGRESS] | Updated: 2026-04-09T02:12:32.348Z

---
## Phase 1: Phase 0: Codebase Inventory and Mental Map [IN PROGRESS]
- [x] 1.1: Read root directory listing and identify all top-level folders [SMALL]
- [ ] 1.2: Read dependency manifests (requirements.txt, package.json, etc.) and catalog all dependencies with versions [SMALL] ← CURRENT
- [ ] 1.3: Read README.md, ARCHITECTURE.md, USAGE.md and extract all user-facing claims [MEDIUM]
- [ ] 1.4: Read CI/CD workflows (.github/workflows/) and identify public surfaces and trust boundaries [MEDIUM]
- [ ] 1.5: Produce mental map: tech stack, directory layout, public surface inventory, trust boundary inventory, estimated file count [MEDIUM]

---
## Phase 2: Phase 1: Serial-Batched Explorer Candidate Generation [IN PROGRESS]
- [ ] 2.1: Dispatch Config & Infrastructure explorer subagent for dotfiles, CI/CD, Dockerfiles, lockfiles [MEDIUM]
- [ ] 2.2: Dispatch Batch 1: Core source files explorer (max 20 files) for Check Groups 1-3 [LARGE]
- [ ] 2.3: Dispatch Batch 2: Core source files explorer (max 20 files) for Check Groups 4-6 [LARGE]
- [ ] 2.4: Dispatch Batch 3: Core source files explorer (max 20 files) for Check Groups 7-9 [LARGE]
- [ ] 2.5: Dispatch Test files explorer for test quality analysis (Check Group 8) [LARGE]
- [ ] 2.6: Dispatch Documentation explorer for claim verification (Check Group 4) [MEDIUM]
- [ ] 2.7: Dispatch Cross-Boundary explorer with accumulated findings for contract/integration seam checks [MEDIUM]

---
## Phase 3: Phase 2: Candidate Validation and Inline Routing [IN PROGRESS]
- [ ] 3.1: Dispatch Reviewer Batch 1: Validate Config & Infrastructure candidates [LARGE]
- [ ] 3.2: Dispatch Inline Critic for CRITICAL/HIGH from Config Reviewer Batch 1 [MEDIUM]
- [ ] 3.3: Dispatch Reviewer Batch 2: Validate Core Source Batch 1 candidates [LARGE]
- [ ] 3.4: Dispatch Inline Critic for CRITICAL/HIGH from Source Batch 1 [MEDIUM]
- [ ] 3.5: Dispatch Reviewer Batch 3: Validate Core Source Batch 2 candidates [LARGE]
- [ ] 3.6: Dispatch Inline Critic for CRITICAL/HIGH from Source Batch 2 [MEDIUM]
- [ ] 3.7: Dispatch Reviewer Batch 4: Validate Core Source Batch 3 candidates [LARGE]
- [ ] 3.8: Dispatch Inline Critic for CRITICAL/HIGH from Source Batch 3 [MEDIUM]
- [ ] 3.9: Dispatch Reviewer Batch 5: Validate Test candidates [LARGE]
- [ ] 3.10: Dispatch Inline Critic for CRITICAL/HIGH from Test Reviewer [MEDIUM]
- [ ] 3.11: Dispatch Reviewer Batch 6: Validate Documentation candidates [MEDIUM]
- [ ] 3.12: Dispatch Inline Critic for CRITICAL/HIGH from Doc Reviewer [SMALL]
- [ ] 3.13: Dispatch Reviewer Batch 7: Validate Cross-Boundary candidates [MEDIUM]
- [ ] 3.14: Dispatch Inline Critic for CRITICAL/HIGH from Cross-Boundary Reviewer [SMALL]

---
## Phase 4: Phase 3: Evidence Persistence and Formatting [IN PROGRESS]
- [ ] 4.1: Persist all explorer candidate findings as qa_candidate_findings evidence bundles [MEDIUM]
- [ ] 4.2: Persist all reviewer validation results as qa_validated_findings evidence bundles [MEDIUM]
- [ ] 4.3: Persist all critic results as qa_critic_results evidence bundles [MEDIUM]
- [ ] 4.4: Verify all CRITICAL/HIGH candidates have disprove_attempt fields, downgrade any missing [SMALL]

---
## Phase 5: Phase 4: Architect Synthesis [PENDING]
- [ ] 5.1: Load and deduplicate all qa_candidate_findings, qa_validated_findings, qa_critic_results [MEDIUM]
- [ ] 5.2: Drop all DISPROVED and OVERTURNED findings from main report set [SMALL]
- [ ] 5.3: Cluster confirmed findings by AI failure mode pattern [MEDIUM]
- [ ] 5.4: Build claim ledger: supported, partially_supported, unsupported, contradicted, stealth_change [MEDIUM]
- [ ] 5.5: Count findings by check group (1-9) and severity (CRITICAL/HIGH/MEDIUM/LOW/INFO) [SMALL]
- [ ] 5.6: Count validation outcomes: confirmed, disproved, unverified, pre_existing [SMALL]
- [ ] 5.7: Count inline critic outcomes: upheld, refined, downgraded, overturned [SMALL]
- [ ] 5.8: Count inline reviewer finalization outcomes: finalized, downgraded [SMALL]

---
## Phase 6: Phase 5: Final Report Generation [IN PROGRESS]
- [ ] 6.1: Generate qa-report.md with executive summary and findings count table [MEDIUM]
- [ ] 6.2: Document all CRITICAL findings with full detail in report [MEDIUM]
- [ ] 6.3: Document all HIGH findings with full detail in report [MEDIUM]
- [ ] 6.4: Document all MEDIUM findings with full detail in report [MEDIUM]
- [ ] 6.5: Document all LOW/INFO findings (condensed) in report [SMALL]
- [ ] 6.6: Document pre-existing findings section in report [SMALL]
- [ ] 6.7: Document unsupported/contradicted claims section in report [SMALL]
- [ ] 6.8: Document stealth changes section in report [SMALL]
- [ ] 6.9: Document dominant AI failure modes section in report [SMALL]
- [ ] 6.10: Document supply chain and dependency notes in report [SMALL]
- [ ] 6.11: Document coverage notes section in report [SMALL]
- [ ] 6.12: Document validation notes with all statistics in report [SMALL]
- [ ] 6.13: Document recommended remediation order in report [SMALL]
