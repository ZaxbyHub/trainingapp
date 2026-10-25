/**
 * model-chip-backend-profile.test.ts — issue #247 R3 (collated trace
 * .agents/issue-traces/collated-246-247, approved plan rev 5, AC12).
 *
 * AC12 is a PIN ONLY (no production change; this diff pins the pre-existing producer (model-chip.ts is unchanged here; the review-round mutation probe mutates it in the working tree only)):
 * in api mode (the desktop backend) with a real llama.cpp engine the chip
 * names the desktop PROFILE — 'Quality profile' / 'Fast profile' — resolved
 * from residentProfile first, then desktopModels.profile, and NEVER from the
 * browser-local wllama label. The desktop-external and stub branches are
 * pinned unchanged alongside.
 */
import { describe, expect, it } from 'vitest';
import {
  chatModelText,
  describeChatModel,
  packagedModelLabel,
  type DescribeChatModelInput,
} from '../model-chip';
import { DEFAULT_EXTERNAL_CONFIG, type ExternalConfig } from '../../llm/external-provider';

const WLLAMA_MODEL_ID = 'lfm2-1.2b-rag';

const apiModeBase: DescribeChatModelInput = {
  mode: 'api',
  hasDesktopSession: true,
  desktopModels: { engine: 'llama.cpp', profile: 'fast' },
  residentProfile: null,
  externalConfig: null,
  browserEngine: 'wllama',
  wllamaModelId: WLLAMA_MODEL_ID,
  webllmModelId: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
};

describe('model-chip-backend-profile: api mode names the desktop profile', () => {
  it('residentProfile wins: "Quality profile" / "Fast profile"', () => {
    const quality = describeChatModel({ ...apiModeBase, residentProfile: 'quality' });
    expect(quality.model).toBe('Quality profile');
    expect(chatModelText(quality)).toBe('Desktop · Quality profile');

    const fast = describeChatModel({ ...apiModeBase, residentProfile: 'fast' });
    expect(fast.model).toBe('Fast profile');
    expect(chatModelText(fast)).toBe('Desktop · Fast profile');
  });

  it('without a resident profile, the /status/models profile is used', () => {
    const d = describeChatModel({ ...apiModeBase, residentProfile: null, desktopModels: { engine: 'llama.cpp', profile: 'quality' } });
    expect(d.model).toBe('Quality profile');
    expect(chatModelText(d)).toBe('Desktop · Quality profile');
  });

  it('api mode NEVER names the browser-local wllama label', () => {
    const wllamaLabel = packagedModelLabel(WLLAMA_MODEL_ID);
    expect(wllamaLabel).toBe('LiquidAI LFM2-1.2B-RAG');
    for (const residentProfile of ['quality', 'fast', null]) {
      for (const profile of ['quality', 'fast'] as const) {
        const d = describeChatModel({
          ...apiModeBase,
          residentProfile,
          desktopModels: { engine: 'llama.cpp', profile },
        });
        expect(d.model, `resident=${String(residentProfile)} status=${profile}`).not.toBe(wllamaLabel);
        expect(d.model ?? '').not.toContain('LFM2');
        expect(d.kind).toBe('desktop');
      }
    }
  });

  it('desktop-external branch is unchanged: names the mode only, never a model', () => {
    const d = describeChatModel({
      ...apiModeBase,
      desktopModels: { engine: 'external', profile: 'quality' },
      residentProfile: 'fast',
    });
    expect(d.kind).toBe('desktop-external');
    expect(d.source).toBe('External model');
    expect(d.model).toBeNull();
    expect(chatModelText(d)).toBe('External model');
  });

  it('stub engine branch is unchanged: "test stub"', () => {
    const d = describeChatModel({
      ...apiModeBase,
      desktopModels: { engine: 'stub', profile: 'fast' },
      residentProfile: 'quality',
    });
    expect(d.kind).toBe('desktop');
    expect(d.model).toBe('test stub');
    expect(chatModelText(d)).toBe('Desktop · test stub');
  });

  it('no desktop session names the mode only (unchanged)', () => {
    const d = describeChatModel({ ...apiModeBase, hasDesktopSession: false, desktopModels: null });
    expect(d.kind).toBe('desktop');
    expect(d.model).toBeNull();
    expect(chatModelText(d)).toBe('Desktop backend');
  });

  it('an api-mode chip never leaks a browser external endpoint config either', () => {
    const externalConfig: ExternalConfig = {
      ...DEFAULT_EXTERNAL_CONFIG,
      enabled: true,
      baseUrl: 'http://192.168.1.20:1234/v1',
      model: 'qwen2.5-7b-instruct',
    };
    const d = describeChatModel({ ...apiModeBase, residentProfile: 'fast', externalConfig });
    expect(d.kind).toBe('desktop');
    expect(d.model).toBe('Fast profile');
    expect(d.host).toBeNull();
  });
});
