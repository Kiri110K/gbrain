import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chat,
  configureGateway,
  resetGateway,
  type ChatToolDef,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

const CODEX_TOKEN = 'codex-test-token';
const OPENAI_TOKEN = 'openai-test-token-never-used';

type FetchCall = { url: string; init: RequestInit | undefined };

let realFetch: typeof fetch;
let calls: FetchCall[];
let responseText: string;

function codexTextResponse(text = 'Gateway Codex response.'): Record<string, unknown> {
  return {
    id: 'resp_gateway_codex_1',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: { input_tokens: 13, output_tokens: 5 },
  };
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === lower);
    return found?.[1];
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === lower);
  return key ? record[key] : undefined;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  expect(typeof call.init?.body).toBe('string');
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

async function expectRejectsConfigError(promise: Promise<unknown>): Promise<AIConfigError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AIConfigError);
    return err as AIConfigError;
  }
  throw new Error('Expected chat() to throw AIConfigError');
}

beforeEach(() => {
  resetGateway();
  calls = [];
  responseText = 'Gateway Codex response.';
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: urlOf(input), init });
    return new Response(JSON.stringify(codexTextResponse(responseText)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetGateway();
});

describe('gateway.chat Codex routing', () => {
  test('routes configured codex:gpt-5.5 chat through Codex Responses and returns ChatResult', async () => {
    responseText = 'Hello from gateway Codex.';
    configureGateway({
      chat_model: 'codex:gpt-5.5',
      env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
    });

    const result = await chat({
      system: 'Answer tersely.',
      messages: [{ role: 'user', content: 'Say hello.' }],
      maxTokens: 777,
    });

    expect(result.text).toBe('Hello from gateway Codex.');
    expect(result.model).toBe('codex:gpt-5.5');
    expect(result.providerId).toBe('codex');
    expect(result.usage).toEqual({
      input_tokens: 13,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(calls[0].init?.method).toBe('POST');
    expect(headerValue(calls[0].init?.headers, 'Authorization')).toBe(`Bearer ${CODEX_TOKEN}`);
    expect(headerValue(calls[0].init?.headers, 'Content-Type')).toBe('application/json');

    const body = bodyOf(calls[0]);
    expect(body).toMatchObject({
      model: 'gpt-5.5',
      instructions: 'Answer tersely.',
      store: false,
      reasoning: { effort: 'medium', summary: 'auto' },
      stream: true,
    });
    expect(body.max_output_tokens).toBe(777);
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] },
    ]);
  });

  test('scoped Codex profile sends base model plus runtime options and preserves display id', async () => {
    configureGateway({
      chat_model: 'codex:gpt-5.5-xhigh-fast',
      env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
    });

    const result = await chat({
      messages: [{ role: 'user', content: 'Use scoped profile.' }],
      tools: [
        {
          name: 'lookup',
          description: 'Lookup a thing.',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
    });

    expect(result.model).toBe('codex:gpt-5.5-xhigh-fast');
    expect(result.providerMetadata?.codex).toMatchObject({
      providerModel: 'gpt-5.5',
      profileModel: 'gpt-5.5-xhigh-fast',
    });

    const body = bodyOf(calls[0]);
    expect(body.model).toBe('gpt-5.5');
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(body.store).toBe(false);
    expect(body.service_tier).toBe('priority');
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
  });

  test('omits max_output_tokens on default Codex chat requests', async () => {
    configureGateway({
      chat_model: 'codex:gpt-5.5',
      env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
    });

    await chat({ messages: [{ role: 'user', content: 'Use the default token ceiling.' }] });

    const body = bodyOf(calls[0]);
    expect(body.max_output_tokens).toBeUndefined();
  });

  test('cacheSystem forwards prompt_cache_key to Codex Responses', async () => {
    configureGateway({
      chat_model: 'codex:gpt-5.5-medium-fast',
      env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
    });

    await chat({
      messages: [{ role: 'user', content: 'Use prompt cache routing.' }],
      cacheSystem: true,
      promptCacheKey: 'gbrain-subagent-99',
    });

    const body = bodyOf(calls[0]);
    expect(body.prompt_cache_key).toBe('gbrain-subagent-99');
    expect(body.service_tier).toBe('priority');
  });

  test('invalid scoped Codex profile suffix fails before any network call', async () => {
    configureGateway({
      chat_model: 'codex:gpt-5.5-ultra-fast',
      env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
    });

    const err = await expectRejectsConfigError(
      chat({ messages: [{ role: 'user', content: 'Bad profile.' }] }),
    );

    expect(err.message).toContain('Unknown Codex profile');
    expect(calls).toHaveLength(0);
  });

  test('uses the Codex token and ignores OPENAI_API_KEY for Codex chat', async () => {
    configureGateway({
      chat_model: 'codex:gpt-5.5',
      env: {
        GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN,
        OPENAI_API_KEY: OPENAI_TOKEN,
      },
    });

    await chat({ messages: [{ role: 'user', content: 'Do not use OpenAI API key.' }] });

    const auth = headerValue(calls[0].init?.headers, 'Authorization');
    expect(auth).toBe(`Bearer ${CODEX_TOKEN}`);
    expect(auth).not.toContain(OPENAI_TOKEN);
    expect(JSON.stringify(bodyOf(calls[0]))).not.toContain(OPENAI_TOKEN);
  });

  test('base_urls.codex override wins over GBRAIN_CODEX_BASE_URL', async () => {
    configureGateway({
      chat_model: 'codex:gpt-5.5',
      base_urls: { codex: 'https://override.example.test/codex///' },
      env: {
        GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN,
        GBRAIN_CODEX_BASE_URL: 'https://env.example.test/codex///',
      },
    });

    await chat({ messages: [{ role: 'user', content: 'Use configured override.' }] });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://override.example.test/codex/responses');
  });

  test('GBRAIN_CODEX_BASE_URL wins over the recipe default when no base_urls override is set', async () => {
    configureGateway({
      chat_model: 'codex:gpt-5.5',
      env: {
        GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN,
        GBRAIN_CODEX_BASE_URL: 'https://env.example.test/codex///',
      },
    });

    await chat({ messages: [{ role: 'user', content: 'Use env base URL.' }] });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://env.example.test/codex/responses');
  });

  test('missing Codex token throws AIConfigError with Codex env hint and without leaking other tokens', async () => {
    configureGateway({
      chat_model: 'codex:gpt-5.5',
      env: { OPENAI_API_KEY: OPENAI_TOKEN },
    });

    const err = await expectRejectsConfigError(
      chat({ messages: [{ role: 'user', content: 'This should not reach fetch.' }] }),
    );

    expect(err.message).toContain('GBRAIN_CODEX_ACCESS_TOKEN');
    expect(err.message).toContain('CODEX_ACCESS_TOKEN');
    expect(err.fix ?? '').toContain('GBRAIN_CODEX_ACCESS_TOKEN');
    expect(`${err.message}\n${err.fix ?? ''}`).not.toContain(OPENAI_TOKEN);
    expect(calls).toHaveLength(0);
  });

  test('passes gateway tool definitions through to the Codex request body', async () => {
    const tools: ChatToolDef[] = [
      {
        name: 'search_brain',
        description: 'Search indexed notes.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer', minimum: 1 },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ];
    configureGateway({
      chat_model: 'codex:gpt-5.5',
      env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
    });

    await chat({
      messages: [{ role: 'user', content: 'Search with a tool.' }],
      tools,
    });

    const body = bodyOf(calls[0]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'search_brain',
        description: 'Search indexed notes.',
        parameters: tools[0].inputSchema,
        strict: false,
      },
    ]);
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
  });
});
