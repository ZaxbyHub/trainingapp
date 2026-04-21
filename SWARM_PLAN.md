# UI/UX Modernization
Swarm: lowtier
Phase: 1 [COMPLETE] | Updated: 2026-04-21T19:35:41.882Z

---
## Phase 1: Foundation — theme.py module with design tokens [COMPLETE]
- [x] 1.1: Create theme.py with ColorTokens, TypeScale, Spacing classes. ColorTokens uses @classmethod that reads ctk.get_appearance_mode() to return light/dark adaptive colors. Define: primary(), primary_hover(), secondary(), secondary_hover(), text_on_primary(), text_on_secondary(), bubble_user(), bubble_assistant(), bubble_system(), text_on_bubble(role), source_pill_bg(), danger(). TypeScale returns (FONT_FAMILY, size, weight) tuples: display(24), h1(20), h2(16), h3(14), body(13), caption(11), small(10). Spacing defines 4px-base grid: XS=2, SM=4, MD=8, LG=12, XL=16, XXL=20, XXXL=24, SECTION=32 plus compound presets. Import theme in app_gui.py replacing local FONT_FAMILY. [MEDIUM]
- [x] 1.2: Migrate 4 button color sets in app_gui.py to use ColorTokens: Ask button → primary()/primary_hover()/text_on_primary(); Clear button → secondary()/secondary_hover()/text_on_secondary(); Settings Cancel → same as Clear; Settings Save → primary()/primary_hover()/text_on_primary(). Also add text_color to all CTkButton calls that currently omit it. [SMALL] (depends: 1.1)
- [x] 1.3: Migrate 3 chat bubble colors in _add_message() to ColorTokens.bubble_user()/bubble_assistant()/bubble_system(). Add text_color=ColorTokens.text_on_bubble(role) to message labels. This is color migration only — no role header or timestamp changes in this task. [SMALL] (depends: 1.1)
- [x] 1.4: Add role header row with timestamp to _add_message(). Remove role prefix from content string. Add CTkLabel header showing role name ('You'/'Assistant'/'System') and timestamp in small muted font. Update _add_message() signature to accept timestamp parameter. Update all callers of _add_message() to pass timestamp. [SMALL] (depends: 1.3)
- [x] 1.5: Normalize all inline font tuples in app_gui.py to use TypeScale constants: H1 for section headers, H2 for subsection headers, body for content, caption for labels, small for timestamps. Remove local FONT_FAMILY from app_gui.py — import from theme. [SMALL] (depends: 1.1)
- [x] 1.6: Replace all inline spacing values (padx, pady, pad, ipadx, ipady) with Spacing constants throughout app_gui.py. Focus on: Settings dialog frame padding, button frame padding, chat message padding, input area padding. [SMALL] (depends: 1.1)
- [x] 1.7: Verify light-mode rendering by running app_gui.py with CTK_APPEARANCE_MODE=light or toggling system appearance. Check all migrated elements: buttons, chat bubbles, status labels. Fix any remaining hardcoded colors that were missed. [SMALL] (depends: 1.2, 1.3, 1.4, 1.5, 1.6)

---
## Phase 2: Interaction fixes — keyboard shortcuts, typing indicator, clear confirmation [COMPLETE]
- [x] 2.1: Add <Return> key binding to question_entry that calls _ask_question(). Keep existing Ctrl+Return binding. Add <Escape> binding that clears input field when _is_operation_active is False, or cancels operation when True. [SMALL]
- [x] 2.2: Move thinking indicator from status bar to inline chat bubble. Create _create_typing_indicator() that appends a CTkFrame with animated dots inside chat area. _ask_question() calls _show_typing_indicator() before thread start. Response handler calls _hide_typing_indicator() which destroys the frame. Status bar no longer overwritten. Rename _start_thinking_animation/_stop_thinking_animation to _show_typing_indicator/_hide_typing_indicator. [MEDIUM] (depends: 1.1)
- [x] 2.3: Replace messagebox.askyesno() clear chat confirmation with inline 3-second confirm pattern. clear_button text changes to 'Confirm?' in danger color on first click. Second click within 3s clears chat. Timeout reverts button. Use self.after(3000, callback). Cancel timer on window close. [SMALL]
- [x] 2.4: Standardize all CTkSwitch widgets to use the text= parameter instead of separate CTkLabel widgets. Hybrid search switch: text='Enable Hybrid Search'. Reranking switch: text='Enable Reranking'. Remove the separate label widgets that precede these switches. [SMALL]

---
## Phase 3: Layout and responsive behavior [COMPLETE]
- [x] 3.1: Implement dynamic wraplength for chat messages. Add _get_wraplength() method that returns chat_frame.winfo_width() - 80 with fallback. Bind chat_frame to <Configure> event calling _on_chat_resize(). Store _last_chat_width to avoid redundant updates. New messages use calculated wraplength. [SMALL]
- [x] 3.2: Add _create_empty_state() method showing: document icon, 'No documents yet' heading (TypeScale.h2), descriptive subtext (TypeScale.body, muted), sample questions as clickable CTkButtons, prominent 'Ingest Documents' button. Show when document count is 0. Hide when documents ingested. [MEDIUM] (depends: 1.1)
- [x] 3.3: Implement threading.Event-based operation cancellation. Add _operation_cancelled = threading.Event() in __init__. Set event in _cancel_operation(). Worker threads check is_set() in their loops. Add cancel button next to progress bar during ingest/query. Completion handlers check event state. Keep _is_operation_active boolean for UI state only. [MEDIUM]

---
## Phase 4: Settings expansion and source improvements [COMPLETE]
- [x] 4.1: Add 6 missing RAGConfig fields to SettingsDialog in logical groups. Model Settings: rag_embedding_model (read-only display), rag_reranker_model (read-only display). Search Settings: rag_chunk_overlap (CTkEntry, int validation), rag_min_similarity (CTkEntry, float 0-1). Advanced: rag_context_truncation (CTkEntry, int). Database: rag_db_path (CTkEntry + Browse). Each new field gets placeholder_text AND tooltip. Update _populate_fields() and _save() with exact field names. [MEDIUM]
- [x] 4.2: Replace plain-text source citation rendering in _add_message() with interactive source pills. Each source becomes a CTkFrame badge with document filename (truncated to 30 chars + ellipsis). On click: expand inline card showing relevant text snippet. Use ColorTokens.source_pill_bg() for background. Cursor changes to hand2 on hover. [MEDIUM] (depends: 1.1)
- [x] 4.3: Create CTkTooltip class using CTkToplevel for settings field hints. Apply to: chunk_size, n_results, max_tokens, temperature, hybrid_search, reranking, retrieval_window, initial_top_k, rerank_top_k. Tooltip appears after 500ms hover delay. Uses theme colors and TypeScale.small() font. [SMALL]

---
## Phase 5: Polish, consistency, and test updates [PENDING]
- [x] 5.1: Standardize border_width on all _make_button calls: Save, Cancel, Ingest, Ask, Clear all use consistent border_width value. Document the chosen standard. [SMALL]
- [x] 5.2: Add placeholder_text to existing settings CTkEntry widgets that lack it. Scope: only pre-4.1 fields (model path, chunk_size, n_results, max_tokens, temperature, hybrid_search, reranking, retrieval_window, initial_top_k, rerank_top_k). New fields added in 4.1 already have placeholder_text per 4.1 acceptance criteria. [SMALL]
- [x] 5.3: Update test files that assert hardcoded hex color values. test_keyboard_shortcuts_styling.py asserts fg_color='#1a73e8', '#444444', '#1557b0', '#555555' — update these to use ColorTokens.primary(), ColorTokens.secondary() etc. Verify all color assertions use tokens instead of hex literals. [MEDIUM] (depends: 1.2)
- [ ] 5.4: Verify all 18 audit findings are addressed. Run through each finding from the audit report and confirm implementation. Generate a verification checklist showing each finding ID (CR-1, CR-2, H-1 through H-4, M-1 through M-9, L-1 through L-3) and its implementation status. [SMALL] (depends: 1.7, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3)
