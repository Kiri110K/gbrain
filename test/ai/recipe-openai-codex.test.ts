import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { applyResolveAuth } from '../../src/core/ai/gateway.ts';

describe('openai-codex recipe', () => {
  test('is registered as OpenAI-compatible embedding provider', () => {
    const recipe = getRecipe('openai-codex');
    expect(recipe).toBeDefined();
    expect(recipe?.implementation).toBe('openai-compatible');
    expect(recipe?.base_url_default).toBe('https://api.openai.com/v1');
    expect(recipe?.touchpoints.embedding?.models).toContain('text-embedding-3-small');
    expect(recipe?.auth_env?.required).toEqual([]);
  });

  test('resolveAuth produces the injected OAuth bearer header', () => {
    const recipe = getRecipe('openai-codex')!;
    expect(applyResolveAuth(recipe, {
      env: { GBRAIN_CODEX_ACCESS_TOKEN: 'oauth-access-token' },
    }, 'embedding')).toEqual({ apiKey: 'oauth-access-token' });
  });
});

