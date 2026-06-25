/**
 * `gbrain providers` — pure formatter + envReady tests.
 *
 * `runTest` and `runExplain` aren't covered here because they touch the
 * gateway / loadConfig; E2E exercises those.
 */

import { describe, test, expect } from 'bun:test';
import { formatRecipeTable, envReady, buildProviderExplainMatrix } from '../src/commands/providers.ts';
import { listRecipes, getRecipe } from '../src/core/ai/recipes/index.ts';
import type { Recipe } from '../src/core/ai/types.ts';

describe('envReady', () => {
  test('true when all required env vars set', () => {
    const openai = getRecipe('openai');
    expect(openai).toBeDefined();
    expect(envReady(openai!, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
  });

  test('false when required env var missing', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, {})).toBe(false);
  });

  test('false on empty-string env var', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, { OPENAI_API_KEY: '' })).toBe(false);
  });

  test('true for recipes with no required env (local Ollama)', () => {
    // Ollama has no auth_env.required.
    const ollama = getRecipe('ollama');
    expect(ollama).toBeDefined();
    expect(envReady(ollama!, {})).toBe(true);
  });

  test('Codex is ready with preferred GBRAIN_CODEX_ACCESS_TOKEN', () => {
    const codex = getRecipe('codex');
    expect(codex).toBeDefined();
    expect(envReady(codex!, { GBRAIN_CODEX_ACCESS_TOKEN: 'codex-token' })).toBe(true);
  });

  test('Codex is ready with fallback CODEX_ACCESS_TOKEN', () => {
    const codex = getRecipe('codex');
    expect(codex).toBeDefined();
    expect(envReady(codex!, { CODEX_ACCESS_TOKEN: 'codex-token' })).toBe(true);
  });

  test('Codex is not ready from OPENAI_API_KEY alone', () => {
    const codex = getRecipe('codex');
    expect(codex).toBeDefined();
    expect(envReady(codex!, { OPENAI_API_KEY: 'sk-test' })).toBe(false);
  });
});

describe('formatRecipeTable', () => {
  test('header row present', () => {
    const out = formatRecipeTable(listRecipes(), {});
    expect(out).toContain('PROVIDER');
    expect(out).toContain('TIER');
    expect(out).toContain('EMBED');
    expect(out).toContain('EXPAND');
    expect(out).toContain('CHAT');
    expect(out).toContain('STATUS');
  });

  test('shows ✓ ready for env-satisfied provider', () => {
    const out = formatRecipeTable(listRecipes(), { OPENAI_API_KEY: 'sk-test' });
    // openai row should be ready
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✓ ready');
  });

  test('shows ✗ missing <ENV> for missing provider', () => {
    const out = formatRecipeTable(listRecipes(), {});
    // openai should show missing OPENAI_API_KEY
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✗ missing OPENAI_API_KEY');
  });

  test('each recipe appears at most once', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const recipes = listRecipes();
    for (const r of recipes) {
      const occurrences = out.split('\n').filter(line => line.startsWith(`${r.id} `) || line.startsWith(`${r.id}  `));
      expect(occurrences.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('embedding-only recipe (zeroentropyai) shows yes/—/— for tiers', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const zeLine = out.split('\n').find(line => line.startsWith('zeroentropyai'));
    expect(zeLine).toBeDefined();
    // ZE has embedding but no expansion or chat
    expect(zeLine).toContain('yes');
    expect(zeLine).toContain('—');
  });

  test('Codex shows no embedding, with expansion and chat enabled', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const codexLine = out.split('\n').find(line => line.startsWith('codex'));
    expect(codexLine).toBeDefined();
    expect(codexLine).toContain('—');
    expect(codexLine).toContain('yes');
    expect(codexLine).toMatch(/codex\s+native\s+—\s+yes\s+yes\s+/);
  });

  test('Codex missing status names Codex token envs, not OPENAI_API_KEY', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const codexLine = out.split('\n').find(line => line.startsWith('codex'));
    expect(codexLine).toBeDefined();
    expect(codexLine).toContain('GBRAIN_CODEX_ACCESS_TOKEN');
    expect(codexLine).toMatch(/(?:or|fallback)[^\n]*\bCODEX_ACCESS_TOKEN\b|\bCODEX_ACCESS_TOKEN\b[^\n]*(?:or|fallback)/);
    expect(codexLine).not.toContain('OPENAI_API_KEY');
  });

  test('isolated subset renders correctly (picker reuses this)', () => {
    const openai = getRecipe('openai');
    const ze = getRecipe('zeroentropyai');
    expect(openai && ze).toBeTruthy();
    const out = formatRecipeTable([openai!, ze!], { OPENAI_API_KEY: 'sk-test' });
    const lines = out.split('\n');
    // header + separator + 2 recipe rows
    expect(lines.length).toBe(4);
    expect(lines[2]).toContain('openai');
    expect(lines[2]).toContain('✓ ready');
    expect(lines[3]).toContain('zeroentropyai');
    expect(lines[3]).toContain('✗ missing ZEROENTROPY_API_KEY');
  });
});

describe('providers explain matrix', () => {
  test('JSON env_detected includes Codex booleans without secret values', async () => {
    const secret = 'codex-secret-value';
    const matrix = await buildProviderExplainMatrix({
      env: {
        GBRAIN_CODEX_ACCESS_TOKEN: secret,
        CODEX_ACCESS_TOKEN: 'fallback-secret-value',
        GBRAIN_CODEX_BASE_URL: 'https://codex-proxy.example.test',
      } as NodeJS.ProcessEnv,
      ollama: { reachable: false, models_endpoint_valid: false },
      lmstudio: { reachable: false, models_endpoint_valid: false },
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(matrix.env_detected.GBRAIN_CODEX_ACCESS_TOKEN).toBe(true);
    expect(matrix.env_detected.CODEX_ACCESS_TOKEN).toBe(true);
    expect(matrix.env_detected.GBRAIN_CODEX_BASE_URL).toBe(true);
    const serialized = JSON.stringify(matrix);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('fallback-secret-value');
    expect(serialized).not.toContain('codex-proxy.example.test');
  });

  test('fallback CODEX_ACCESS_TOKEN makes Codex chat and expansion env_ready', async () => {
    const matrix = await buildProviderExplainMatrix({
      env: { CODEX_ACCESS_TOKEN: 'fallback-secret-value' } as NodeJS.ProcessEnv,
      ollama: { reachable: false, models_endpoint_valid: false },
      lmstudio: { reachable: false, models_endpoint_valid: false },
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    const codexChat = matrix.options.find(o => o.id === 'codex:gpt-5.5' && o.touchpoint === 'chat');
    const codexExpansion = matrix.options.find(o => o.id === 'codex:gpt-5.5' && o.touchpoint === 'expansion');
    expect(codexChat?.env_ready).toBe(true);
    expect(codexExpansion?.env_ready).toBe(true);
    expect(codexChat?.pros.join(' ')).toMatch(/Codex|prompt-cache|tool/i);
    expect(codexExpansion?.pros.join(' ')).toMatch(/Codex|text/i);
  });
});
