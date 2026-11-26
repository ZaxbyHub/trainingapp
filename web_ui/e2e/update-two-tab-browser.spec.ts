/**
 * update-two-tab-browser.spec.ts — issue #372 AC1 (check C1): a real
 * two-tab Chromium session drives UI-generated conversation UPDATES from BOTH
 * tabs of one context racing each other, against the production build (vite
 * preview of dist).
 *
 * FROZEN SPEC (rev 2, critic-mandated amendment 4) — authored by the
 * independent check author at base
 * 54107572c092febc00beff17f719ff631a2215ac, before any implementation
 * exists. The implementer must make this pass WITHOUT editing it; the
 * canonical copy lives in the issue trace and is dropped into the repo
 * byte-identical at web_ui/e2e/update-two-tab-browser.spec.ts.
 *
 * RED at base (the spec file does not exist there — Playwright's discovery
 * signature is `No tests found.`), GREEN after the fix: at head the spec runs
 * and both writers' committed changes must survive.
 *
 * REV 3 — RACE-WINDOW LOCK ATTRIBUTION (critic finding: rev 2's counts were
 * satisfiable by boot alone — boot migrations acquire docqa-conv-write in
 * BOTH tabs, so an UPDATE-lock-only mutant would have stayed green). Both
 * tabs install an init-script wrapper around navigator.locks.request that
 * records every {name, mode} acquisition into a per-tab window.__convLockLog
 * array; immediately BEFORE the race actions, the spec RESETS both tabs'
 * acquisitions arrays (preserving the availability flag), so every counted
 * acquisition belongs to the RACE WINDOW ONLY. The spec asserts Web Locks
 * are AVAILABLE in the harness (a missing navigator.locks fails the leg
 * loudly — never a silent pass) and that the two UPDATE writers acquired
 * the shared docqa-conv-write lock in EXCLUSIVE mode: >= 1 acquisition per
 * tab and >= 2 across the pair, from the rename/send writers alone (boot
 * and seed acquisitions are excluded by the explicit reset; the counted
 * entries are printed into every failure message so attribution is
 * auditable).
 *
 * Harness (mirrors web_ui/e2e/inactivity-clear-two-tab-browser.spec.ts, the
 * repo's existing real-Chromium two-tab spec): abort-non-local routes + a
 * same-origin OpenAI-shaped probe fulfilment for the chat-completions
 * endpoint + the external-provider-config init script — NO model weights,
 * matching the CI policy that e2e never stages operator weights
 * (.github/workflows/web-ui.yml: the e2e lane deliberately runs without
 * prepare-models). What was absent at base is the second CONCURRENT WRITER,
 * not weight staging (02-reproduction.md's correction to the issue premise).
 *
 * The race: one seeded conversation, two tabs of the SAME context (same
 * profile, same store). Tab B sends a message (the send path's persisted
 * update); the probe fulfilment is DELAYED so B's save is mid-flight while
 * tab A renames the conversation through the sidebar menu (role=menuitem
 * "Rename" -> aria-label "Edit conversation title"). Both writes target the
 * SAME row, so the read-merge-write UPDATE serialization under the shared
 * conv-write lock is exercised for real. Both committed changes must survive
 * and read back DECRYPTED (the row is an at-rest envelope after #367; the
 * page-side reader decrypts it exactly like the sibling spec's).
 */
import { expect, test, type Page } from '@playwright/test';

const SEED_CONTENTS = [
  'SEED-Q1 what is the vacation policy',
  'SEED-A1 fifteen days per year',
  'SEED-Q2 what about carry-over',
  'SEED-A2 capped at five days',
];
const NEW_QUESTION = 'RACE-QUESTION-from-tab-B';
const ASSISTANT_ANSWER = 'tab B probe answer';
const RENAMED_TITLE = 'RENAMED-BY-TAB-A-zq71';

/**
 * The probe completion is delayed by this much so tab B's send is still
 * in flight (between its read and its persisted write) while tab A's rename
 * commits — a real overlap window instead of accidental serialization.
 */
const PROBE_DELAY_MS = 1_500;

test.describe('two-tab concurrent conversation updates (issue #372 AC1)', () => {
  // Boot + seeding + one send + one rename: well under the sibling spec's
  // 240 s (there is no idle wait here); sized generously for CI runners.
  test.describe.configure({ timeout: 120_000 });

  test('a sidebar rename in tab A and a message send in tab B both commit: both changes survive and read back decrypted', async ({
    page: tabA,
    context,
    baseURL,
  }) => {
    const boot = async (page: Page, probeDelayMs: number): Promise<void> => {
      await page.route('**/*', (route) => {
        const host = new URL(route.request().url()).hostname;
        return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
      });
      // Registered last so it wins: the generation request is answered by a
      // JSON completion (no model weights, no network beyond the origin).
      // The handler-side delay keeps tab B's send in flight while tab A
      // renames — the concurrent-writer window this spec exists to cover.
      await page.route('**/probe/v1/chat/completions', async (route) => {
        await page.waitForTimeout(probeDelayMs);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ message: { content: ASSISTANT_ANSWER } }] }),
        });
      });
      await page.addInitScript(({ base }) => {
        try {
          localStorage.setItem(
            'external-provider-config',
            JSON.stringify({
              enabled: true,
              protocol: 'openai',
              baseUrl: `${base}/probe/v1`,
              model: 'probe-model',
              grounded: false,
              rememberKey: false,
            }),
          );
        } catch {
          /* ignore */
        }
      }, { base: baseURL });
      // REV 2 — lock instrumentation: wrap navigator.locks.request BEFORE
      // any app script runs, recording every {name, mode} acquisition. If
      // Web Locks are unavailable the wrapper records available:false and
      // the instrumentation leg below FAILS LOUDLY (never a silent pass).
      await page.addInitScript(() => {
        const w = window as unknown as { __convLockLog?: { available: boolean; acquisitions: Array<{ name: string; mode: string }> } };
        const locks = (navigator as unknown as {
          locks?: { request?: (...args: unknown[]) => Promise<unknown> };
        }).locks;
        if (locks === undefined || typeof locks.request !== 'function') {
          w.__convLockLog = { available: false, acquisitions: [] };
          return;
        }
        const acquisitions: Array<{ name: string; mode: string }> = [];
        w.__convLockLog = { available: true, acquisitions };
        const original = locks.request.bind(locks);
        locks.request = ((...args: unknown[]) => {
          const name = String(args[0]);
          const maybeOptions = args[1];
          const mode =
            typeof maybeOptions === 'object' && maybeOptions !== null && 'mode' in maybeOptions
              ? String((maybeOptions as { mode: unknown }).mode)
              : 'exclusive';
          acquisitions.push({ name, mode });
          return original(...args);
        }) as typeof locks.request;
      });
      await page.goto('/');
      await expect(page.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
        timeout: 60_000,
      });
    };

    await boot(tabA, PROBE_DELAY_MS);
    const tabB = await context.newPage();
    await boot(tabB, PROBE_DELAY_MS);

    // Seed one conversation with four messages into the shared profile's
    // conversations db (same-origin storage is shared by both tabs). The raw
    // plaintext row is the #367 first-open-migration rollout shape: the first
    // open encrypts it into an at-rest envelope.
    const prefix = await tabB.evaluate(() => localStorage.getItem('doc-qa-profile-id'));
    expect(prefix, 'profile id is minted at boot').toBeTruthy();
    const conversationId = 'e2e-two-tab-update';
    await tabB.evaluate(
      async ({ now, contents, name, id }) => {
        const db = await new Promise<IDBDatabase>((res, rej) => {
          // Open WITHOUT a pinned version: Dexie 4 declares the app's v2
          // schema at native IndexedDB version 20 and a lower pinned open
          // VersionErrors.
          const r = indexedDB.open(name);
          r.onupgradeneeded = () => {
            if (!r.result.objectStoreNames.contains('conversations')) {
              r.result.createObjectStore('conversations', { keyPath: 'id' });
            }
            if (!r.result.objectStoreNames.contains('meta')) {
              r.result.createObjectStore('meta', { keyPath: 'key' });
            }
          };
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        await new Promise<void>((res, rej) => {
          const t = db.transaction('conversations', 'readwrite');
          t.objectStore('conversations').put({
            id,
            title: 'Two-tab update race',
            createdAt: now,
            updatedAt: now,
            mode: 'wllma',
            modelUsed: 'test',
            messages: contents.map((content: string, i: number) => ({
              id: `seed-${i}`,
              role: i % 2 === 0 ? 'user' : 'assistant',
              content,
              timestamp: now,
            })),
          });
          t.oncomplete = () => res();
          t.onerror = () => rej(t.error);
        });
        db.close();
      },
      { now: Date.now(), contents: SEED_CONTENTS, name: `${prefix}-doc-qa-conversations`, id: conversationId },
    );

    // Fresh load of BOTH tabs so each sidebar lists the seeded conversation
    // from its own first-open (the sibling spec's about:blank trick: under
    // the app's COOP same-origin header a same-URL navigation can hang).
    await tabA.goto('about:blank');
    await tabA.goto('/');
    await expect(tabA.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
      timeout: 60_000,
    });
    await tabB.goto('about:blank');
    await tabB.goto('/');
    await expect(tabB.getByText('Initializing search services', { exact: false })).toHaveCount(0, {
      timeout: 60_000,
    });
    // Tab B opens the seeded conversation so its send targets it.
    await tabB.getByText('Two-tab update race').click();
    await expect(tabB.getByText(SEED_CONTENTS[0], { exact: false })).toBeVisible({ timeout: 15_000 });
    // Tab A's sidebar lists the same conversation (still under its seed
    // title until A's rename commits).
    await expect(tabA.getByText('Two-tab update race').first()).toBeVisible({ timeout: 15_000 });

    // REV 3 — reset both tabs' lock recorders so ONLY the race window
    // counts: boot migrations acquire docqa-conv-write in BOTH tabs, so
    // without this reset the >=1-per-tab witness would be satisfied by boot
    // alone and an UPDATE-lock-only mutant would stay green. The reset
    // clears the acquisitions array and preserves the availability flag.
    const resetLockLog = (page: Page): Promise<void> =>
      page.evaluate(() => {
        const log = (
          window as unknown as { __convLockLog?: { available: boolean; acquisitions: unknown[] } }
        ).__convLockLog;
        if (log !== undefined) log.acquisitions.length = 0;
      });
    await resetLockLog(tabA);
    await resetLockLog(tabB);

    // THE RACE — both writers run concurrently (each on its own page, so the
    // two async chains interleave): tab B sends a message (delayed probe
    // fulfilment keeps its save mid-flight) while tab A renames through the
    // sidebar menu. Neither writer may lose its committed change.
    const sendInTabB = (async () => {
      await tabB.getByLabel('Message input').fill(NEW_QUESTION);
      await tabB.getByLabel('Message input').press('Enter');
      await expect(tabB.getByText(ASSISTANT_ANSWER, { exact: false })).toBeVisible({ timeout: 30_000 });
    })();
    const renameInTabA = (async () => {
      await tabA.getByRole('button', { name: 'Conversation options' }).first().click();
      await tabA.getByRole('menuitem', { name: 'Rename' }).click();
      const input = tabA.getByLabel('Edit conversation title');
      await input.fill(RENAMED_TITLE);
      await input.press('Enter');
    })();
    await Promise.all([sendInTabB, renameInTabA]);

    // Both tabs eventually render the merged truth (UI-level corroboration).
    await expect(tabA.getByText(RENAMED_TITLE).first()).toBeVisible({ timeout: 15_000 });
    await expect(tabB.getByText(ASSISTANT_ANSWER, { exact: false })).toBeVisible({ timeout: 15_000 });

    // STORE-level verdict — read the row straight from the profile db through
    // the page, DECRYPTING the at-rest envelope exactly like the sibling
    // spec's reader: BOTH writers' changes must be persisted, nothing lost.
    const stored = await tabB.evaluate(readStoredConversation, {
      name: `${prefix}-doc-qa-conversations`,
      id: conversationId,
    });
    expect(stored, 'the conversation row must still exist').toBeDefined();
    expect(stored?.title, "tab A's rename must survive (serialized writer 1)").toBe(RENAMED_TITLE);
    const contents = (stored?.messages ?? []).map((m: { content: string }) => m.content);
    expect(
      contents,
      "tab B's send must survive on top of the full seeded record (serialized writer 2)",
    ).toEqual([...SEED_CONTENTS, NEW_QUESTION, ASSISTANT_ANSWER]);

    // REV 3 — SERIALIZATION WITNESS, read LAST (after the store-level verdict
    // proves both writers' commits landed, so their acquisitions cannot be
    // read "too early"). The recorders were RESET immediately before the
    // race, so these counts witness the RACE WINDOW ONLY — the rename and
    // send UPDATE writers, not boot migrations. The init-script recorder
    // answers availability loudly: a harness without Web Locks fails here,
    // never silently passing. The counted entries are printed into every
    // failure message so attribution stays auditable.
    const logA = await tabA.evaluate(() =>
      (window as unknown as { __convLockLog?: { available: boolean; acquisitions: Array<{ name: string; mode: string }> } })
        .__convLockLog,
    );
    const logB = await tabB.evaluate(() =>
      (window as unknown as { __convLockLog?: { available: boolean; acquisitions: Array<{ name: string; mode: string }> } })
        .__convLockLog,
    );
    expect(logA?.available, 'Web Locks must be available in the harness (Chromium) — tab A').toBe(true);
    expect(logB?.available, 'Web Locks must be available in the harness (Chromium) — tab B').toBe(true);
    const exclusiveConvWrites = (log: { acquisitions: Array<{ name: string; mode: string }> } | undefined): number =>
      (log?.acquisitions ?? []).filter((a) => a.name === 'docqa-conv-write' && a.mode === 'exclusive').length;
    expect(
      exclusiveConvWrites(logA),
      `tab A's rename writer acquired the shared conv-write lock exclusively (race-window acquisitions: ${JSON.stringify(logA?.acquisitions ?? [])})`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      exclusiveConvWrites(logB),
      `tab B's send writer acquired the shared conv-write lock exclusively (race-window acquisitions: ${JSON.stringify(logB?.acquisitions ?? [])})`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      exclusiveConvWrites(logA) + exclusiveConvWrites(logB),
      'both tabs raced under the shared conv-write lock (at least two race-window exclusive acquisitions)',
    ).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Read one conversation's title + message list straight from the profile db —
 * DECRYPTING when the row is an at-rest envelope (issue #367): the raw store
 * no longer holds plaintext `messages`, so the page-side reader mirrors
 * db-crypto (PBKDF2-SHA256 over the custody secret, AES-GCM with the
 * canonical AAD tuple) using the secret from the localStorage custody map.
 * Byte-identical in mechanism to the sibling spec's readStoredMessages,
 * extended to also return the title (the rename's persisted field).
 */
async function readStoredConversation(
  this: void,
  opts: { name: string; id: string },
): Promise<{ title: string; messages: Array<{ role: string; content: string }> } | undefined> {
  const r = indexedDB.open(opts.name);
  const row: { title?: string; messages?: Array<{ role: string; content: string }>; v?: number; e?: { iv: string; ct: string }; createdAt?: number; updatedAt?: number } | undefined =
    await new Promise((resolve, reject) => {
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result;
        const t = db.transaction('conversations', 'readonly');
        const get = t.objectStore('conversations').get(opts.id);
        get.onsuccess = () => {
          const got = get.result as typeof row;
          db.close();
          resolve(got);
        };
        get.onerror = () => {
          db.close();
          reject(get.error);
        };
      };
    });
  if (row === undefined) return undefined;
  if (row.messages) return { title: row.title ?? '', messages: row.messages }; // plaintext (pre-#367 shape)
  if (!row.e) return undefined;
  // Page-side decrypt of the envelope (issue #367 at-rest shape).
  const prefix = localStorage.getItem('doc-qa-profile-id') ?? '';
  const secretB64 = ((JSON.parse(localStorage.getItem('doc-qa-profile-secret') ?? '{}') as Record<string, string>)[prefix]) ?? '';
  if (!secretB64) throw new Error('custody secret missing for prefix ' + prefix);
  const raw = atob(secretB64);
  const secretBytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) secretBytes[i] = raw.charCodeAt(i);
  const baseKey = await crypto.subtle.importKey('raw', secretBytes, 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('trainingapp-db-crypto-v1|' + prefix), iterations: 210_000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const aad = new TextEncoder().encode(JSON.stringify([row.v, opts.id, row['createdAt'], row['updatedAt']]));
  const ivBytes = Uint8Array.from(atob(row.e.iv), (c) => c.charCodeAt(0));
  const ctBytes = Uint8Array.from(atob(row.e.ct), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes, additionalData: aad }, key, ctBytes);
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as { title: string; messages: Array<{ role: string; content: string }> };
  return { title: parsed.title, messages: parsed.messages };
}
