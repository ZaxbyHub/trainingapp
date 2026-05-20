<!-- PLAN_HASH: eew1vp4qu6kc -->
# Chat System Bug Fixes
Swarm: modelrelay
Phase: 1 [PENDING] | Updated: 2026-05-20T01:17:52.241Z

---
## Phase 1: Checkpoint + Fix streaming message persistence (DD-001) [PENDING]
- [ ] 0.1: Create git checkpoint before Phase 1. Use checkpoint tool to save named snapshot 'pre-chat-fixes'. This provides rollback if the streaming hot path changes introduce regressions. [SMALL]
- [ ] 1.1: Fix stream_end to call _add_message before destroying streaming frame. When the LLM completes, read the accumulated text from _streaming_message_ref, call _add_message('assistant', text, sources=None, timestamp=timestamp) to create a permanent bubble, THEN destroy the streaming frame. Add _streaming_finalized: bool flag initialized False in _create_chat_page. Set it True in stream_end handler after calling _add_message. Check it at the start of _handle_streaming_token to guard against double-finalization. In the exception path, use stream_destroy (not stream_end) so _add_message is called before cleanup. Key changes: (1) stream_end handler: read ref text → _add_message → set _streaming_finalized=True → destroy frame. (2) exception path: put stream_destroy not stream_end. (3) _handle_streaming_token: early return if _streaming_finalized is True. [MEDIUM] (depends: 0.1)

---
## Phase 2: Reset streaming refs on clear (DD-002) [PENDING]
- [ ] 2.1: Add self._streaming_finalized = False to _do_clear_chat. After destroying all chat_frame children and clearing _expanded_pills and _snippet_frame_* attrs, also set self._streaming_message_ref = None, self._streaming_message_frame = None, and self._streaming_finalized = False. This ensures subsequent queries start from clean streaming state even if Clear was clicked mid-stream. [SMALL] (depends: 1.1)

---
## Phase 3: Bound chat history UI growth (DD-006) [PENDING]
- [ ] 3.1: Add automatic pruning of old messages in _add_message. Before packing a new message frame, count widgets in chat_frame.winfo_children(). If count exceeds MAX_CHAT_WIDGETS (set to 50, approximately 25 user+assistant message pairs — bounding UI memory to ~5MB for typical messages), destroy the oldest 10 widgets before adding the new one. This prevents unbounded memory growth in long sessions while keeping recent conversation visible. [SMALL] (depends: 1.1)

---
## Phase 4: Message processor safety (DD-004, DD-010) [PENDING]
- [ ] 4.1: Add schema validation to message processor. For each msg type branch, validate len(msg) before accessing msg[1], msg[2]. If validation fails, log a warning and continue: logger.warning('Malformed queue message: %r', msg). This prevents IndexError crashes from malformed tuples without crashing the processor. [SMALL] (depends: 1.1)
- [ ] 4.2: Replace bare 'except Exception: pass' in stream_end handler (app_gui.py ~line 1976) and stream_destroy handler (~line 1986) with 'except Exception as e: logger.warning("stream handler error: %s", e)'. This preserves error visibility for debugging while maintaining the defensive shutdown-race pattern. [SMALL] (depends: 1.1)

---
## Phase 5: Add message processor shutdown flag (DD-007) [PENDING]
- [ ] 5.1: Add self._message_processor_running: bool = True in _create_chat_page. In _start_message_processor loop, check this flag on each iteration and break if False. Set to False in _on_close before calling destroy(). This ensures the loop exits cleanly when the window is closing, preventing callbacks on destroyed widgets. [SMALL] (depends: 1.1)

---
## Phase 6: Run full test suite and verify fixes [PENDING]
- [ ] 6.1: Run pytest tests/ -v with a focus on streaming-related tests. Run: pytest tests/test_app_gui_streaming_callback.py tests/test_app_gui_streaming_task42_retry2.py tests/test_app_gui_streaming_retry.py tests/test_app_gui_chat_widget_memory_cleanup.py tests/test_llm_interface_streaming.py -v. Additionally run full suite: pytest tests/ -v. All tests must pass with zero failures and zero errors. [MEDIUM] (depends: 1.1, 2.1, 3.1, 4.1, 4.2, 5.1)
