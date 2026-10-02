# ADR-0011: External model endpoints (OpenAI- and Anthropic-compatible), grounded and opt-in

- **Status:** Accepted (2026-10-01, trace `universal-provider-settings-overhaul`)
- **Context:** The 2.0.0 release hardened the app to be offline: it eliminated all network access
  (see the 2.0.0 entry in `CHANGELOG.md`), and ADR-0010 added the first outbound call only behind
  a default-off opt-in. PR #138 then added a "Provider server (OpenAI-compatible)" inference
  mode: loopback-only, OpenAI-only, and ungrounded (plain chat, no document retrieval). Users
  could not find that setting, could not use a server on another machine on the LAN, could not
  use a cloud provider (OpenAI, Anthropic, OpenRouter), and lost document grounding the moment
  they used it. The product requirement is that users can connect the app to any OpenAI- or
  Anthropic-compatible endpoint, in the browser app and the desktop (Electron) app with full
  parity, without giving up grounded answers.

This ADR **reverses the 2.0.0 offline-hardened posture** for one feature, the external model,
and records the conditions under which that is acceptable. It does not change the
offline-first default: a fresh install still makes no external model calls.

## Options

### Option A — keep the renderer-only provider and widen the desktop content-security policy (rejected)

The PR #138 design: the renderer (the app's web UI) calls the endpoint with `fetch`, and the
desktop renderer's CSP `connect-src` is widened to allow the endpoint hosts.

- **Against (decisive):** a CSP is a static allow-list and cannot express "any host the user
  types, subject to an address policy". Widening it enough for LAN and cloud hosts removes the
  renderer's network containment for every script that runs in it. The API key would also live
  in the renderer, readable by any renderer-side code. The renderer cannot resolve DNS, so it
  cannot check what a name resolves to.

### Option B — a renderer-to-main IPC relay of raw HTTP (rejected)

The renderer sends a method, URL, headers and body over IPC and the main process performs it.

- **Against (decisive):** a generic relay is a confused-deputy primitive: any compromised
  renderer code could use it to make arbitrary requests from the main process (SSRF into the
  LAN or the cloud-metadata address) with the stored key attached. The safe version is not a
  relay at all; the main process must own the whole request (endpoint, key, headers, body
  shape) and the renderer may only ask the backend to answer a question.

### Option C — the desktop backend makes every external call, through Electron `net.fetch` (rejected)

The Node main-process backend owns the request, but uses `net.fetch` (Chromium's network
stack) to send it.

- **Against (decisive):** `net.fetch` resolves and connects internally. There is no way to
  validate the resolved address and then connect to exactly that address, so connect-time
  address pinning and DNS-rebinding checks are not possible with it. Validating a name and
  then letting the stack resolve it again leaves a time-of-check/time-of-use gap.

### Option D — the desktop backend makes every external call through `node:https` / `node:http` with a pinned lookup (selected)

The Node main-process backend owns the request and uses Node's own `node:https` and `node:http`
(no new dependency). It resolves the host name itself, validates every resolved address,
and connects to the validated address with the DNS lookup pinned, so the connection cannot
land on an address that was not checked.

- **For:** connect-time address validation and pinning are possible; the renderer's CSP stays
  unchanged; the renderer never stores the key or receives it back; no new dependency.
- **Against:** the app does not use Chromium's proxy configuration or certificate verifier for
  these calls (see Consequences for the proxy and CA handling).

## Decision

1. **Feature.** The app has one **external model** setting: when on, generation is sent to a
   user-configured endpoint instead of the local model. Two wire protocols are supported:
   **OpenAI-compatible** (OpenAI, OpenRouter, LM Studio, Ollama, llama-server, vLLM) and
   **Anthropic-compatible** (Anthropic Messages API). The browser app and the desktop app expose
   the same controls in one "External model" region of Settings. The PR #138 "Provider server"
   inference-mode radio is retired and a stored PR #138 configuration is migrated once.
2. **Grounded by default.** The whole app stays grounded: retrieval always runs locally and
   only generation goes to the endpoint. What leaves the machine is the question, the retrieved
   passages and a bounded window of recent conversation. An ungrounded **Direct chat** (question
   and recent conversation only, no retrieval, answers labelled "General knowledge") is a
   separate opt-in toggle, off by default.
3. **Egress is opt-in and off by default.** The external model switch is off by default.
   Nothing is sent to any endpoint until the user turns it on and supplies a base URL. The
   stored key is sent only to the origin it was saved for (key-origin binding, below).
4. **One endpoint URL policy**, implemented twice with shared test vectors
   (`web_ui/src/lib/llm/endpoint-policy.ts`, `desktop/main/security/endpoint-policy.ts`,
   `contracts/endpoint-policy-vectors.json` and
   `contracts/endpoint-policy-vectors.supplemental.json`):
   - loopback (127.0.0.0/8, `::1`, `localhost`) and private network (RFC 1918 10/8, 172.16/12,
     192.168/16; IPv6 ULA fc00::/7; names ending `.local`, `.lan`, `.home.arpa`, `.internal`)
     may use http or https;
   - every other host is public and requires https. This includes 100.64.0.0/10 carrier-grade
     NAT addresses (for example Tailscale) and single-label names such as `http://gpu-box`;
   - always refused: cloud metadata (169.254.169.254, `fd00:ec2::254`,
     `metadata.google.internal`), link-local (169.254.0.0/16, fe80::/10), `0.0.0.0` and `::`,
     multicast and broadcast, URLs with `user:password@`, and any scheme other than http or
     https;
   - numeric IPv4 spellings (decimal, octal, hex, short forms such as `127.1`) and IPv6 forms
     that embed an IPv4 address (`::ffff:...`, SIIT `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96`,
     local-use NAT64 `64:ff9b:1::/48`, 6to4 `2002::/16`) are normalized and classified by the
     embedded address; Teredo `2001::/32` is refused when either IPv4 address it carries is
     refused and is otherwise public, never private; local-use NAT64 addresses outside the `/96`
     layout are refused (every RFC 6052 decoding from `/32` to `/96` is checked, and the `/32`
     decoding always reads the fixed prefix as `0.1.x.x`).
5. **Airgap builds refuse public hosts.** The browser build made with `npm run build:airgap`
   (`VITE_AIRGAP=1`) and the desktop app, when its installer resources manifest
   (`installer-resources/manifest.json`, field `"airgap": true`, staged by `desktop:build`)
   says so or `TRAININGAPP_AIRGAP=1` is set, refuse public hosts. Loopback and private-network
   endpoints still work. The environment variable can only tighten, never loosen.
6. **Desktop transport.** All external calls are made by the desktop backend (Node main
   process) through `desktop/main/backend/net/guarded-request.ts`, built on `node:https` and
   `node:http`. It resolves the host name, refuses if any resolved address is cloud-metadata,
   link-local or unspecified, requires the answers to be consistent with the name's class (a
   private name may resolve only to private or loopback addresses; a loopback name only to
   loopback addresses), connects to the validated address with the lookup pinned (the TLS server
   name and `Host` header stay the original name), and follows no redirects. The renderer's CSP
   is unchanged and the renderer never stores the key or receives it back (it holds the key only
   while it is typed and sends it once in the settings save). The caller is
   `desktop/main/backend/inference/external-generator.ts`; the key is held by
   `desktop/main/security/secret-store.ts`.
7. **Browser transport.** The browser app calls the endpoint directly with `fetch`, so the
   endpoint must allow CORS from the app's origin. Requests use `redirect: 'error'` and omit
   credentials. Anthropic from a browser sends `anthropic-dangerous-direct-browser-access: true`.
8. **The Python `api_server.py` is unchanged.** It has no external backend. The browser app has
   no API-server mode (removed by the settings-wiring-honesty change), so there is no browser
   path to it either.

## Consequences

- **Reversal of 2.0.0, bounded.** The offline-hardened claim "no network access" no longer
  holds unconditionally: with the external model on, document text (retrieved passages) and
  questions leave the machine for the configured endpoint. The user opts in explicitly, the
  setting is off by default, and airgap builds can be restricted to loopback and private
  network. Documentation that described the app as having no network access must say "unless
  you turn on the external model or update checks".
- **The renderer chooses where the backend sends requests (desktop).** Option B's rule above
  (the renderer may only ask the backend to answer a question) is not absolute for the shipped
  design. The renderer's content-security policy allows loopback only, so the guarded backend
  is its only egress path, and `PUT /settings` is gated only by the desktop launch token. A
  compromised renderer could therefore repoint `external.baseUrl` at an endpoint it controls,
  enable external mode and have `/ask` send retrieved document text there (this works without
  a stored key, because no auth header is sent when no key is bound), and it could bind a
  freshly typed key to an origin it chose with a same-patch `{baseUrl, apiKey}`. This is
  accepted because the endpoint URL policy still applies to whatever it picks, and because a
  compromise is unlikely: the shipped bundle has no realistic injection sink (no
  `dangerouslySetInnerHTML`; react-markdown with an allowlisted URL transform; navigation and
  `window.open` are denied). It is a residual risk, not a closed one; a stored key is never
  readable by the renderer.
- **Redirects are never followed** on either transport. A key is therefore never replayed to a
  host the user did not configure.
- **Key-origin binding (both apps).** A saved key is bound to the origin (`scheme://host:port`,
  the WHATWG URL origin: lowercase scheme and host, default port dropped) it was entered for.
  If the base URL is pointed at a different origin the key is not sent, for generation or for
  the connection test; the panel says the key belongs to the other origin and the user
  re-enters it, which binds it to the new origin. Changing, clearing or resetting the base URL
  never rebinds the key, and pointing back to the original origin uses the saved key again.
  The Settings panel in both apps saves a typed key only together with the base URL shown (one
  save, one desktop `PUT`); while the shown URL is empty or refused the key is held in the panel
  and is not saved; it is saved only with the next valid base URL the user enters (never with
  one saved earlier unless the user enters it again).
  Desktop: the backend keeps the key and its origin as separate secret-store entries and sends
  the key only when the configured origin matches. Saving a key deletes the old key first, then
  writes the origin, then the new key, so a save that fails part-way leaves no key at all rather
  than a new key next to the old origin. If undoing a failed save cannot write the secret store
  back, the backend stops using the saved key until the user enters or clears it again, and the
  error says so. Browser: the origin is stored next to the
  key in the same browser storage (`external-provider-apikey-origin`), and the configuration
  loader hands the key to the generators and the connection test only for the matching origin.
  A browser key saved before this binding existed is bound to the base URL stored with it, or
  discarded when there is none.
- **Name-class consistency (desktop).** A name that claims to be private or loopback cannot be
  made to reach a public address by DNS (rebinding), and a name that resolves to metadata,
  link-local or unspecified addresses is refused.
- **The browser cannot check DNS.** A browser cannot resolve names, so it cannot verify what
  a name resolves to. The browser app classifies the URL by its spelling only. This is a
  documented limitation; the desktop app does check.
- **Plain http to a network host.** When a key would be sent over plain http to a
  non-loopback host, the browser panel warns. Public hosts require https regardless.
- **Airgap threat model.** The desktop airgap flag in `installer-resources/manifest.json` is
  not signed. It is protected only by write access to the install directory (administrator for
  per-machine NSIS installs, none for portable builds). The browser airgap restriction is a
  build-time constant. `TRAININGAPP_AIRGAP=1` can add the restriction at run time but never
  remove it.
- **No proxy support in this release (desktop).** The guarded client does not use proxies. A
  public endpoint reachable only through a mandatory HTTP proxy will not work; loopback and
  LAN endpoints are never proxied. Certificate trust is Node's bundled CAs plus the operating
  system's certificate store, and `NODE_EXTRA_CA_CERTS` is honoured.
- **Secret storage.** Desktop: the key is encrypted with Electron `safeStorage` (Windows DPAPI,
  macOS Keychain, Linux secret service) in the profile directory (`secrets.bin`); if the
  operating system offers no encryption the key is kept for the current session only and the
  panel says so. It is never written to `settings.json` or `external.json`, never returned by
  any endpoint, and never logged. Browser: the key is stored only in this browser, in
  `localStorage` while "Remember API key in this browser" is on and in `sessionStorage`
  otherwise; the configuration (never the key) is kept separately. Clear Cache removes both.
  A browser-held key is readable by any script in the page; this is why the desktop app keeps
  it out of the renderer entirely.
- **Settings channel and compatibility.** Non-secret external settings are stored in
  `<profile dir>/external.json`, not `settings.json`, so older app versions still load
  `settings.json`. A refused URL is a 422 whose message names the rule.
- **No local model required.** With the external model on, the desktop app does not need the
  local GGUF model files and `GET /status/models` reports engine `external`.
- **Distinct errors.** Authentication (401/403), unknown model (404 or not in the list),
  network/CORS (cannot reach the server) and timeout are reported separately, each naming
  the fix.
- **Maintenance.** The URL policy exists in two languages. The shared vectors in `contracts/`
  are the only guard against the implementations diverging; any policy change updates both
  implementations and the vectors in one change.
