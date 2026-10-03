/**
 * Lumen phase 5 model chip: one row per generator mode. The chip must name the
 * generator the send path ACTUALLY routes to, and must name only the mode when
 * no reliable model source exists (never a guess).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  chatModelText,
  describeChatModel,
  packagedModelLabel,
  routesToDesktopBackend,
  type DescribeChatModelInput,
} from './model-chip';
import { DEFAULT_EXTERNAL_CONFIG, type ExternalConfig } from '../llm/external-provider';
import * as endpointPolicy from '../llm/endpoint-policy';

const base: DescribeChatModelInput = {
  mode: 'browser-local',
  hasDesktopSession: false,
  desktopModels: null,
  residentProfile: null,
  externalConfig: null,
  browserEngine: 'wllama',
  wllamaModelId: 'gemma-4-e2b-it',
  webllmModelId: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
};

const external = (patch: Partial<ExternalConfig>): ExternalConfig => ({
  ...DEFAULT_EXTERNAL_CONFIG,
  enabled: true,
  baseUrl: 'http://192.168.1.20:1234/v1?token=secret',
  model: 'qwen2.5-7b-instruct',
  apiKey: 'sk-should-never-show',
  ...patch,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('routesToDesktopBackend (the single routing predicate)', () => {
  it('routes api mode to the backend', () => {
    expect(routesToDesktopBackend('api', true, 'llama.cpp')).toBe(true);
    expect(routesToDesktopBackend('api', false, null)).toBe(true);
  });
  it('routes browser-local to the backend only when the desktop backend reports engine external', () => {
    expect(routesToDesktopBackend('browser-local', true, 'external')).toBe(true);
    expect(routesToDesktopBackend('browser-local', true, 'llama.cpp')).toBe(false);
    expect(routesToDesktopBackend('browser-local', false, 'external')).toBe(false);
    expect(routesToDesktopBackend('browser-local', true, undefined)).toBe(false);
  });
});

describe('describeChatModel', () => {
  it('browser local, wllama: the packaged model label from the manifest', () => {
    const d = describeChatModel(base);
    expect(d.kind).toBe('local');
    expect(chatModelText(d)).toBe('Local · Google Gemma 4 E2B-it');
  });

  it('browser local, wllama with an unlisted model id: shows the raw id (no invented name)', () => {
    const d = describeChatModel({ ...base, wllamaModelId: 'some-new-model' });
    expect(chatModelText(d)).toBe('Local · some-new-model');
  });

  it('browser local, WebLLM: the model id the load path uses', () => {
    const d = describeChatModel({ ...base, browserEngine: 'webllm' });
    expect(chatModelText(d)).toBe('Local · Llama-3.2-3B-Instruct-q4f16_1-MLC');
    expect(d.detail).toContain('WebLLM');
  });

  it('browser app, active external endpoint: hostname + model only (no path, query or key)', () => {
    const d = describeChatModel({ ...base, externalConfig: external({}) });
    expect(d.kind).toBe('external');
    const text = chatModelText(d);
    expect(text).toBe('192.168.1.20 · qwen2.5-7b-instruct');
    const everything = `${text} ${d.detail}`;
    expect(everything).not.toContain('token');
    expect(everything).not.toContain('secret');
    expect(everything).not.toContain('sk-should-never-show');
    expect(everything).not.toContain('/v1');
    // A compatible endpoint is never labelled as the vendor itself.
    expect(d.detail).toContain('OpenAI-compatible');
    expect(d.detail).toContain('Answers use your documents.');
  });

  it('browser app, Anthropic-compatible Direct chat says so in the detail', () => {
    const d = describeChatModel({
      ...base,
      externalConfig: external({ protocol: 'anthropic', grounded: false, baseUrl: 'https://api.anthropic.com' }),
    });
    expect(chatModelText(d)).toBe('api.anthropic.com · qwen2.5-7b-instruct');
    expect(d.detail).toContain('Anthropic-compatible');
    expect(d.detail).toContain('Direct chat');
  });

  it('browser app, external config present but NOT active: falls back to the local engine (matches routing)', () => {
    expect(describeChatModel({ ...base, externalConfig: external({ enabled: false }) }).kind).toBe('local');
    expect(describeChatModel({ ...base, externalConfig: external({ model: '  ' }) }).kind).toBe('local');
  });

  it('browser app, endpoint the policy refuses: not shown as external (createExternalLLMService would return null)', () => {
    vi.spyOn(endpointPolicy, 'validateEndpointUrl').mockReturnValue({ ok: false } as ReturnType<
      typeof endpointPolicy.validateEndpointUrl
    >);
    expect(describeChatModel({ ...base, externalConfig: external({}) }).kind).toBe('local');
  });

  it('desktop, engine external: names the mode only (renderer config is not authoritative)', () => {
    const d = describeChatModel({
      ...base,
      hasDesktopSession: true,
      desktopModels: { engine: 'external', profile: 'quality' },
      // Even if a stale browser config were passed it must not be described.
      externalConfig: external({}),
    });
    expect(d.kind).toBe('desktop-external');
    expect(chatModelText(d)).toBe('External model');
    expect(d.model).toBeNull();
  });

  it('desktop api mode, llama.cpp: the resident profile wins over the boot-time profile', () => {
    const d = describeChatModel({
      ...base,
      mode: 'api',
      hasDesktopSession: true,
      desktopModels: { engine: 'llama.cpp', profile: 'quality' },
      residentProfile: 'fast',
    });
    expect(chatModelText(d)).toBe('Desktop · Fast profile');
  });

  it('desktop api mode, llama.cpp without a resident profile: the /status/models profile', () => {
    const d = describeChatModel({
      ...base,
      mode: 'api',
      hasDesktopSession: true,
      desktopModels: { engine: 'llama.cpp', profile: 'quality' },
    });
    expect(chatModelText(d)).toBe('Desktop · Quality profile');
  });

  it('desktop api mode, stub engine', () => {
    const d = describeChatModel({
      ...base,
      mode: 'api',
      hasDesktopSession: true,
      desktopModels: { engine: 'stub', profile: 'quality' },
    });
    expect(chatModelText(d)).toBe('Desktop · test stub');
  });

  it('desktop api mode with no model status (or no session yet): the mode only', () => {
    expect(chatModelText(describeChatModel({ ...base, mode: 'api', hasDesktopSession: true }))).toBe('Desktop backend');
    expect(chatModelText(describeChatModel({ ...base, mode: 'api', hasDesktopSession: false }))).toBe('Desktop backend');
  });

  it('desktop app in browser-local mode with a local engine: the renderer engine (that is what generates)', () => {
    const d = describeChatModel({
      ...base,
      hasDesktopSession: true,
      desktopModels: { engine: 'llama.cpp', profile: 'quality' },
    });
    expect(d.kind).toBe('local');
  });
});

describe('packagedModelLabel', () => {
  it('drops the parenthetical from the manifest label', () => {
    expect(packagedModelLabel('gemma-4-e2b-it')).toBe('Google Gemma 4 E2B-it');
  });
  it('returns the id for unknown models', () => {
    expect(packagedModelLabel('nope')).toBe('nope');
  });
});
