// PR #391 F-007: caller binding for the audit custody IPC surface.
//
// The custody binding exposes the bound sender set (`desktop:audit:binding-
// state`), so membership in that set is not caller identity. subscribe and the
// namespace-revoked ack already map webContents -> sender; pending, ack, and
// before-clear must prove the calling webContents owns the claimed sender too.
export interface AuditIpcEventLike {
  sender: { id: number };
}

export type AuditCallerAssertion = (event: AuditIpcEventLike, sender: number) => void;

export function createAuditCallerAssertion(owners: ReadonlyMap<number, number>): AuditCallerAssertion {
  return (event, sender) => {
    if (owners.get(event.sender.id) !== sender) {
      throw new Error('audit call sender does not match this renderer');
    }
  };
}

/**
 * A sender id is enumerable through `desktop:audit:binding-state`, and the
 * binder accepts an already-present sender. Without this check a second
 * webContents could subscribe with the bound sender, become its owner, and
 * then satisfy the per-call assertion. Reject a sender already owned by a
 * DIFFERENT live webContents; a reloading renderer reusing its own id is fine.
 */
export function assertSenderNotOwnedElsewhere(
  owners: ReadonlyMap<number, number>,
  webContentsId: number,
  sender: number,
): void {
  for (const [ownerId, ownedSender] of owners) {
    if (ownerId !== webContentsId && ownedSender === sender) {
      throw new Error('audit sender is already bound to another renderer');
    }
  }
}
