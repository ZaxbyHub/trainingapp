# State Architecture Map — Document Q&A Chat Application

**Phase:** 5 (Final Council Remediation)
**Generated:** 2026-06-27
**Author:** Docs Agent (documentation sync)

> This document reflects the implemented state architecture after Phase 5 completion. The `useConversations` hook is fully implemented with persistence error surfacing. All components use consistent design tokens.

---

## 1. Current State Architecture

### 1.1 State Variables in ChatPage (ChatPage.tsx)

| Variable | Type | Initialization | Purpose |
|----------|------|----------------|---------|
| `messages` | `ChatMessage[]` | `useState<ChatMessage[]>([])` | Stores all chat messages (user + assistant) |
| `isLoading` | `boolean` | `useState(false)` | Controls loading indicator, input disabled state |
| `clearConfirmState` | `'idle' \| 'confirming'` | `useState<'idle' \| 'confirming'>('idle')` | Two-click clear confirmation UX |
| `tokenStreamManagerRef` | `TokenStreamManager \| null` | `useRef<TokenStreamManager \| null>(null)` | Active stream manager reference |
| `abortControllerRef` | `AbortController \| null` | `useRef<AbortController \| null>(null)` | Abort signal for RAG pipeline |
| `clearTimeoutRef` | `ReturnType<typeof setTimeout> \| null` | `useRef<ReturnType<typeof setTimeout> \| null>(null)` | Auto-dismiss clear confirmation |
| `lastTurnRef` | `{ text: string; images?: AttachedImage[] } \| null` | `useRef<{ text: string; images?: AttachedImage[] } \| null>(null)` | Preserves last user turn for Regenerate |

### 1.2 Context State (InferenceModeContext)

Provided via `useInferenceMode()` hook:

| State Field | Type | Source | Persistence |
|-------------|------|--------|-------------|
| `mode` | `'browser-local' \| 'api'` | Local state | `localStorage` key `'inference-mode'` |
| `browserEngine` | `BrowserEngine` (`'wllama' \| 'webllm'`) | Local state | `localStorage` |
| `ragPreset` | `'fast' \| 'balanced' \| 'quality'` | Local state | `localStorage` |
| `isModelReady` | `boolean` | Set by readiness gate | Not persisted |
| `isServerConnected` | `boolean` | `checkServerConnectivity()` | Not persisted |
| `modelLoadingProgress` | `number` (0-100) | Model load callbacks | Not persisted |
| `serverUrl` | `string` | Local state | `localStorage` |
| `modeError` | `string \| null` | Error states | Not persisted |

### 1.3 Derived State (Computed from Context)

```typescript
const isBrowserMode = mode === 'browser-local';
const isModelBlocked = isBrowserMode && !isModelReady;
const isInputDisabled = isLoading || isModelBlocked;
const canAttachImages = isBrowserMode && browserEngine === 'wllama' && isModelReady;
```

### 1.4 Data Flow Diagram

```
User Input (ChatInput)
       │
       ▼
handleSend(text, images?)
       │
       ├─► lastTurnRef.current = { text, images }  (for Regenerate)
       │
       ├─► setMessages([...prev, userMessage, assistantPlaceholder])
       │         │
       │         ▼
       │    ChatMessageList renders messages
       │
       ├─► setIsLoading(true)
       │
       └─► runGeneration(text, images, assistantMessageId)
                  │
                  ├─► mode === 'api'
                  │         │
                  │         ▼
                  │    TokenStreamManager.startSSEStream(url, { question: text })
                  │         │
                  │         ▼
                  │    SSEStreamConsumer → pushToken() → RAF-batched flush
                  │         │
                  │         ▼
                  │    setMessages(map msg.content += token)
                  │
                  └─► mode === 'browser-local'
                            │
                            ▼
                       RAGOrchestrator.query(text, { images? })
                            │
                            ▼
                       for await (event of orchestrator.query(...)) {
                         case 'token': streamManager.pushToken(event.data)
                         case 'complete': streamManager.complete({ sources, ... })
                         case 'error': streamManager.error(message)
                       }
```

---

## 2. Message Lifecycle

### 2.1 Message Creation (handleSend)

1. **User message creation:**
   ```typescript
   const userMessage: ChatMessage = {
     id: generateId(),
     role: 'user',
     content: text,
     timestamp: Date.now(),
     images: attachedImages?.map(img => ({ id, dataUrl, mimeType, fileName })),
   };
   ```

2. **Assistant placeholder creation:**
   ```typescript
   const assistantMessage: ChatMessage = {
     id: assistantMessageId,
     role: 'assistant',
     content: '',
     timestamp: Date.now(),
     isStreaming: true,
   };
   ```

3. **Atomic append** (prevents race with streaming updates):
   ```typescript
   setMessages((prev) => {
     const appended = [...prev, userMessage, assistantMessage];
     // MAX_MESSAGES=200 pruning with hidden-messages-indicator
     return appended;
   });
   ```

### 2.2 Message States

| State | Fields | Description |
|-------|--------|-------------|
| User | `id, role='user', content, timestamp, images?` | Complete on creation |
| Assistant (streaming) | `id, role='assistant', content='', timestamp, isStreaming=true` | Empty content, streaming flag |
| Assistant (complete) | `id, role='assistant', content, timestamp, sources?, isStreaming=false` | Final content + sources |
| Assistant (error) | `id, role='assistant', content, timestamp, isStreaming=false` | Content with `[Error: ...]` appended |
| Hidden indicator | `id='hidden-messages-indicator', role='system'` | Pruning notice when >200 messages |

### 2.3 Message Pruning (MAX_MESSAGES=200)

When `messages.length > MAX_MESSAGES`:
- Earliest messages are dropped
- A `hidden-messages-indicator` system message is prepended showing the count

### 2.4 Regenerate Flow (handleRegenerate)

Uses `messagesForRegenerate()` helper:
1. Truncates messages after last user message
2. Appends new assistant placeholder
3. Re-runs `runGeneration()` with preserved `lastTurnRef`

---

## 3. Streaming Data Flow (Token-by-Token)

### 3.1 TokenStreamManager Architecture

```typescript
class TokenStreamManager {
  private tokenBuffer: string[];      // RAF batching buffer
  private flushTimer: number | null;  // RAF handle
  private tokenCallback: TokenCallback | null;
  private doneCallback: DoneCallback | null;
  private errorCallback: ErrorCallback | null;
  private activeConsumer: SSEStreamConsumer | null;
  private cancelled: boolean;
}
```

### 3.2 Streaming Path: API Mode

```
SSEStreamConsumer (lib/api/streaming.ts)
    │ onToken(token) → pushToken(token)
    ▼
TokenStreamManager.pushToken(token)
    │ Buffer token, schedule RAF flush if not already scheduled
    ▼
requestAnimationFrame → flushBuffer()
    │ Join buffer, clear buffer
    ▼
tokenCallback(token) → setMessages(map content += token)
    │
    ▼
ChatMessageList re-renders with updated content
```

### 3.3 Streaming Path: Browser-Local Mode

```
RAGOrchestrator.query() → AsyncGenerator<RAGEvent>
    │
    ├─ 'retrieving' → embedding + search
    ├─ 'retrieved' → RRF fusion
    ├─ 'reranking' → optional reranking
    ├─ 'generating' → LLM streaming begins
    │
    ▼ for await (event of orchestrator.query(...))
    case 'token': streamManager.pushToken(event.data)
    case 'complete': streamManager.complete({ sources, contextLength, inferenceTime })
    case 'error': streamManager.error(event.data.message)
```

### 3.4 Completion Handling (onDone callback)

```typescript
streamManager.onDone((data) => {
  setMessages((prev) =>
    prev.map((msg) =>
      msg.id === assistantMessageId
        ? { ...msg, isStreaming: false, sources: data.sources }
        : msg
    )
  );
  setIsLoading(false);
  tokenStreamManagerRef.current = null;
});
```

### 3.5 Error Handling (onError callback)

```typescript
streamManager.onError((errorMessage) => {
  setMessages((prev) =>
    prev.map((msg) =>
      msg.id === assistantMessageId
        ? { ...msg, content: msg.content + `\n[Error: ${errorMessage}]`, isStreaming: false }
        : msg
    )
  );
  setIsLoading(false);
  tokenStreamManagerRef.current = null;
});
```

### 3.6 Cancellation (handleCancel)

```typescript
const handleCancel = () => {
  // Cancel via TokenStreamManager
  if (tokenStreamManagerRef.current) {
    tokenStreamManagerRef.current.cancel();
    tokenStreamManagerRef.current = null;
  }
  // Abort any pending AbortController
  if (abortControllerRef.current) {
    abortControllerRef.current.abort();
    abortControllerRef.current = null;
  }
  // Mark streaming messages as complete
  setMessages((prev) =>
    prev.map((msg) => (msg.isStreaming ? { ...msg, isStreaming: false } : msg))
  );
  setIsLoading(false);
};
```

---

## 4. Mode Switching Impact

### 4.1 InferenceModeContext State Machine

```
InferenceModeProvider (lib/inference/InferenceModeContext.tsx)
    │
    ├─ setMode('browser-local' | 'api')
    │     │
    │     ├─ persistState() → localStorage
    │     └─ Triggers re-render of all useInferenceMode() consumers
    │
    ├─ setBrowserEngine('wllama' | 'webllm')
    │     │
    │     ├─ Sets isModelReady: false, modelLoadingProgress: 0
    │     └─ persistState()
    │
    └─ setRagPreset('fast' | 'balanced' | 'quality')
          │
          └─ persistState()
```

### 4.2 Mode Switch Effects on ChatPage State

| Switch | Effect on Chat State |
|--------|---------------------|
| `browser-local` → `api` | No direct state change; next message uses API endpoint |
| `api` → `browser-local` | No direct state change; next message uses RAG pipeline |
| Engine switch (`wllama` ↔ `webllm`) | `isModelReady: false` triggers model blocked overlay |
| `isLoading: true` + mode switch | Stream continues (mode captured in `runGeneration` closure at line 206) |

### 4.3 Mode-Specific Behavior in runGeneration (lines 155-205)

The `runGeneration` function captures `mode`, `serverUrl`, `browserEngine`, `ragPreset` in its closure at creation time. Changing mode does NOT affect in-flight streams—each stream is independent.

```typescript
// Mode captured at callback creation (line 206):
}, [mode, serverUrl, browserEngine, ragPreset]);
```

### 4.4 Cleanup on Engine Switch (lines 74-83)

```typescript
useEffect(() => {
  return () => {
    if (mode === 'browser-local') {
      disposeBrowserEngine(browserEngine);  // Cleanup old engine
    }
  };
}, [mode, browserEngine]);
```

---

## 5. Dexie Integration Points

### 5.1 Current Persistence Strategy

- **InferenceModeContext** persists to `localStorage` key `'inference-mode'`:
  - `mode`, `serverUrl`, `browserEngine`, `ragPreset`
- **Chat messages**: Persisted via `useConversations` hook → Dexie IndexedDB

### 5.2 Implemented Dexie Schema

```typescript
// Implemented schema (db/conversations.ts)
interface Conversation {
  id: string;                    // Primary key (crypto.randomUUID)
  title: string;                // Auto-generated from first user message
  messages: ChatMessage[];      // Full message array
  createdAt: number;            // Unix timestamp
  updatedAt: number;            // Last activity timestamp
  mode: 'server' | 'wllama';   // Inference mode used
  modelUsed: string;            // Model identifier
}

// Dexie setup
const db = new Dexie('DocQA');
db.version(1).stores({
  conversations: 'id, createdAt, updatedAt',
});
```

### 5.3 useConversations Hook API

```typescript
export function useConversations() {
  // State
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | undefined>(undefined);
  const [currentMessages, setCurrentMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  // Methods
  const refreshConversations = useCallback(async () => { /* ... */ }, [pageSize]);
  const loadMore = useCallback(async () => { /* paginated load */ }, [conversations.length, pageSize, isLoadingMore]);
  const selectConversation = useCallback(async (id: string) => { /* load from Dexie */ }, []);
  const newChat = useCallback(() => { /* clear current */ }, []);
  const saveMessages = useCallback(async (messages, mode, modelUsed) => { /* create or update */ }, [currentConversationId, refreshConversations]);
  const removeConversation = useCallback(async (id: string) => { /* delete */ }, [currentConversationId, refreshConversations]);
  const renameConversation = useCallback(async (id, newTitle) => { /* update title */ }, [refreshConversations]);
  const clearPersistenceError = useCallback(() => setPersistenceError(null), []);

  return {
    conversations, currentConversationId, currentMessages, setCurrentMessages,
    selectConversation, newChat, saveMessages, removeConversation, renameConversation,
    refreshConversations, hasMore, loadMore, isLoadingMore,
    persistenceError, clearPersistenceError,
  };
}
```

### 5.4 Persistence Error Surfacing

All 7 catch blocks in `useConversations.ts` surface user-friendly error messages via `persistenceError` state:

| Operation | Error Message |
|-----------|---------------|
| `refreshConversations` | "Failed to load conversations" |
| `loadMore` | "Failed to load more conversations" |
| `renameConversation` | "Failed to rename conversation" |
| selectConversation | "Failed to load conversation" |
| saveMessages | "Failed to save conversation" |
| removeConversation | "Failed to delete conversation" |
| initialization | "Failed to load conversations" |

App.tsx displays a dismissible error banner consuming `persistenceError`:

```tsx
{persistenceError && (
  <div style={{
    padding: 'var(--spacing-sm) var(--spacing-md)',
    backgroundColor: 'rgba(211, 47, 47, 0.1)',
    border: '1px solid var(--color-danger)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--color-danger)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  }}>
    <span>{persistenceError}</span>
    <button onClick={clearPersistenceError}>×</button>
  </div>
)}
```

### 5.5 Save Boundaries (Implemented)

| Event | Action |
|-------|--------|
| `saveMessages()` | Called after streaming completes or on send. Creates new conversation if `currentConversationId` is null, otherwise updates existing. |
| `removeConversation()` | Deletes from Dexie, clears current if deleted was active |
| `renameConversation()` | Updates title + updatedAt |
| App mount | Loads most recent conversation automatically |

### 5.6 Load Boundaries (Implemented)

| Event | Action |
|-------|--------|
| App initialization | `refreshConversations()` loads list, loads most recent into `currentMessages` |
| `selectConversation(id)` | Loads specific conversation from Dexie by ID |
| `loadMore()` | Pagination — appends next page to conversation list |

---

## 6. Dependencies and Risk Areas

### 6.1 High-Risk Areas for Persistence Addition

| Area | Risk | Mitigation |
|------|------|------------|
| `runGeneration` closure | Captures mode/engine at creation; adding persistence closure dependencies could break in-flight streams | Ensure persistence doesn't add reactive deps to `runGeneration` |
| `tokenStreamManagerRef` | Mutable ref updated outside React state; Dexie save timing must not race with stream updates | Use functional setMessages, save after completion |
| `lastTurnRef` | Contains raw bytes (AttachedImage); ChatMessage.images uses ChatImage[] with base64 dataUrl (no raw bytes) | Dexie stores ChatImage[] (base64 dataUrl) directly; lastTurnRef is separate volatile reference |
| `MAX_MESSAGES` pruning | Pruning logic in setMessages callback; Dexie saves full array before pruning | Save after pruning completes |

### 6.2 Potential Break Points

1. **Message `images` field**: Contains `ChatImage[]` with base64 `dataUrl` (no `ArrayBuffer`). Dexie stores these directly—no serialization conversion needed. Raw bytes live only in `lastTurnRef` and are passed to RAG as `RAGImageInput`.

2. **Streaming race conditions**: If Dexie save is async and stream updates happen rapidly, state may drift. Mitigation: batch saves with debounce.

3. **Mode switch during stream**: Stream captures mode in closure; adding mode-dependent state to Dexie could cause inconsistency. Mitigation: streams are self-contained.

4. **ChatMessage.id generation**: Uses `crypto.randomUUID` which is fine for Dexie keys.

### 6.3 Performance Considerations

- **Large conversations**: With MAX_MESSAGES=200, each message could be several KB. Total state size could reach 5-10MB. Dexie handles this well.
- **Streaming updates**: RAF-batched rendering; Dexie saves should be debounced (e.g., 1s after last change) to avoid excessive writes.
- **Image data**: `ChatImage.dataUrl` is already base64—no conversion needed for Dexie. Raw `AttachedImage.data` (ArrayBuffer) only exists in `lastTurnRef` and is not persisted.

---

## 7. Design Token System

### 7.1 Radius Token Scale

Phase 5 introduced `--radius-xs: 4px` to complete the radius token scale:

```css
/* Border radius tokens */
--radius-xs: 4px;   /* newly added */
--radius-sm: 6px;
--radius-md: 12px;
--radius-lg: 20px;
```

### 7.2 Shadow Token Scale

All components use CSS custom properties for box shadows:

```css
/* Elevation shadow tokens */
--shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.08);
--shadow-md: 0 4px 12px rgba(0, 0, 0, 0.12);
--shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.16);
```

### 7.3 Component Token Compliance

Phase 5 updated all 8 component files to use consistent tokens:
- `borderRadius` uses `--radius-*` tokens (not hardcoded values)
- `boxShadow` uses `--shadow-*` tokens (not hardcoded values)

This ensures all components respond correctly to theme changes and maintain visual consistency.

---

## 8. NavigationRail.tsx Analysis

### 8.1 Current Structure

The `NavigationRail` component (96 lines) provides vertical navigation with three items:
- `chat` → ChatPage
- `documents` → Documents page
- `settings` → Settings page

### 8.2 Rules-of-Hooks Violation (Line 62)

```typescript
{navItems.map((item) => {
  const isActive = currentPage === item.id;
  const [hovered, setHovered] = useState(false);  // ← VIOLATION
  return (
    <button ...>
```

**Violation:** `useState(false)` is called inside a `.map()` callback, which violates React's Rules of Hooks. Hooks must not be called inside loops, conditions, or nested functions.

**Impact:** While this may work in practice due to React's implementation, it is:
1. Undefined behavior per React rules
2. Could break in future React versions
3. Causes a lint warning in strict mode

### 8.3 Current Hover Implementation

```typescript
const [hovered, setHovered] = useState(false);
// ...
<button
  onMouseEnter={() => setHovered(true)}
  onMouseLeave={() => setHovered(false)}
  style={{
    backgroundColor: isActive ? 'var(--color-primary)' : hovered ? 'var(--color-secondary)' : 'transparent',
    // ...
  }}
>
```

### 8.4 Sidebar Migration Requirements

For sidebar replacement:

1. **Remove useState from map callback** — either:
   - Use CSS `:hover` pseudo-class (preferred, no JS state)
   - Lift state to parent with `useRef` for previous/next-hover tracking
   - Use CSS-in-JS hover via `onMouseEnter`/`onMouseLeave` on a wrapper

2. **Preserve nav structure**:
   ```typescript
   const navItems = [
     { id: 'chat', label: 'Chat' },
     { id: 'documents', label: 'Documents' },
     { id: 'settings', label: 'Settings' },
   ];
   ```

3. **Keep existing props interface**:
   ```typescript
   interface NavigationRailProps {
     currentPage: string;
     onNavigate: (page: string) => void;
   }
   ```

4. **CSS-only hover alternative**:
   ```css
   nav button:hover {
     background-color: var(--color-secondary);
   }
   nav button[aria-current="page"] {
     background-color: var(--color-primary);
   }
   ```

### 7.5 Sidebar-Specific Changes (Future)

If converting to sidebar layout (vs vertical rail):

| Change | Consideration |
|--------|---------------|
| Width | Expand from 64px to ~240px for text labels |
| Layout | `flexDirection: 'row'` (horizontal) |
| Item layout | Icon + label side-by-side |
| Active indicator | Left border instead of background |
| Collapse mode | Future: toggle to icon-only rail |

---

## Appendix: Type Definitions

### ConversationSummary (hooks/useConversations.ts)

```typescript
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;  // ISO8601 string
}
```

### ChatMessage (types/chat.ts)

```typescript
export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatImage {
  id: string;
  dataUrl: string;    // Base64 data URL for rendering
  mimeType: string;
  fileName?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  sources?: string[];     // RAG source document IDs
  timestamp: number;      // Unix ms
  isStreaming?: boolean;  // True while receiving tokens
  images?: ChatImage[];   // User-attached images (no raw bytes)
}
```

### RAGEvent (rag-orchestrator.ts)

```typescript
export type RAGEvent =
  | { type: 'retrieving'; data: { query: string } }
  | { type: 'retrieved'; data: { vectorResults, keywordResults, fusedResults } }
  | { type: 'reranking'; data: { count: number } }
  | { type: 'reranked'; data: { results: SearchResult[] } }
  | { type: 'generating'; data: { contextLength: number; sourceCount: number } }
  | { type: 'token'; data: string }
  | { type: 'complete'; data: { answer: string; sources: string[]; chunks: SearchResult[] } }
  | { type: 'error'; data: { stage: RAGStage; message: string } };
```

### InferenceModeState (inference/InferenceModeContext.tsx)

```typescript
interface InferenceModeState {
  mode: InferenceMode;           // 'browser-local' | 'api'
  browserEngine: BrowserEngine; // 'wllama' | 'webllm'
  ragPreset: RAGPreset;          // 'fast' | 'balanced' | 'quality'
  isModelReady: boolean;
  isServerConnected: boolean;
  modelLoadingProgress: number;   // 0-100
  serverUrl: string;
  modeError: string | null;
}
```
