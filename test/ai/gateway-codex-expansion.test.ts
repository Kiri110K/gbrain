import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  expand,
  generateOcrText,
  resetGateway,
} from '../../src/core/ai/gateway.ts';

const CODEX_TOKEN = 'codex-test-token';
const OPENAI_TOKEN = 'openai-test-token-never-used';

type FetchCall = { url: string; init: RequestInit | undefined };

let realFetch: typeof fetch;
let realWarn: typeof console.warn;
let calls: FetchCall[];
let warns: string[];
let responseText: string;

function codexTextResponse(text: string): Record<string, unknown> {
  return {
    id: 'resp_gateway_codex_expansion_1',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: { input_tokens: 17, output_tokens: 9 },
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

function promptFromBody(body: Record<string, unknown>): string {
  const input = body.input as Array<{ content?: Array<{ text?: string }> }>;
  expect(Array.isArray(input)).toBe(true);
  expect(input).toHaveLength(1);
  expect(input[0].content?.[0]?.text).toBeString();
  return input[0].content![0].text!;
}

beforeEach(() => {
  resetGateway();
  calls = [];
  warns = [];
  responseText = JSON.stringify({ queries: ['Foo', 'bar baz', '  ', 'BAR BAZ', 'foo extra'] });
  realFetch = globalThis.fetch;
  realWarn = console.warn;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: urlOf(input), init });
    return new Response(JSON.stringify(codexTextResponse(responseText)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  console.warn = ((...args: unknown[]) => {
    warns.push(args.map(arg => String(arg)).join(' '));
  }) as typeof console.warn;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  resetGateway();
});

describe('gateway.expand Codex Responses routing', () => {
  test('unconfigured gateway falls back to the original query without throwing', async () => {
    resetGateway();

    await expect(expand('foo')).resolves.toEqual(['foo']);

    expect(calls).toHaveLength(0);
  });

  test('routes codex:gpt-5.5 expansion through Codex Responses and returns original plus deduped expansions', async () => {
    configureGateway({
      expansion_model: 'codex:gpt-5.5',
      env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
    });

    const result = await expand('foo');

    expect(result).toEqual(['foo', 'bar baz', 'foo extra']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(calls[0].init?.method).toBe('POST');
    expect(headerValue(calls[0].init?.headers, 'Authorization')).toBe(`Bearer ${CODEX_TOKEN}`);
    expect(headerValue(calls[0].init?.headers, 'Content-Type')).toBe('application/json');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);

    const body = bodyOf(calls[0]);
    expect(body).toMatchObject({
      model: 'gpt-5.5',
      store: false,
    });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();

    const prompt = promptFromBody(body);
    expect(prompt).toContain('Return ONLY the JSON object');
    expect(prompt).toContain('queries');
    expect(prompt).toContain('Do NOT include the original query');
    expect(prompt).toContain('Query: foo');
  });

  test('ignores OPENAI_API_KEY and uses the Codex token for Codex expansion', async () => {
    configureGateway({
      expansion_model: 'codex:gpt-5.5',
      env: {
        GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN,
        OPENAI_API_KEY: OPENAI_TOKEN,
      },
    });

    await expand('openai key ignored');

    expect(calls).toHaveLength(1);
    const auth = headerValue(calls[0].init?.headers, 'Authorization');
    expect(auth).toBe(`Bearer ${CODEX_TOKEN}`);
    expect(auth).not.toContain(OPENAI_TOKEN);
    expect(JSON.stringify(bodyOf(calls[0]))).not.toContain(OPENAI_TOKEN);
  });

  test('malformed JSON model text falls back to the original query', async () => {
    responseText = '{not valid json';
    configureGateway({
      expansion_model: 'codex:gpt-5.5',
      env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
    });

    await expect(expand('foo')).resolves.toEqual(['foo']);
    expect(calls).toHaveLength(1);
  });

  test('schema-invalid JSON model text falls back to the original query', async () => {
    responseText = JSON.stringify({ queries: [] });
    configureGateway({
      expansion_model: 'codex:gpt-5.5',
      env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
    });

    await expect(expand('foo')).resolves.toEqual(['foo']);
    expect(calls).toHaveLength(1);
  });

  test('missing Codex token falls back without calling fetch and warns without leaking unrelated tokens', async () => {
    configureGateway({
      expansion_model: 'codex:gpt-5.5',
      env: { OPENAI_API_KEY: OPENAI_TOKEN },
    });

    await expect(expand('foo')).resolves.toEqual(['foo']);

    expect(calls).toHaveLength(0);
    expect(warns.length).toBeGreaterThan(0);
    const warningText = warns.join('\n');
    expect(warningText).toContain('GBRAIN_CODEX_ACCESS_TOKEN');
    expect(warningText).toContain('CODEX_ACCESS_TOKEN');
    expect(warningText).not.toContain(OPENAI_TOKEN);
  });

  test('Codex expansion model is skipped safely for OCR without calling network', async () => {
    configureGateway({
      expansion_model: 'codex:gpt-5.5',
      env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
    });

    await expect(generateOcrText(Buffer.from('fake png bytes'), 'image/png')).resolves.toBe('');

    expect(calls).toHaveLength(0);
    const warningText = warns.join('\n');
    expect(warningText).toContain('OCR disabled');
    expect(warningText).toContain('Codex Responses');
  });
});
