// AC4: single-instance lock — a second launch must not show a second window;
// the second process quits and the first process focuses/restores its window.
//
// Seam contract (desktop/main/index.ts):
//   export function acquireSingleInstanceLock(): boolean
//     - wraps app.requestSingleInstanceLock(); when it returns false the app
//       must call app.quit() and the function returns false.
//   export function registerSecondInstanceHandler(): void
//     - registers an app.on('second-instance', ...) handler that focuses and
//       restores (restore() then focus(), or equivalents) the existing window
//       without creating a new one or quitting the first instance.
// 'electron' resolves to desktop/test/electron-stub.ts (vitest alias); the
// stub's isMinimized() returns true so conditional restores still fire.
import { beforeEach, describe, expect, it } from 'vitest';
import { app, BrowserWindow, __resetElectronStub } from '../../test/electron-stub';
import {
  acquireSingleInstanceLock,
  createMainWindow,
  registerSecondInstanceHandler,
} from '../../main/index';

beforeEach(() => {
  __resetElectronStub();
});

describe('AC4 single-instance lock', () => {
  it('delegates to app.requestSingleInstanceLock()', () => {
    app.requestSingleInstanceLock.mockReturnValue(true);
    expect(acquireSingleInstanceLock()).toBe(true);
    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  it('quits the second process when the lock is NOT granted', () => {
    app.requestSingleInstanceLock.mockReturnValue(false);
    expect(acquireSingleInstanceLock()).toBe(false);
    expect(app.quit).toHaveBeenCalled();
  });

  it('does NOT quit the first process when the lock IS granted', () => {
    app.requestSingleInstanceLock.mockReturnValue(true);
    expect(acquireSingleInstanceLock()).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("on 'second-instance', focuses and restores the existing window (no new window, no quit)", () => {
    const win = createMainWindow();
    registerSecondInstanceHandler();
    expect(app.on).toHaveBeenCalledWith('second-instance', expect.any(Function));

    app.emit('second-instance');

    expect(win.focus).toHaveBeenCalled();
    expect(win.restore).toHaveBeenCalled();
    expect(BrowserWindow.getAllWindows()).toHaveLength(1);
    expect(app.quit).not.toHaveBeenCalled();
  });
});
