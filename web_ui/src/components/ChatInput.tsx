/**
 * Message input component with send and cancel functionality.
 * Supports multiline input with auto-resize behavior.
 *
 * Issue #156: the image-attach control was removed with the Gemma 4 + mmproj
 * multimodal surface — the packaged browser LLM (LFM2-1.2B-RAG) is text-only.
 *
 * Issue #267 (keyboard-first composer):
 *   - ArrowUp recalls the newest user message; repeated presses step older,
 *     stopping at the oldest. ArrowDown walks back newer; past the newest it
 *     restores the pre-browse draft (the stash).
 *   - Guard matrix: modifiers, IME composition, non-collapsed selections,
 *     multi-line carets (entering browse from a middle line) and an empty
 *     history leave the value untouched and the event un-prevented; prevent
 *     default only on an actual recall/restore.
 *   - `draftKey` keys the in-memory per-conversation draft store
 *     (lib/chat/draft-store.ts): every displayed-value mutation (hydration on
 *     key switch or remount, edits, recalls, sends) reports through
 *     onDraftChange AND writes the store; browse state resets on every key
 *     switch. The textarea carries `data-chat-composer` so the global
 *     shortcut hook can carve composer-target shortcuts out of its
 *     editable bail-out.
 */

import React, { useRef, useCallback, useState, useEffect, type ReactNode } from 'react';
import { IconButton } from '../ui';
import { getDraft, setDraft, NEW_DRAFT_SENTINEL, moveDraftIfTargetEmpty } from '../lib/chat/draft-store';
import '../pages/chat.css';

interface ChatInputProps {
  onSend: (message: string) => void;
  isLoading: boolean;
  onCancel: () => void;
  disabled?: boolean;
  /** Element id explaining WHY the input is disabled (e.g. the chat
   *  model-loading banner) — wired to aria-describedby on the textarea so
   *  assistive tech announces the gate reason (PRR-229). */
  disabledReasonId?: string;
  /** Notifies the parent of the current draft text so a global shortcut
   *  (Ctrl+Enter) can send it without owning the input state. */
  onDraftChange?: (text: string) => void;
  /** Conversation-scoped recall history (newest LAST; #267 AC1/AC2). */
  history?: string[];
  /** Draft-store key (the conversation id or the new-chat sentinel). The
   *  composer hydrates from the store on every key change/remount and writes
   *  every mutation back (#267 AC7/AC8). */
  draftKey?: string;
  /** The id the parent ADOPTED for the not-yet-created conversation's first
   *  turn (#267 review r2 / COR-1): the sentinel→real-id draft migration fires
   *  only when the incoming draftKey is exactly this id. An arbitrary key
   *  switch away from the sentinel (selecting an existing conversation) must
   *  NOT move the sentinel's draft. */
  adoptedDraftKey?: string;
  /** Optional external handle to the composer textarea (#267 AC5): ChatPage
   *  focuses it for the Ctrl/Cmd+K and '/' shortcuts. */
  textareaRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  /** Status row rendered INSIDE the composer card (Lumen phase 5): the streaming /
   *  model-load indicator. The row collapses when this renders nothing. */
  status?: ReactNode;
}

const MAX_HEIGHT = 150;
const MIN_HEIGHT = 40;

export const ChatInput: React.FC<ChatInputProps> = React.memo(({
  onSend,
  isLoading,
  onCancel,
  disabled = false,
  disabledReasonId,
  onDraftChange,
  history,
  draftKey,
  adoptedDraftKey,
  textareaRef,
  status,
}) => {
  const [value, setValue] = useState('');
  // HTMLTextAreaElement | null (not the bare element type) so the ref object
  // stays MUTABLE — useRef<T>(null) alone yields a read-only RefObject in the
  // React 18 typings, and the merged-ref callback below writes .current.
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Merge the internal ref with the optional external one so both see the
  // same element (focus shortcuts + internal height/caret logic).
  const setTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      internalTextareaRef.current = el;
      if (textareaRef) textareaRef.current = el;
    },
    [textareaRef]
  );
  // #267 browse state: index into `history` while recalling (null = not
  // browsing), plus the stashed pre-browse draft restored by ArrowDown past
  // the newest entry. Refs (not state): the browse position never re-renders.
  const browseIndexRef = useRef<number | null>(null);
  const draftStashRef = useRef('');
  /** Moves the caret to the end once the NEXT value commit lands (recalls). */
  const caretToEndRef = useRef(false);
  // #267 review r1: previous draft key (sentinel-migration trigger) and a
  // mirror of the displayed value (hydrate-caret nit: only jump the caret
  // when the hydrated value actually differs).
  const prevDraftKeyRef = useRef<string | undefined>(undefined);
  // #267 delta review r2: adoption keys already consumed by the sentinel
  // migration — makes the adoption one-shot even if a stale adoptedDraftKey
  // prop lingers after the user leaves the adopted conversation.
  const consumedAdoptionsRef = useRef<Set<string>>(new Set());
  const valueRef = useRef('');
  valueRef.current = value;

  const adjustHeight = useCallback(() => {
    const textarea = internalTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const newHeight = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
    // Height is a measured value (CSSOM, not a style prop); whether the content
    // overflows the cap is a state the stylesheet acts on (pages/chat.css).
    textarea.style.height = `${newHeight}px`;
    textarea.dataset.overflow = textarea.scrollHeight > MAX_HEIGHT ? 'scroll' : 'none';
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // Caret-to-end after a recall: the displayed value is a controlled React
  // value, so the DOM textarea only carries the recalled text after the
  // commit — the selection is moved in the effect that follows it.
  useEffect(() => {
    if (!caretToEndRef.current) return;
    caretToEndRef.current = false;
    const textarea = internalTextareaRef.current;
    if (textarea) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [value]);

  // The auto-resize measures the (placeholder) text, so it must re-measure once the
  // web font is in: measured against the fallback font the placeholder fits on one
  // line, and at narrow widths the composer stays one line tall with the real
  // font's second line clipped. (Which weights are already loaded when the chat
  // mounts depends on what the boot screen rendered, so this is a latent race.)
  // Lazily fetched unicode-range subsets (Greek/Cyrillic/Vietnamese) land after `ready`
  // has resolved, so `loadingdone` re-measures too.
  useEffect(() => {
    // adjustHeight is a no-op once the textarea ref is cleared, so a late-resolving
    // promise after unmount needs no cancel flag.
    void document.fonts?.ready.then(adjustHeight);
    const fonts = document.fonts;
    fonts?.addEventListener?.('loadingdone', adjustHeight);
    return () => fonts?.removeEventListener?.('loadingdone', adjustHeight);
  }, [adjustHeight]);

  // Pasted text can need glyphs whose font has not loaded yet: re-measure once it has.
  const handlePaste = useCallback(() => {
    void document.fonts?.ready.then(adjustHeight);
  }, [adjustHeight]);

  // Focus restoration: sending a message disables the textarea (isLoading),
  // which drops focus to <body>. When generation ends and the textarea
  // re-enables, move focus back so keyboard users aren't stranded on body.
  useEffect(() => {
    if (!isLoading) {
      internalTextareaRef.current?.focus();
    }
  }, [isLoading]);

  // #267 (AC27): hydrate the displayed draft from the store on mount AND on
  // every draftKey switch, and reset the browse state on every switch (the
  // recalled history is conversation-scoped). This is a displayed-value
  // mutation: it reports through onDraftChange so the parent's draft mirror
  // never holds the previous conversation's text.
  useEffect(() => {
    browseIndexRef.current = null;
    draftStashRef.current = '';
    // #267 (AC27, review round 1): the sentinel-migration owner lives HERE,
    // inside the composer's key-switch handler (not in ChatPage): the first
    // turn of a new conversation adopts its real id in the parent, the
    // composer sees the key change, and the sentinel's draft travels to the
    // adopted id before hydration. Review round 2 (COR-1): the migration is
    // gated on an EXPLICIT adoption signal — the parent sets adoptedDraftKey
    // to the adopted id in the same batched update as the draftKey switch —
    // so switching from the sentinel to any OTHER key (selecting an existing
    // conversation) leaves the sentinel's draft where it is. The adoption is
    // ONE-SHOT per adopted key (delta review r2): once consumed, a stale
    // adoptedDraftKey prop can never re-trigger the move — after New chat,
    // re-selecting the previously adopted conversation must not pull the new
    // sentinel draft into it. Pinned by ChatInput.drafts.test.tsx — deleting
    // this call turns the carry leg RED.
    const prevKey = prevDraftKeyRef.current;
    if (
      prevKey !== undefined &&
      prevKey !== draftKey &&
      prevKey === NEW_DRAFT_SENTINEL &&
      draftKey !== undefined &&
      draftKey === adoptedDraftKey &&
      !consumedAdoptionsRef.current.has(draftKey)
    ) {
      moveDraftIfTargetEmpty(prevKey, draftKey);
      consumedAdoptionsRef.current.add(draftKey);
    }
    prevDraftKeyRef.current = draftKey;
    const stored = draftKey !== undefined ? (getDraft(draftKey) ?? '') : '';
    setValue(stored);
    if (stored !== valueRef.current) {
      caretToEndRef.current = true;
    }
    onDraftChangeRef.current?.(stored);
    if (draftKey !== undefined) setDraft(draftKey, stored);
    // draftKey alone: a key switch is exactly the hydration trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // onDraftChange identity is unstable across parent renders; read it through
  // a ref so the hydration effect above does not re-run for it.
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;

  /**
   * Set the DISPLAYED value and mirror every mutation (#267): the parent's
   * onDraftChange and (when keyed) the draft store.
   */
  const setDisplayed = useCallback((text: string) => {
    setValue(text);
    onDraftChangeRef.current?.(text);
    if (draftKeyRef.current !== undefined) setDraft(draftKeyRef.current, text);
  }, []);

  // draftKey through a ref for the same reason as onDraftChange.
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;

    onSend(trimmed);
    // A sent turn clears the draft everywhere it is mirrored (#267 AC27).
    browseIndexRef.current = null;
    draftStashRef.current = '';
    setDisplayed('');

    // Reset textarea height
    if (internalTextareaRef.current) {
      internalTextareaRef.current.style.height = 'auto';
    }
  }, [value, isLoading, onSend, setDisplayed]);

  /**
   * #267 (AC1-AC3): history recall. Called AFTER the IME guard and BEFORE
   * the Enter branches; acts only on plain arrows with a collapsed
   * selection; preventDefault happens ONLY on an actual recall/restore.
   */
  const handleHistoryNavigation = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (!history || history.length === 0) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const textarea = e.currentTarget;
      if (textarea.selectionStart !== textarea.selectionEnd) return;

      if (e.key === 'ArrowUp') {
        if (browseIndexRef.current === null) {
          // Entering browse: the caret must be on the FIRST line — ArrowUp in
          // the middle of a multi-line draft moves the caret, it must not
          // blow the draft away.
          const beforeCaret = value.slice(0, textarea.selectionStart ?? 0);
          if (beforeCaret.includes('\n')) return;
          browseIndexRef.current = history.length - 1;
          draftStashRef.current = value;
        } else if (browseIndexRef.current > 0) {
          browseIndexRef.current -= 1;
        } else {
          return; // already at the oldest entry: nothing more to recall
        }
        e.preventDefault();
        setDisplayed(history[browseIndexRef.current] ?? '');
        caretToEndRef.current = true;
        return;
      }

      // ArrowDown: meaningful only while browsing; otherwise the native
      // caret move stands.
      if (browseIndexRef.current === null) return;
      e.preventDefault();
      if (browseIndexRef.current < history.length - 1) {
        browseIndexRef.current += 1;
        setDisplayed(history[browseIndexRef.current] ?? '');
      } else {
        // Past the newest: restore the pre-browse draft (#267 AC2).
        browseIndexRef.current = null;
        setDisplayed(draftStashRef.current);
        draftStashRef.current = '';
      }
      caretToEndRef.current = true;
    },
    [history, value, setDisplayed]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME composition guard: when the user is mid-composition (CJK/Vietnamese
      // input methods), Enter confirms a candidate — it must NOT send the
      // message, and the recall arrows must not steal candidate navigation.
      // Checked before any Enter/recall logic.
      if (
        (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        e.nativeEvent.isComposing
      ) {
        return;
      }
      // #267: recall arrows run after the IME guard, before the Enter branches.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        handleHistoryNavigation(e);
        return;
      }
      // Enter (no Shift): send. Ctrl/Cmd+Enter also sends — the global
      // useKeyboardShortcuts handler bails on TEXTAREA targets, so without
      // handling Ctrl/Cmd+Enter here it would do nothing while the input is
      // focused (the primary "send from chat input" case, AC6). The first
      // branch already covers plain Ctrl/Cmd+Enter (shiftKey is false); the
      // else-if extends send to Shift+Ctrl/Cmd+Enter so the modifier wins over
      // the "Shift+Enter = newline" reading. (PR #28 PRR-002)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, handleHistoryNavigation]
  );

  const handleClear = useCallback(() => {
    // Editing (or clearing) ends browse mode.
    browseIndexRef.current = null;
    draftStashRef.current = '';
    setDisplayed('');
    // Keep the parent's draft mirror in sync so a subsequent Ctrl+Enter
    // (global shortcut, focus outside the textarea) doesn't send stale text.
    // (PR #28 PRR-007)
    internalTextareaRef.current?.focus();
  }, [setDisplayed]);

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  const sendDisabled = !value.trim() || disabled;

  return (
    <div className="chat-composer">
      <div className="chat-composer__card" data-loading={isLoading || undefined}>
        <div className="chat-composer__row">
          <textarea
            ref={setTextarea}
            className="chat-composer__input"
            // #267 (AC5/AC6): marks this textarea as the chat composer so the
            // global shortcut hook's editable bail-out can carve out the
            // composer-aware shortcuts (Ctrl/Cmd+Shift+L, Ctrl/Cmd+,).
            data-chat-composer="true"
            value={value}
            onChange={(e) => {
              // Editing ends browse mode (#267 AC3).
              browseIndexRef.current = null;
              draftStashRef.current = '';
              setDisplayed(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
            disabled={isLoading || disabled}
            rows={1}
            aria-label="Message input"
            aria-describedby={disabledReasonId}
          />
          {value && !isLoading && (
            <IconButton
              icon="x"
              iconSize={18}
              variant="ghost"
              tooltipPlacement="top"
              className="chat-composer__clear"
              onClick={handleClear}
              aria-label="Clear input"
            />
          )}
          {isLoading ? (
            <IconButton
              icon="square"
              iconSize={16}
              variant="secondary"
              tooltipPlacement="top"
              className="chat-composer__stop"
              onClick={handleCancel}
              aria-label="Stop generation"
            />
          ) : (
            <IconButton
              icon="arrow-up"
              variant="primary"
              tooltipPlacement="top"
              className="chat-composer__send"
              onClick={handleSubmit}
              disabled={sendDisabled}
              aria-disabled={sendDisabled || undefined}
              aria-label="Send message"
            />
          )}
        </div>
        {/* Status row inside the card (streaming / model-load progress). Hidden by
            CSS (:empty) when the status element renders nothing. */}
        <div className="chat-composer__status">{status}</div>
      </div>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
