/**
 * Shared external-endpoint URL policy (universal-provider-settings-overhaul,
 * AC1/AC10/AC14). This file has a byte-for-byte twin at
 * web_ui/src/lib/llm/endpoint-policy.ts — the two differ ONLY in where the
 * airgap default comes from (browser: the VITE_AIRGAP build flag; desktop:
 * TRAININGAPP_AIRGAP read at call time). Both are asserted row-for-row against
 * contracts/endpoint-policy-vectors.json and
 * contracts/endpoint-policy-vectors.supplemental.json.
 *
 * Parsing follows WHATWG URL semantics (the URL constructor), so numeric IPv4
 * forms (decimal `2130706433`, octal `0177.0.0.1`, hex `0x7f.1`, short `127.1`)
 * are normalized BEFORE classification and cannot smuggle a loopback, private
 * or metadata address past a string comparison.
 *
 * Classes:
 *   loopback: 127.0.0.0/8, ::1, `localhost`;
 *   private:  RFC1918, IPv6 ULA fc00::/7 (and deprecated site-local fec0::/10),
 *             `.local` / `.lan` / `.home.arpa` / `.internal` names;
 *   public:   everything else (including 100.64.0.0/10 CGNAT) — https required.
 * Refused: cloud metadata (169.254.169.254, fd00:ec2::254, metadata host
 * names), link-local 169.254.0.0/16 and fe80::/10, the unspecified address
 * (0.0.0.0/8, ::), multicast / broadcast / reserved ranges, userinfo, any
 * scheme other than http/https, and public hosts over http. IPv6 forms that
 * embed an IPv4 address (IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96,
 * SIIT ::ffff:0:0:0/96, NAT64 64:ff9b::/96, local-use NAT64 64:ff9b:1::/48
 * in its /96 layout, 6to4 2002::/16) are classified by the embedded IPv4.
 * Local-use NAT64 outside the /96 layout is refused when ANY RFC 6052
 * decoding that fits the /48 allocation (/40, /48, /56, /64, /96) yields a
 * refused IPv4, and is public otherwise. Teredo 2001::/32 is refused when its
 * server or (de-obfuscated) client IPv4 is refused, and is public otherwise
 * (it is tunnelled through Internet relays, never a LAN destination). Neither
 * is ever private: that would lift the https requirement and the airgap
 * restriction.
 * Unspecified / multicast / reserved targets report rule 'invalid-url' (the
 * rule set is frozen); the message names the actual reason.
 *
 * Never throws for any input.
 */

export type EndpointKind = 'loopback' | 'private' | 'public';
export type EndpointRule =
  | 'invalid-url'
  | 'scheme'
  | 'userinfo'
  | 'metadata'
  | 'link-local'
  | 'public-requires-https'
  | 'airgap-public';

export interface EndpointVerdict {
  ok: boolean;
  /** Set when ok. */
  kind?: EndpointKind;
  /** Set when !ok. */
  rule?: EndpointRule;
  /** Non-empty; when !ok it names `rule` literally. */
  message: string;
}

/** Classification of one IP address (resolved or literal). */
export type AddressClass =
  | { ok: true; kind: EndpointKind }
  | { ok: false; rule: EndpointRule; reason: string };

const METADATA_NAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);
const PRIVATE_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal'];

function refuse(rule: EndpointRule, detail: string): EndpointVerdict {
  return { ok: false, rule, message: `Endpoint refused (${rule}): ${detail}` };
}

/** Parse a dotted-quad (already WHATWG-normalized) into 4 octets, or null. */
function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Parse an IPv6 literal (no brackets, no zone) into 8 16-bit groups, or null. */
function parseIPv6(raw: string): number[] | null {
  let host = raw.toLowerCase();
  if (host.includes('%')) return null;
  // Trailing embedded IPv4 (e.g. ::ffff:1.2.3.4) -> two hex groups.
  const lastColon = host.lastIndexOf(':');
  const tail = host.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = v4;
    host = `${host.slice(0, lastColon + 1)}${((o0 << 8) | o1).toString(16)}:${((o2 << 8) | o3).toString(16)}`;
  }
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const groups: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] ?? '');
  if (rest === null) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function classifyIPv4(o: number[]): AddressClass {
  const [a = 0, b = 0, c = 0, d = 0] = o;
  if (a === 169 && b === 254 && c === 169 && d === 254) {
    return { ok: false, rule: 'metadata', reason: 'the cloud metadata service address 169.254.169.254' };
  }
  if (a === 169 && b === 254) {
    return { ok: false, rule: 'link-local', reason: 'a link-local address (169.254.0.0/16)' };
  }
  if (a === 0) return { ok: false, rule: 'invalid-url', reason: 'the unspecified address 0.0.0.0/8 is not a server address' };
  if (a === 127) return { ok: true, kind: 'loopback' };
  if (a === 10) return { ok: true, kind: 'private' };
  if (a === 172 && b >= 16 && b <= 31) return { ok: true, kind: 'private' };
  if (a === 192 && b === 168) return { ok: true, kind: 'private' };
  if (a >= 224) {
    return { ok: false, rule: 'invalid-url', reason: 'a multicast, broadcast or reserved address (224.0.0.0/3)' };
  }
  // Everything else, including 100.64.0.0/10 (carrier-grade NAT), is public.
  return { ok: true, kind: 'public' };
}

function classifyIPv6(groups: number[]): AddressClass {
  const g = (i: number): number => groups[i] ?? 0;
  const isZero = (from: number, to: number) => groups.slice(from, to).every((x) => x === 0);
  const embedded = (hi: number, lo: number): number[] => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  if (groups.every((x) => x === 0)) {
    return { ok: false, rule: 'invalid-url', reason: 'the unspecified address :: is not a server address' };
  }
  if (isZero(0, 7) && g(7) === 1) return { ok: true, kind: 'loopback' };
  // fd00:ec2::254 — AWS IMDS over IPv6.
  if (g(0) === 0xfd00 && g(1) === 0x0ec2 && isZero(2, 7) && g(7) === 0x254) {
    return { ok: false, rule: 'metadata', reason: 'the cloud metadata service address fd00:ec2::254' };
  }
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96.
  if (isZero(0, 5) && (g(5) === 0xffff || g(5) === 0)) return classifyIPv4(embedded(g(6), g(7)));
  // SIIT IPv4-translated ::ffff:0:0:0/96 (RFC 7915: ::ffff:0:a.b.c.d).
  if (isZero(0, 4) && g(4) === 0xffff && g(5) === 0) return classifyIPv4(embedded(g(6), g(7)));
  // NAT64 well-known prefix 64:ff9b::/96.
  if (g(0) === 0x64 && g(1) === 0xff9b && isZero(2, 6)) return classifyIPv4(embedded(g(6), g(7)));
  // Local-use NAT64 64:ff9b:1::/48 (RFC 8215). The /96 layout carries the
  // IPv4 in the last 32 bits and is classified by it. Outside the /96 layout
  // the translator's prefix length is unknown, so every RFC 6052 layout that
  // fits the /48 allocation is decoded (bits 64-71, the u-octet, are
  // skipped): any refused decoding refuses the address; otherwise it is
  // PUBLIC (https required, refused in airgap builds) - a translator may map
  // it to any IPv4. (A /32 layout cannot lie inside this /48: it would read
  // the fixed prefix bits 0x0001 as 0.1.x.x.)
  if (g(0) === 0x64 && g(1) === 0xff9b && g(2) === 0x0001) {
    if (isZero(3, 6)) return classifyIPv4(embedded(g(6), g(7)));
    const layouts: number[][] = [
      [g(2) & 0xff, g(3) >> 8, g(3) & 0xff, g(4) & 0xff], // /40
      [g(3) >> 8, g(3) & 0xff, g(4) & 0xff, g(5) >> 8], // /48
      [g(3) & 0xff, g(4) & 0xff, g(5) >> 8, g(5) & 0xff], // /56
      [g(4) & 0xff, g(5) >> 8, g(5) & 0xff, g(6) >> 8], // /64
      embedded(g(6), g(7)), // /96
    ];
    for (const octets of layouts) {
      const cls = classifyIPv4(octets);
      if (!cls.ok) return cls;
    }
    return { ok: true, kind: 'public' };
  }
  // Teredo 2001:0::/32 (RFC 4380): server IPv4 in groups 2-3, client IPv4
  // XOR-obfuscated in groups 6-7. A refused embedded address refuses the
  // whole address; otherwise it is PUBLIC (Teredo traffic is tunnelled
  // through Internet relays, never a LAN destination).
  if (g(0) === 0x2001 && g(1) === 0) {
    const server = classifyIPv4(embedded(g(2), g(3)));
    if (!server.ok) return server;
    const client = classifyIPv4(embedded(g(6) ^ 0xffff, g(7) ^ 0xffff));
    if (!client.ok) return client;
    return { ok: true, kind: 'public' };
  }
  // 6to4 2002::/16 carries the IPv4 in groups 1-2.
  if (g(0) === 0x2002) return classifyIPv4(embedded(g(1), g(2)));
  if ((g(0) & 0xffc0) === 0xfe80) return { ok: false, rule: 'link-local', reason: 'an IPv6 link-local address (fe80::/10)' };
  if ((g(0) & 0xff00) === 0xff00) return { ok: false, rule: 'invalid-url', reason: 'an IPv6 multicast address (ff00::/8)' };
  if ((g(0) & 0xfe00) === 0xfc00) return { ok: true, kind: 'private' };
  if ((g(0) & 0xffc0) === 0xfec0) return { ok: true, kind: 'private' };
  return { ok: true, kind: 'public' };
}

/**
 * Classify one IP address string (IPv4 dotted quad or IPv6, with or without
 * brackets). Used for URL literals here and, on the desktop, for every
 * resolved DNS answer at connect time. Returns null for a non-IP string.
 */
export function classifyAddress(address: string): AddressClass | null {
  const bare = address.replace(/^\[/, '').replace(/\]$/, '');
  if (bare.includes(':')) {
    const groups = parseIPv6(bare);
    return groups === null ? null : classifyIPv6(groups);
  }
  const v4 = parseIPv4(bare);
  return v4 === null ? null : classifyIPv4(v4);
}

/** Classify a (lowercased, WHATWG-normalized) host name or address. */
function classifyHost(hostname: string): AddressClass {
  if (hostname.startsWith('[')) {
    const cls = classifyAddress(hostname);
    return cls ?? { ok: false, rule: 'invalid-url', reason: `"${hostname}" is not a valid IPv6 address` };
  }
  const literal = classifyAddress(hostname);
  if (literal !== null) return literal;
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (name === '') return { ok: false, rule: 'invalid-url', reason: 'the host name is empty' };
  if (METADATA_NAMES.has(name)) {
    return { ok: false, rule: 'metadata', reason: `"${name}" is a cloud metadata service host` };
  }
  if (name === 'localhost') return { ok: true, kind: 'loopback' };
  if (PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix) && name.length > suffix.length)) {
    return { ok: true, kind: 'private' };
  }
  return { ok: true, kind: 'public' };
}

/**
 * The host-name class a URL's host claims (loopback/private/public) without
 * resolving it — the desktop outbound client uses it to require that resolved
 * addresses stay consistent with the name (private name -> private/loopback
 * answers only; loopback name -> loopback answers only).
 */
export function hostKind(hostname: string): EndpointKind | null {
  const cls = classifyHost(hostname.toLowerCase());
  return cls.ok ? cls.kind : null;
}

/** Validate a user-entered external endpoint base URL. Never throws. */
export function validateEndpointUrl(raw: string, opts?: { airgap?: boolean }): EndpointVerdict {
  try {
    const airgap = opts?.airgap ?? process.env.TRAININGAPP_AIRGAP === '1';
    if (typeof raw !== 'string') return refuse('invalid-url', 'the base URL is not a string');
    const trimmed = raw.trim();
    if (trimmed === '') return refuse('invalid-url', 'enter a base URL such as http://localhost:1234 or https://api.openai.com');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      return refuse('invalid-url', 'the base URL must start with http:// or https://');
    }
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return refuse('invalid-url', `"${trimmed.slice(0, 120)}" is not a valid URL (check the host and port)`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return refuse('scheme', `only http:// and https:// are supported, got "${url.protocol}"`);
    }
    if (url.username !== '' || url.password !== '') {
      return refuse('userinfo', 'the URL must not embed credentials (user:password@); put the API key in the API key field');
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname === '') return refuse('invalid-url', 'the base URL has no host');
    const cls = classifyHost(hostname);
    if (!cls.ok) return refuse(cls.rule, `${cls.reason} cannot be used as a model endpoint`);
    if (cls.kind === 'public' && airgap) {
      return refuse(
        'airgap-public',
        `this is an air-gapped build: only loopback and private-network endpoints are allowed, and ${hostname} is a public host`,
      );
    }
    if (cls.kind === 'public' && url.protocol !== 'https:') {
      return refuse('public-requires-https', `${hostname} is a public host, so the base URL must use https://`);
    }
    return { ok: true, kind: cls.kind, message: `Allowed ${cls.kind} endpoint ${url.origin}` };
  } catch {
    return refuse('invalid-url', 'the base URL could not be checked');
  }
}
