# Specification: Chat System Bug Fixes

## Problem Statement

The Document Q&A Assistant's chat system has 12 verified defects across message rendering, memory management, thread safety, and error handling. The primary symptom is: **chat messages from the LLM stream to the chat window but are cleared on completion** — tokens appear during streaming but permanently disappear when the LLM finishes. Secondary issues include stale widget references after clearing, unbounded memory growth, and missing error handling safeguards.

## Constraints

- Python 3.x, customtkinter GUI, Windows 11
- Threading model: worker thread runs `engine.query()`, main thread runs message processor and all UI operations
- Communication channel: `queue.Queue` between worker and main thread
- No external network or API changes required

---

## User Scenarios

### US-1: Ask a question and see the complete answer
**Given** the user has a question and the LLM is loaded
**When** the user submits the question
**Then** tokens stream into a visible message bubble as they arrive
**And** when the LLM finishes, the complete answer remains permanently visible in the chat history

### US-2: Clear chat during an active streaming operation
**Given** the user is streaming an LLM response
**When** the user clicks Clear (or Ctrl+L)
**Then** all message widgets including the in-progress streaming bubble are destroyed
**And** the streaming state (`_streaming_message_ref`, `_streaming_message_frame`) is fully reset
**And** the next query starts from a clean state

### US-3: Ask many questions in a long session
**Given** the user asks dozens of questions over an extended session
**When** the session has been running for a long time
**Then** old messages beyond a reasonable window are pruned from the UI
**And** the application remains responsive without unbounded widget accumulation

### US-4: Handle a large LLM response gracefully
**Given** the LLM produces a very long answer
**When** tokens are streamed
**Then** memory usage remains bounded and the UI does not freeze
**And** the message renders correctly with word wrapping

### US-5: Cancel a query mid-stream
**Given** the user presses Escape or Cancel during streaming
**When** the cancellation is processed
**Then** the streaming frame is destroyed
**And** no stale references remain
**And** no partial message bubble appears in the chat

### US-6: Close the application during an active operation
**Given** the user closes the window while a query is running
**When** the close is confirmed
**Then** the message processor loop exits cleanly
**And** no background callbacks fire after the window is destroyed

---

## Functional Requirements

### FR-001: Assistant messages persist after streaming
The assistant message bubble rendered during streaming MUST remain permanently visible in the chat history after the LLM completes, without any user action required. The message is rendered via `_add_message("assistant", content, sources, timestamp)` after the streaming frame is finalized.

### FR-002: Clear chat resets all streaming state
The `_do_clear_chat()` function MUST reset `_streaming_message_ref` and `_streaming_message_frame` to `None` in addition to destroying chat frame widgets. After clearing, subsequent queries must behave as if the streaming system is in its initial clean state.

### FR-003: Chat history UI is bounded
The chat frame MUST NOT grow unboundedly. When a new message is added, messages beyond a configurable retention window (default: 50 messages total, 100 user+assistant pairs) MUST be pruned from the UI. This applies only to the widget tree, not to `conversation_history`.

### FR-004: Malformed queue messages are handled safely
The message processor MUST validate the structure of queue tuples before accessing indices. If a malformed message is received, it MUST be logged and skipped without crashing the processor.

### FR-005: TOCTOU race on cancellation is eliminated
The token queuing path MUST use atomic synchronization so that no token can be queued after a cancellation event is set. If a token is already in the queue when cancellation occurs, it MUST be discarded by the main thread guard.

### FR-006: Message processor has a shutdown mechanism
The message processor loop (running via `self.after`) MUST check a shutdown flag on each iteration and exit cleanly when the application is closing, preventing callbacks on destroyed widgets.

### FR-007: Exception handlers log rather than silently swallow
All bare `except Exception: pass` blocks in stream handlers MUST be replaced with error logging so that genuine failures are visible for debugging.

---

## Success Criteria

### SC-001: End-to-end streaming message persistence
After a complete query (non-cancelled), the assistant's complete answer appears as a permanent message bubble in the chat UI. It is still visible after a second query is submitted.

### SC-002: Clear during streaming leaves no stale refs
After clicking Clear during an active streaming operation, `_streaming_message_ref is None` and `_streaming_message_frame is None`. A subsequent query succeeds without errors.

### SC-003: Memory bounded over long sessions
After 100+ queries, the chat frame contains no more than the retention window's worth of message widgets. Memory usage is stable.

### SC-004: Malformed queue messages do not crash processor
Injecting a malformed tuple (e.g., `("assistant_token",)` without a second element) into the message queue does not crash the application. The processor logs the error and continues.

### SC-005: No tokens processed after cancel
After pressing Escape during streaming, no tokens from the cancelled query appear in any subsequent message. The cancellation is complete.

### SC-006: Application closes cleanly
Closing the application during an active query does not produce any uncaught exceptions or TclError messages in the console.

---

## Key Entities

- `DocumentQAApp` — main GUI application class
- `_ask_question()` — query submission handler
- `_handle_streaming_token()` — per-token UI update
- `_do_clear_chat()` — chat history clearing
- `_start_message_processor()` — main-thread queue consumer
- `stream_end` — queue message type signaling stream completion
- `stream_destroy` — queue message type signaling stream cancellation
- `_streaming_message_ref` / `_streaming_message_frame` — active streaming widget references
- `chat_frame` — scrollable frame containing message bubbles
- `conversation_history` — in-memory LLM context list (already bounded at 20)

---

## Edge Cases and Known Failure Modes

1. **Empty LLM response**: If the LLM returns no tokens, no message bubble should appear and no error should be raised.
2. **Single-token response**: The complete message should appear after streaming ends, even if only one token was generated.
3. **Cancel before any token arrives**: The streaming frame is never created. No cleanup needed.
4. **Cancel after stream_end queued but before processed**: The stream_end handler already handles this gracefully — the guard at `_handle_streaming_token` discards tokens if cancellation is set.
5. **Rapid clear → ask again**: After clearing, immediately asking again must not reuse stale streaming refs.
6. **Session restore**: There is no session persistence — closing the app loses all messages. This is intentional.

---

## Out of Scope

- Changes to the LLM, vector store, or RAG engine
- Changes to the document ingestion pipeline
- Changes to settings or configuration pages
- Changes to the API server
- Changes to the `conversation_history` cap (already 20)
- Session persistence or message saving
- Chat message search or filtering
