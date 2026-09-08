// C2 / AC3 behavioral part (issue #60, Workstream B2): the per-launch auth
// token reaches the renderer ONLY through the contextBridge/IPC channel —
// preload must expose a `desktopApi` namespace whose getAuthToken() routes to
// ipcRenderer.invoke('desktop:get-token'). (The structural no-storage /
// no-URL-param half of AC3 is enforced by driver check `token-bridge` greps;
// this spec pins the bridge surface.)
//
// Seam contract (frozen; desktop/preload/index.ts — EXISTS at base with only
// the legacy `trainingapp` namespace, so the desktopApi assertions fail at
// base for the right reason):
//   contextBridge.exposeInMainWorld('desktopApi', {
//     getAuthToken: () => ipcRenderer.invoke('desktop:get-token'),
//   });
//   // legacy namespace stays (compatibility): exactly one
//   // exposeInMainWorld('trainingapp', <object>) call.
//
// Dynamic-import pattern follows secure-defaults.test.ts: the preload module
// is a side-effect module, vitest isolates module registries per test FILE,
// and the registry caches after the first await import — so there is deliberately
// NO per-test __resetElectronStub() here (it would wipe the one-time side
// effect's recorded calls); the reset happens exactly once, immediately before
// the first import below. 'electron' resolves to desktop/test/electron-stub.ts.
import { describe, expect, it, vi } from 'vitest';
import { contextBridge, ipcRenderer, __resetElectronStub } from '../../test/electron-stub';

const IPC_CHANNEL = 'desktop:get-token';
const INVOKE_SENTINEL = 'sentinel-launch-token-from-ipc-0123456789abcdef';

type ExposedApi = { getAuthToken?: () => unknown };
type BridgeCall = [string, ExposedApi];

/** Recorded exposeInMainWorld calls (import side effect must have run). */
function bridgeCalls(): BridgeCall[] {
  return contextBridge.exposeInMainWorld.mock.calls as unknown as BridgeCall[];
}

function desktopApiCall(): BridgeCall | undefined {
  return bridgeCalls().find(([name]) => name === 'desktopApi');
}

describe('C2 token bridge: desktopApi via contextBridge/IPC only', () => {
  it("exposes a 'desktopApi' namespace whose API object has a getAuthToken function", async () => {
    __resetElectronStub();
    await import('../../preload/index');
    const call = desktopApiCall();
    expect(call, "contextBridge.exposeInMainWorld('desktopApi', ...) must be called").toBeDefined();
    const [, api] = call as BridgeCall;
    expect(api, 'desktopApi API must be a plain object').toBeTypeOf('object');
    expect(api, 'desktopApi API must not be null').not.toBeNull();
    expect(typeof api.getAuthToken, 'desktopApi.getAuthToken must be a function').toBe('function');
  });

  it("desktopApi.getAuthToken() resolves via ipcRenderer.invoke('desktop:get-token')", async () => {
    await import('../../preload/index'); // cached: side effect already recorded
    vi.mocked(ipcRenderer.invoke).mockResolvedValue(INVOKE_SENTINEL);
    const call = desktopApiCall();
    expect(call, 'desktopApi namespace missing').toBeDefined();
    const getAuthToken = (call as BridgeCall)[1].getAuthToken;
    expect(typeof getAuthToken, 'desktopApi.getAuthToken must be a function').toBe('function');

    const result = await (getAuthToken as () => Promise<string>)();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNEL);
    expect(result).toBe(INVOKE_SENTINEL);
  });

  it("still exposes the legacy 'trainingapp' namespace exactly once (compatibility)", async () => {
    await import('../../preload/index'); // cached: side effect already recorded
    const legacy = bridgeCalls().filter(([name]) => name === 'trainingapp');
    expect(legacy, 'legacy trainingapp namespace must remain exposed').toHaveLength(1);
    expect(legacy[0]?.[1]).toBeTypeOf('object');
  });
});
