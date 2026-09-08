// B3 spec (issue #61): the preload bridge's backend-discovery surface —
// desktopApi.getBackendInfo must exist and route to
// ipcRenderer.invoke('desktop:get-backend'). The MAIN-side handler and the
// BackendHandle shape are pinned by b3-bootstrap-wiring.test.ts; THIS spec
// pins the renderer-side bridge so a renamed/removed method or channel string
// fails a test instead of shipping (PRR-004).
//
// Import-pattern note (same semantics as b2-token-bridge.test.ts): the
// preload module is a side-effect module, vitest isolates module registries
// per test FILE, and the registry caches after the first await import — so
// the reset happens exactly once, immediately before the first import.
import { describe, expect, it, vi } from 'vitest';
import { contextBridge, ipcRenderer, __resetElectronStub } from '../../test/electron-stub';

type ExposedApi = { getBackendInfo?: () => unknown };
type BridgeCall = [string, ExposedApi];

function desktopApiCall(): BridgeCall | undefined {
  return (contextBridge.exposeInMainWorld.mock.calls as unknown as BridgeCall[]).find(
    ([name]) => name === 'desktopApi',
  );
}

describe('b3 preload bridge: getBackendInfo (renderer port discovery)', () => {
  it("desktopApi.getBackendInfo() routes to ipcRenderer.invoke('desktop:get-backend')", async () => {
    __resetElectronStub();
    await import('../../preload/index');
    const call = desktopApiCall();
    expect(call, "contextBridge.exposeInMainWorld('desktopApi', ...) must be called").toBeDefined();
    const getBackendInfo = (call as BridgeCall)[1].getBackendInfo;
    expect(typeof getBackendInfo, 'desktopApi.getBackendInfo must be a function').toBe('function');

    const sentinel = { mode: 'node', port: 39123, url: 'http://127.0.0.1:39123' };
    vi.mocked(ipcRenderer.invoke).mockResolvedValue(sentinel);
    const handle = await (getBackendInfo as () => Promise<{ mode: string; port: number; url: string }>)();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('desktop:get-backend');
    expect(handle).toMatchObject({ mode: 'node', port: 39123 });
    expect(handle.url, 'the bridge exposes the address only — no token field').not.toContain('token');
  });
});
