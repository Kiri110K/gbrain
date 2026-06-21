import { describe, expect, test } from 'bun:test';
import { getRecipe, listRecipes } from '../../src/core/ai/recipes/index.ts';
import { classifyCapabilities } from '../../src/core/ai/capabilities.ts';

const CODEX_CHAT_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
];

describe('recipe: codex', () => {
  test('registered with codex-responses chat and expansion surfaces', () => {
    const r = getRecipe('codex');

    expect(r?.id).toBe('codex');
    expect(r?.implementation).toBe('codex-responses');
    expect(r?.touchpoints.expansion?.models).toEqual(CODEX_CHAT_MODELS);
    expect(r?.touchpoints.chat?.models).toEqual(CODEX_CHAT_MODELS);
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

  test('keeps Codex chat/tool-capable and approved for subagent loops after replay safety coverage', () => {
    const r = getRecipe('codex');

    expect(r?.touchpoints.chat?.supports_tools).toBe(true);
    expect(r?.touchpoints.chat?.supports_subagent_loop).toBe(true);
    expect(classifyCapabilities('codex:gpt-5.5')).toBe('degraded:no_caching');
  });
});
