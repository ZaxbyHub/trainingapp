import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createAuditCallerAssertion, assertSenderNotOwnedElsewhere } from '../../main/audit-caller';

// PR #391 F-007 — the frozen custody-routes spec (C4) must not be edited, so
// the caller-binding coverage lives here: the guard's behavior, plus a
// structural pin that the shipped handlers still call it. The executing
// end-to-end proof lived in the review packet; this test keeps the guard from
// being removed or loosened without a red.
describe('audit caller binding (non-frozen F-007 coverage)', () => {
  const assertCaller = createAuditCallerAssertion(new Map([[61, 11]]));

  test('accepts the webContents that owns the sender', () => {
    expect(() => assertCaller({ sender: { id: 61 } }, 11)).not.toThrow();
  });

  test('rejects another webContents claiming the bound sender', () => {
    expect(() => assertCaller({ sender: { id: 62 } }, 11)).toThrow(/sender does not match/);
  });

  test('rejects the owning webContents claiming a different sender', () => {
    expect(() => assertCaller({ sender: { id: 61 } }, 12)).toThrow(/sender does not match/);
  });

  test('rejects an unmapped webContents', () => {
    expect(() => assertCaller({ sender: { id: 63 } }, 12)).toThrow(/sender does not match/);
  });

  test('the shipped handlers still construct and call the guard', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'main/index.ts'), 'utf8');
    expect(source).toContain('createAuditCallerAssertion(auditSendersByWebContents)');
    const calls = source.match(/assertAuditCaller\(event, sender\)/g) ?? [];
    expect(calls, 'pending, ack, and before-clear each bind the caller').toHaveLength(3);
    expect(source).toContain('assertSenderNotOwnedElsewhere(auditSendersByWebContents, event.sender.id, sender)');
  });

  test('an enumerable sender already owned by another webContents cannot be re-subscribed', () => {
    const owners = new Map([[61, 11]]);
    // The impersonation path: webContents 62 subscribes with the bound sender
    // 11, which would otherwise make the per-call guard pass.
    expect(() => assertSenderNotOwnedElsewhere(owners, 62, 11)).toThrow(/already bound to another renderer/);
    // The owning webContents (reload/re-subscribe) and a fresh sender are fine.
    expect(() => assertSenderNotOwnedElsewhere(owners, 61, 11)).not.toThrow();
    expect(() => assertSenderNotOwnedElsewhere(owners, 62, 12)).not.toThrow();
  });
});
