import { describe, it, expect } from 'bun:test';
import { getProviderCapabilities, classifyCapabilities } from '../../src/core/ai/capabilities.ts';

describe('getProviderCapabilities (v0.38 Slice 1 — D6/D7 recipe-driven capabilities)', () => {
  it('returns full capabilities for Anthropic (canonical reference)', () => {
    const caps = getProviderCapabilities('anthropic:claude-sonnet-4-6');
    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.supportsSubagentLoop).toBe(true);
    expect(caps.supportsPromptCaching).toBe(true);
    expect(caps.supportsParallelTools).toBe(true);
    expect(caps.maxContext).toBe(200000);
  });

  it('returns capabilities for OpenAI (no prompt caching field set as true)', () => {
    const caps = getProviderCapabilities('openai:gpt-5.2');
    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.supportsSubagentLoop).toBe(true);
    expect(caps.supportsPromptCaching).toBe(false); // OpenAI implicit caching doesn't get marked
    expect(caps.maxContext).toBe(200000);
  });

  it('returns capabilities for Google Gemini', () => {
    const caps = getProviderCapabilities('google:gemini-1.5-pro');
    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.supportsSubagentLoop).toBe(true);
    expect(caps.supportsPromptCaching).toBe(false);
    expect(caps.maxContext).toBe(1000000); // Gemini 1.5 Pro
  });

  it('returns capabilities for Codex chat with subagent-loop replay safety approved', () => {
    const caps = getProviderCapabilities('codex:gpt-5.5');
    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.supportsSubagentLoop).toBe(true);
    expect(caps.supportsPromptCaching).toBe(false);
    expect(caps.maxContext).toBe(200000);
  });

  it('returns capabilities for Codex scoped profiles using the base model', () => {
    const caps = getProviderCapabilities('codex:gpt-5.5-xhigh-fast');
    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.supportsSubagentLoop).toBe(true);
    expect(caps.supportsPromptCaching).toBe(false);
    expect(caps.maxContext).toBe(200000);
  });

  it('honors Anthropic alias (undated → dated)', () => {
    const caps = getProviderCapabilities('anthropic:claude-haiku-4-5');
    expect(caps.supportsToolCalling).toBe(true);
  });

  it('throws for unknown provider', () => {
    expect(() => getProviderCapabilities('madeup-provider:foo')).toThrow();
  });

  it('throws for embedding-only provider (no chat touchpoint)', () => {
    expect(() => getProviderCapabilities('voyage:voyage-3-large')).toThrow(
      /does not offer a chat touchpoint/,
    );
  });

  it('throws for missing colon', () => {
    expect(() => getProviderCapabilities('claude-sonnet-4-6')).toThrow(/missing a provider prefix/);
  });
});

describe('classifyCapabilities (D6 — three-tier capability verdict)', () => {
  it('returns ok for fully-capable Anthropic models', () => {
    expect(classifyCapabilities('anthropic:claude-sonnet-4-6')).toBe('ok');
    expect(classifyCapabilities('anthropic:claude-opus-4-7')).toBe('ok');
  });

  it('returns degraded:no_caching for OpenAI (tools yes, caching no)', () => {
    expect(classifyCapabilities('openai:gpt-5.2')).toBe('degraded:no_caching');
  });

  it('returns degraded:no_caching for Google Gemini', () => {
    expect(classifyCapabilities('google:gemini-1.5-pro')).toBe('degraded:no_caching');
  });

  it('returns degraded:no_caching for Codex after autonomous loop replay safety coverage', () => {
    expect(classifyCapabilities('codex:gpt-5.5')).toBe('degraded:no_caching');
  });

  it('returns degraded:no_caching for Codex scoped profiles after autonomous loop replay safety coverage', () => {
    expect(classifyCapabilities('codex:gpt-5.5-xhigh-fast')).toBe('degraded:no_caching');
    expect(classifyCapabilities('codex:gpt-5.5-medium-fast')).toBe('degraded:no_caching');
  });

  it('returns unknown for invalid Codex profile suffixes', () => {
    expect(classifyCapabilities('codex:gpt-5.5-ultra-fast')).toBe('unknown');
  });

  it('returns unusable:no_subagent_loop for chat/tool providers not approved for autonomous loops', () => {
    expect(classifyCapabilities('openrouter:openai/gpt-5.2')).toBe('unusable:no_subagent_loop');
  });

  it('returns unknown for unrecognized providers', () => {
    expect(classifyCapabilities('madeup:something')).toBe('unknown');
  });

  it('returns unknown for embedding-only providers (chat touchpoint missing)', () => {
    // Voyage has no chat touchpoint → throws inside getProviderCapabilities
    // → classifyCapabilities catches → returns 'unknown'.
    expect(classifyCapabilities('voyage:voyage-3-large')).toBe('unknown');
  });
});
