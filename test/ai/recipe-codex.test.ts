import { describe, expect, test } from 'bun:test';
import { getRecipe, listRecipes } from '../../src/core/ai/recipes/index.ts';
import { classifyCapabilities } from '../../src/core/ai/capabilities.ts';
import { CODEX_BASE_MODELS } from '../../src/core/ai/codex-profiles.ts';

const CODEX_CHAT_MODELS = [...CODEX_BASE_MODELS];

describe('recipe: codex', () => {
  test('registered with codex-responses chat and expansion surfaces', () => {
    const r = getRecipe('codex');

    expect(r?.id).toBe('codex');
    expect(r?.implementation).toBe('codex-responses');
    expect(r?.touchpoints.expansion?.models).toEqual(CODEX_CHAT_MODELS);
    expect(r?.touchpoints.chat?.models).toEqual(CODEX_CHAT_MODELS);
    expect(r?.touchpoints.chat?.models).toContain('gpt-5.5');
    expect(r?.touchpoints.chat?.models).toEqual(['gpt-5.5']);
    expect(r?.touchpoints.expansion?.models).toEqual(['gpt-5.5']);
    expect(r?.touchpoints.chat?.models).not.toContain('gpt-5.4');
    expect(r?.touchpoints.chat?.models).not.toContain('gpt-5.3-codex-spark');
    expect(r?.touchpoints.chat?.models).not.toContain('gpt-5.5-xhigh-fast');
    expect(r?.touchpoints.embedding).toBeUndefined();
    expect(r?.touchpoints.reranker).toBeUndefined();
  });

  test('declares Codex auth env contract', () => {
    const r = getRecipe('codex');

    expect(r?.auth_env?.required).toEqual(['GBRAIN_CODEX_ACCESS_TOKEN']);
    expect(r?.auth_env?.optional ?? []).toContain('CODEX_ACCESS_TOKEN');
    expect(r?.auth_env?.optional ?? []).toContain('GBRAIN_CODEX_BASE_URL');
  });

  test('is included in the public recipe list', () => {
    expect(listRecipes().map(recipe => recipe.id)).toContain('codex');
  });

  test('keeps Codex chat/tool-capable, prompt-cache routed, and approved for subagent loops', () => {
    const r = getRecipe('codex');

    expect(r?.touchpoints.chat?.supports_tools).toBe(true);
    expect(r?.touchpoints.chat?.supports_subagent_loop).toBe(true);
    expect(r?.touchpoints.chat?.supports_prompt_cache).toBe(true);
    expect(classifyCapabilities('codex:gpt-5.5')).toBe('ok');
  });
});
