import { describe, expect, test } from 'bun:test';
import {
  resolveCodexProfile,
  toCodexWireRuntimeOptions,
} from '../../src/core/ai/codex-profiles.ts';

// These tests define Codex profile slugs as GBrain UX IDs, not raw provider models.
describe('Codex scoped model profiles', () => {
  test('plain base model uses medium standard defaults', () => {
    expect(resolveCodexProfile('gpt-5.5')).toEqual({
      providerModelId: 'gpt-5.5',
      displayModelId: 'gpt-5.5',
      runtime: {
        reasoning: { effort: 'medium', summary: 'auto' },
        latency: 'standard',
        store: false,
        toolChoice: 'auto',
        parallelToolCalls: true,
      },
    });
  });

  test('xhigh fast profile lowers to base model plus runtime options', () => {
    const profile = resolveCodexProfile('gpt-5.5-xhigh-fast');
    expect(profile.providerModelId).toBe('gpt-5.5');
    expect(profile.displayModelId).toBe('gpt-5.5-xhigh-fast');
    expect(profile.runtime.reasoning.effort).toBe('xhigh');
    expect(profile.runtime.latency).toBe('fast');
  });

  test('non-priced Codex base models are not advertised as supported profiles', () => {
    for (const modelId of [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark-medium-fast',
    ]) {
      expect(() => resolveCodexProfile(modelId)).toThrow(/Unknown Codex (?:model|profile)/);
    }
  });

  test('unknown suffix fails loud with a useful error', () => {
    expect(() => resolveCodexProfile('gpt-5.5-ultra-fast')).toThrow(/Unknown Codex profile/);
  });

  test('malformed profiles with empty suffix segments fail loud', () => {
    for (const modelId of [
      'gpt-5.5-',
      'gpt-5.5-medium-',
      'gpt-5.5-medium--fast',
      'gpt-5.5-medium-fast-',
    ]) {
      expect(() => resolveCodexProfile(modelId)).toThrow(/Unknown Codex profile/);
    }
  });

  test('wire lowering is centralized', () => {
    const profile = resolveCodexProfile('gpt-5.5-xhigh-fast');
    expect(toCodexWireRuntimeOptions(profile.runtime)).toMatchObject({
      store: false,
      reasoning: { summary: 'auto' },
      service_tier: 'priority',
      tool_choice: 'auto',
      parallel_tool_calls: true,
    });
  });
});
