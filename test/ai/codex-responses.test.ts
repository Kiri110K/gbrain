import { describe, expect, test } from 'bun:test';
import {
  codexChat,
  normalizeCodexResponse,
  redactCodexSecrets,
  toCodexInput,
  toCodexTools,
  type CodexResponsesConfig,
} from '../../src/core/ai/codex-responses.ts';
import { resolveCodexProfile } from '../../src/core/ai/codex-profiles.ts';
import { AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';
import type { ChatMessage, ChatToolDef } from '../../src/core/ai/gateway.ts';
import { withEnv } from '../helpers/with-env.ts';

const CODEX_ACCESS_TOKEN = 'codex-...ask5';

function baseCodexCfg(overrides: Partial<CodexResponsesConfig> = {}): CodexResponsesConfig {
  return {
    baseURL: 'https://codex.example.test/v1///',
    accessToken: CODEX_ACCESS_TOKEN,
    model: 'gpt-5.5',
    ...overrides,
  };
}

function codexTextResponse(text = 'Mocked Codex response.'): Record<string, unknown> {
  return {
    id: 'resp_mock_1',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: { input_tokens: 7, output_tokens: 3 },
  };
}

function installFetchStub(
  handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    return await handler(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function installJsonResponseFetch(response: unknown, status = 200): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const restore = installFetchStub((input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { calls, restore };
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

function parseRequestBody(call: { init: RequestInit | undefined }): Record<string, unknown> {
  expect(typeof call.init?.body).toBe('string');
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

async function expectCodexError(
  promise: Promise<unknown>,
  ErrorClass: typeof AIConfigError | typeof AITransientError,
): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ErrorClass);
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error('Expected codexChat to throw');
}

describe('Codex Responses adapter', () => {
  test('plain text user/system/assistant messages convert to Responses input items', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Keep answers short.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there.' }] },
    ];

    expect(toCodexInput(messages)).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'Keep answers short.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Hi there.' }] },
    ]);
  });

  test('GBrain tool-call blocks convert into Codex function-call history items', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_search_1',
            toolName: 'search_brain',
            input: { query: 'codex adapter', limit: 3 },
          },
        ],
      },
    ];

    expect(toCodexInput(messages)).toEqual([
      {
        type: 'function_call',
        call_id: 'call_search_1',
        name: 'search_brain',
        arguments: '{"query":"codex adapter","limit":3}',
      },
    ]);
  });

  test('GBrain tool-result blocks convert into Codex function-call output items', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_search_1',
            toolName: 'search_brain',
            output: { hits: ['doc-1'], total: 1 },
          },
        ],
      },
    ];

    expect(toCodexInput(messages)).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_search_1',
        output: '{"hits":["doc-1"],"total":1}',
      },
    ]);
  });

  test('tool definitions convert from ChatToolDef JSON Schema to Responses function tools', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['query'],
      additionalProperties: false,
    } as const;
    const tools: ChatToolDef[] = [
      {
        name: 'search_brain',
        description: 'Search indexed notes.',
        inputSchema: schema,
      },
    ];

    expect(toCodexTools(tools)).toEqual([
      {
        type: 'function',
        name: 'search_brain',
        description: 'Search indexed notes.',
        parameters: schema,
        strict: false,
      },
    ]);
    expect(toCodexTools(undefined)).toBeUndefined();
    expect(toCodexTools([])).toBeUndefined();
  });

  test('text response normalizes to ChatResult text block, end stop reason, usage, model, and provider', () => {
    const result = normalizeCodexResponse({
      providerId: 'codex',
      modelId: 'gpt-5.5',
      response: {
        id: 'resp_text_1',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Codex says hello.' }],
          },
        ],
        usage: { input_tokens: 11, output_tokens: 4 },
      },
    });

    expect(result).toEqual({
      text: 'Codex says hello.',
      blocks: [{ type: 'text', text: 'Codex says hello.' }],
      stopReason: 'end',
      usage: {
        input_tokens: 11,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: 'codex:gpt-5.5',
      providerId: 'codex',
    });
  });

  test('function-call response normalizes to parsed tool-call block and tool_calls stop reason', () => {
    const result = normalizeCodexResponse({
      providerId: 'codex',
      modelId: 'gpt-5.5',
      response: {
        output: [
          {
            type: 'function_call',
            call_id: 'call_lookup_1',
            name: 'lookup',
            arguments: '{"slug":"codex-responses"}',
          },
        ],
        usage: { inputTokens: 8, outputTokens: 2 },
      },
    });

    expect(result.text).toBe('');
    expect(result.blocks).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call_lookup_1',
        toolName: 'lookup',
        input: { slug: 'codex-responses' },
      },
    ]);
    expect(result.stopReason).toBe('tool_calls');
    expect(result.usage).toEqual({
      input_tokens: 8,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  test('invalid JSON function-call arguments become safe string payloads without throwing', () => {
    const result = normalizeCodexResponse({
      providerId: 'codex',
      modelId: 'gpt-5.5',
      response: {
        output: [
          {
            type: 'function_call',
            call_id: 'call_bad_json',
            name: 'lookup',
            arguments: '{not valid json',
          },
        ],
      },
    });

    expect(result.blocks).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call_bad_json',
        toolName: 'lookup',
        input: '{not valid json',
      },
    ]);
    expect(result.stopReason).toBe('tool_calls');
  });

  test('redactCodexSecrets redacts bearer tokens and explicit secret strings', () => {
    const redacted = redactCodexSecrets(
      'request failed: Authorization: Bearer codex-...ken; raw=codex-secret-token',
      ['codex-secret-token'],
    );

    expect(redacted).toContain('Authorization: Bearer ***');
    expect(redacted).toContain('raw=[REDACTED]');
    expect(redacted).not.toContain('codex-secret-token');
  });
});

describe('codexChat HTTP transport', () => {
  test('successful POST uses /responses, bearer auth, JSON body, ignores OPENAI_API_KEY, and returns ChatResult', async () => {
    const { calls, restore } = installJsonResponseFetch(codexTextResponse('Codex says hello.'));
    try {
      await withEnv({ OPENAI_API_KEY: 'sk-ope...used' }, async () => {
        const result = await codexChat({
          cfg: baseCodexCfg(),
          system: 'Keep answers short.',
          messages: [{ role: 'user', content: 'Hello' }],
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://codex.example.test/v1/responses');
        expect(calls[0].init?.method).toBe('POST');
        expect(headerValue(calls[0].init?.headers, 'Authorization')).toBe(
          `Bearer ${CODEX_ACCESS_TOKEN}`,
        );
        expect(headerValue(calls[0].init?.headers, 'Authorization')).not.toContain(
          'sk-ope...used',
        );
        expect(headerValue(calls[0].init?.headers, 'Content-Type')).toBe('application/json');

        const body = parseRequestBody(calls[0]);
        expect(body).toMatchObject({
          model: 'gpt-5.5',
          instructions: 'Keep answers short.',
          input: toCodexInput([{ role: 'user', content: 'Hello' }]),
          stream: true,
          store: false,
          reasoning: { effort: 'medium', summary: 'auto' },
        });
        expect(body.max_output_tokens).toBeUndefined();
        expect(result).toEqual({
          text: 'Codex says hello.',
          blocks: [{ type: 'text', text: 'Codex says hello.' }],
          stopReason: 'end',
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          model: 'codex:gpt-5.5',
          providerId: 'codex',
        });
      });
    } finally {
      restore();
    }
  });

  test('default instructions are sent when no system prompt is provided', async () => {
    const { calls, restore } = installJsonResponseFetch(codexTextResponse());
    try {
      await codexChat({
        cfg: baseCodexCfg(),
        messages: [{ role: 'user', content: 'No system prompt.' }],
      });

      const body = parseRequestBody(calls[0]);
      expect(body.instructions).toBe('Follow the user request.');
    } finally {
      restore();
    }
  });

  test('streaming SSE response normalizes to ChatResult', async () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      '',
      'data: {"type":"response.output_text.delta","delta":" from stream."}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":5,"output_tokens":4}}}',
      '',
    ].join('\n');
    const restore = installFetchStub(() => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    try {
      const result = await codexChat({
        cfg: baseCodexCfg(),
        messages: [{ role: 'user', content: 'Stream please.' }],
      });

      expect(result.text).toBe('Hello from stream.');
      expect(result.blocks).toEqual([{ type: 'text', text: 'Hello from stream.' }]);
      expect(result.usage).toEqual({
        input_tokens: 5,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      });
      expect(result.stopReason).toBe('end');
    } finally {
      restore();
    }
  });

  test('streaming SSE can use final response output when no text deltas were emitted', async () => {
    const sse = [
      'data: {"type":"response.completed","response":{"id":"resp_final","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Final only."}]}],"usage":{"input_tokens":6,"output_tokens":2}}}',
      '',
    ].join('\n');
    const restore = installFetchStub(() => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    try {
      const result = await codexChat({
        cfg: baseCodexCfg(),
        messages: [{ role: 'user', content: 'Final only please.' }],
      });

      expect(result.text).toBe('Final only.');
      expect(result.stopReason).toBe('end');
    } finally {
      restore();
    }
  });

  test('streaming SSE error events are redacted before throwing', async () => {
    const providerBearerToken = 'provider-stream-secret';
    const sse = [
      `data: {"type":"error","message":"raw=${CODEX_ACCESS_TOKEN}; Authorization: Bearer ${providerBearerToken}"}`,
      '',
    ].join('\n');
    const restore = installFetchStub(() => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    try {
      const err = await expectCodexError(
        codexChat({
          cfg: baseCodexCfg(),
          messages: [{ role: 'user', content: 'Stream error.' }],
        }),
        AITransientError,
      );

      expect(err.message).toContain('Codex Responses stream error');
      expect(err.message).not.toContain(CODEX_ACCESS_TOKEN);
      expect(err.message).not.toContain(providerBearerToken);
      expect(err.message).toContain('[REDACTED]');
      expect(err.message).toContain('Authorization: Bearer ***');
    } finally {
      restore();
    }
  });

  test('streaming SSE failed terminal responses throw instead of normalizing as success', async () => {
    const sse = [
      'data: {"type":"response.failed","response":{"id":"resp_failed","status":"failed","error":{"message":"backend failed"},"usage":{"input_tokens":6,"output_tokens":0}}}',
      '',
    ].join('\n');
    const restore = installFetchStub(() => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    try {
      const err = await expectCodexError(
        codexChat({
          cfg: baseCodexCfg(),
          messages: [{ role: 'user', content: 'Stream failed.' }],
        }),
        AITransientError,
      );

      expect(err.message).toContain('Codex Responses stream failed');
      expect(err.message).toContain('backend failed');
    } finally {
      restore();
    }
  });

  test('streaming SSE truncated after deltas throws instead of returning partial success', async () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      '',
    ].join('\n');
    const restore = installFetchStub(() => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    try {
      const err = await expectCodexError(
        codexChat({
          cfg: baseCodexCfg(),
          messages: [{ role: 'user', content: 'Truncate.' }],
        }),
        AITransientError,
      );

      expect(err.message).toContain('did not emit a terminal response event');
    } finally {
      restore();
    }
  });

  test('tools fields are omitted when no tools are passed', async () => {
    const { calls, restore } = installJsonResponseFetch(codexTextResponse());
    try {
      await codexChat({
        cfg: baseCodexCfg(),
        messages: [{ role: 'user', content: 'No tools needed.' }],
      });

      const body = parseRequestBody(calls[0]);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.parallel_tool_calls).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('tools, tool_choice, and parallel_tool_calls are included when tools are passed', async () => {
    const { calls, restore } = installJsonResponseFetch(codexTextResponse());
    const tools: ChatToolDef[] = [
      {
        name: 'search_brain',
        description: 'Search indexed notes.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ];

    try {
      await codexChat({
        cfg: baseCodexCfg(),
        messages: [{ role: 'user', content: 'Use a tool.' }],
        tools,
      });

      const body = parseRequestBody(calls[0]);
      expect(body.tools).toEqual(toCodexTools(tools));
      expect(body.tool_choice).toBe('auto');
      expect(body.parallel_tool_calls).toBe(true);
    } finally {
      restore();
    }
  });

  test('runtime profile options are lowered into the request body', async () => {
    const { calls, restore } = installJsonResponseFetch(codexTextResponse());
    const profile = resolveCodexProfile('gpt-5.5-xhigh-fast');
    const tools: ChatToolDef[] = [
      {
        name: 'lookup',
        description: 'Lookup a thing.',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ];

    try {
      const result = await codexChat({
        cfg: baseCodexCfg({
          model: profile.providerModelId,
          profileModel: profile.displayModelId,
          runtime: profile.runtime,
        }),
        messages: [{ role: 'user', content: 'Use a fast deep profile.' }],
        tools,
      });

      const body = parseRequestBody(calls[0]);
      expect(body.model).toBe('gpt-5.5');
      expect(body.store).toBe(false);
      expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
      expect(body.service_tier).toBe('priority');
      expect(body.tool_choice).toBe('auto');
      expect(body.parallel_tool_calls).toBe(true);
      expect(result.model).toBe('codex:gpt-5.5-xhigh-fast');
      expect(result.providerMetadata?.codex).toMatchObject({ profileModel: 'gpt-5.5-xhigh-fast' });
    } finally {
      restore();
    }
  });

  test('prompt cache key is sent when configured and cached-token usage is normalized', async () => {
    const { calls, restore } = installJsonResponseFetch({
      ...codexTextResponse('Cached response.'),
      usage: {
        input_tokens: 4096,
        output_tokens: 7,
        input_tokens_details: { cached_tokens: 3072 },
      },
    });
    try {
      const result = await codexChat({
        cfg: baseCodexCfg({
          promptCacheKey: 'gbrain-subagent-42',
          runtime: resolveCodexProfile('gpt-5.5-medium-fast').runtime,
        }),
        messages: [{ role: 'user', content: 'Use cache routing.' }],
      });

      const body = parseRequestBody(calls[0]);
      expect(body.prompt_cache_key).toBe('gbrain-subagent-42');
      expect(body.service_tier).toBeUndefined();
      expect(headerValue(calls[0].init?.headers, 'session_id')).toBe('gbrain-subagent-42');
      expect(headerValue(calls[0].init?.headers, 'session-id')).toBe('gbrain-subagent-42');
      expect(headerValue(calls[0].init?.headers, 'thread-id')).toBe('gbrain-subagent-42');
      expect(headerValue(calls[0].init?.headers, 'x-client-request-id')).toBe('gbrain-subagent-42');
      expect(result.usage).toEqual({
        input_tokens: 4096,
        output_tokens: 7,
        cache_read_tokens: 3072,
        cache_creation_tokens: 0,
      });
    } finally {
      restore();
    }
  });

  test('max_output_tokens is omitted because the ChatGPT Codex backend rejects it', async () => {
    const { calls, restore } = installJsonResponseFetch(codexTextResponse());
    try {
      for (const maxOutputTokens of [128, 0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
        await codexChat({
          cfg: baseCodexCfg({ maxOutputTokens }),
          messages: [{ role: 'user', content: `max=${String(maxOutputTokens)}` }],
        });
      }

      for (const call of calls) {
        expect(parseRequestBody(call).max_output_tokens).toBeUndefined();
      }
    } finally {
      restore();
    }
  });

  test('401/403 responses throw AIConfigError with redacted message and no raw token', async () => {
    for (const status of [401, 403]) {
      const providerBearerToken = `provider-secret-${status}`;
      const restore = installFetchStub(() => new Response(
        `status=${status}; raw=${CODEX_ACCESS_TOKEN}; Authorization: Bearer ${providerBearerToken}`,
        { status },
      ));
      try {
        const err = await expectCodexError(
          codexChat({
            cfg: baseCodexCfg(),
            messages: [{ role: 'user', content: 'Auth failure.' }],
          }),
          AIConfigError,
        );

        expect(err.message).toContain(`status ${status}`);
        expect(err.message).not.toContain(CODEX_ACCESS_TOKEN);
        expect(err.message).not.toContain(providerBearerToken);
        expect(err.message).toContain('[REDACTED]');
      } finally {
        restore();
      }
    }
  });

  test('429 response throws AITransientError with redacted message and no raw token', async () => {
    const providerBearerToken = 'provider-rate-token';
    const restore = installFetchStub(() => new Response(
      `rate limited raw=${CODEX_ACCESS_TOKEN}; Authorization: Bearer ${providerBearerToken}`,
      { status: 429 },
    ));
    try {
      const err = await expectCodexError(
        codexChat({
          cfg: baseCodexCfg(),
          messages: [{ role: 'user', content: 'Rate limit.' }],
        }),
        AITransientError,
      );

      expect(err.message).toContain('status 429');
      expect(err.message).not.toContain(CODEX_ACCESS_TOKEN);
      expect(err.message).not.toContain(providerBearerToken);
      expect(err.message).toContain('[REDACTED]');
    } finally {
      restore();
    }
  });

  test('fetch/network error throws AITransientError and redacts raw token from message', async () => {
    const providerBearerToken = 'provider-network-token';
    const restore = installFetchStub(() => {
      throw new Error(
        `socket failed for ${CODEX_ACCESS_TOKEN}; Authorization: Bearer ${providerBearerToken}`,
      );
    });
    try {
      const err = await expectCodexError(
        codexChat({
          cfg: baseCodexCfg(),
          messages: [{ role: 'user', content: 'Network failure.' }],
        }),
        AITransientError,
      );

      expect(err.message).not.toContain(CODEX_ACCESS_TOKEN);
      expect(err.message).not.toContain(providerBearerToken);
      expect(err.message).toContain('[REDACTED]');
    } finally {
      restore();
    }
  });

  test('invalid JSON success body throws AITransientError with redacted message and no raw token', async () => {
    const providerBearerToken = 'provider-json-token';
    const restore = installFetchStub(() => new Response(
      `not-json raw=${CODEX_ACCESS_TOKEN}; Authorization: Bearer ${providerBearerToken}`,
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    try {
      const err = await expectCodexError(
        codexChat({
          cfg: baseCodexCfg(),
          messages: [{ role: 'user', content: 'Bad JSON.' }],
        }),
        AITransientError,
      );

      expect(err.message).toContain('invalid JSON');
      expect(err.message).not.toContain(CODEX_ACCESS_TOKEN);
      expect(err.message).not.toContain(providerBearerToken);
      expect(err.message).toContain('[REDACTED]');
    } finally {
      restore();
    }
  });

  test('cfg.signal is forwarded to fetch', async () => {
    const { calls, restore } = installJsonResponseFetch(codexTextResponse());
    const controller = new AbortController();
    try {
      await codexChat({
        cfg: baseCodexCfg({ signal: controller.signal }),
        messages: [{ role: 'user', content: 'Forward signal.' }],
      });

      expect(calls[0].init?.signal).toBe(controller.signal);
    } finally {
      restore();
    }
  });
});
