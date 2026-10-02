// universal-provider-settings-overhaul, review round 1 (F6): the
// "enabled requires a base URL AND a model" rule is pinned at the validation
// layer itself. Before this file the rule was masked at use time by
// ExternalProviderState.active() (mutation M9 - deleting the rule - left every
// test green), so a PUT could commit enabled:true with nothing to talk to and
// report external.enabled true while generation silently stayed local.
import { describe, expect, it } from 'vitest';
import { ExternalProviderState } from '../../main/backend/inference/external-provider';

const RULE = /external\.enabled: a base URL and a model are required/;

function configured(): ExternalProviderState {
  const state = new ExternalProviderState();
  const patch = { 'external.enabled': true, 'external.baseUrl': 'http://localhost:1234', 'external.model': 'm' };
  expect(state.validate(patch)).toEqual([]);
  state.commit(patch);
  expect(state.active()).toBe(true);
  return state;
}

describe('ExternalProviderState.validate: enabled requires base URL + model', () => {
  it('refuses enabled with neither a base URL nor a model', () => {
    expect(new ExternalProviderState().validate({ 'external.enabled': true }).join('\n')).toMatch(RULE);
  });

  it('refuses enabled with only a base URL', () => {
    const errors = new ExternalProviderState().validate({ 'external.enabled': true, 'external.baseUrl': 'http://localhost:1234' });
    expect(errors.join('\n')).toMatch(RULE);
  });

  it('refuses enabled with only a model', () => {
    const errors = new ExternalProviderState().validate({ 'external.enabled': true, 'external.model': 'm' });
    expect(errors.join('\n')).toMatch(RULE);
  });

  it('refuses clearing the model or the base URL while enabled (rule applies to the resulting state)', () => {
    const state = configured();
    expect(state.validate({ 'external.model': '' }).join('\n')).toMatch(RULE);
    expect(state.validate({ 'external.model': '   ' }).join('\n')).toMatch(RULE);
    expect(state.validate({ 'external.baseUrl': '' }).join('\n')).toMatch(RULE);
  });

  it('accepts enabled with both, and disabled with neither', () => {
    expect(
      new ExternalProviderState().validate({ 'external.enabled': true, 'external.baseUrl': 'http://localhost:1234', 'external.model': 'm' }),
    ).toEqual([]);
    expect(new ExternalProviderState().validate({ 'external.enabled': false })).toEqual([]);
    // Turning it off and clearing the model in one patch is allowed.
    expect(configured().validate({ 'external.enabled': false, 'external.model': '' })).toEqual([]);
  });

  it('validation commits nothing (a refused patch leaves the state untouched)', () => {
    const state = configured();
    expect(state.validate({ 'external.model': '' })).not.toEqual([]);
    expect(state.snapshot()['external.model']).toBe('m');
    expect(state.active()).toBe(true);
  });
});
