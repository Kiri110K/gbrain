import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  toolLoop,
  type ChatToolDef,
  type ToolHandler,
} from '../../src/core/ai/gateway.ts';

const CODEX_TOKEN = 'codex-test-token';

type FetchCall = { url: string; init: RequestInit | undefined };

type CodexResponse = Record<string, unknown>;

let realFetch: typeof fetch;
let calls: FetchCall[];
let responses: CodexResponse[];

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBody(call: FetchCall): Record<string, unknown> {
  expect(typeof call.init?.body).toBe('string');
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function functionCallResponse(input: {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
}): CodexResponse {
  return {
    id: 'resp_codex_tool_call',
    status: 'completed',
    output: [
      {
        type: 'function_call',
        call_id: input.callId,
        name: input.name,
        arguments: JSON.stringify(input.args),
      },
    ],
    usage: {
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
    },
  };
}

function finalTextResponse(text: string, usage: { inputTokens: number; outputTokens: number }): CodexResponse {
  return {
    id: 'resp_codex_final',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    },
  };
}

const lookupTool: ChatToolDef = {
  name: 'lookup_brain',
  description: 'Look up a note in the brain.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

beforeEach(() => {
  resetGateway();
  calls = [];
  responses = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: urlOf(input), init });
    const response = responses.shift();
    if (!response) {
      return new Response(JSON.stringify({ error: 'unexpected fetch call' }), { status: 500 });
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  configureGateway({
    chat_model: 'codex:gpt-5.5-medium-fast',
    env: { GBRAIN_CODEX_ACCESS_TOKEN: CODEX_TOKEN },
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetGateway();
});

describe('gateway.toolLoop Codex Responses transport', () => {
  test('executes one Codex function_call, returns final text, and sends Codex wire-format tool history', async () => {
    responses = [
      functionCallResponse({
        callId: 'call_lookup_1',
        name: 'lookup_brain',
        args: { query: 'codex replay safety' },
        inputTokens: 11,
        outputTokens: 4,
      }),
      finalTextResponse('Codex final answer.', { inputTokens: 17, outputTokens: 6 }),
    ];

    let handlerCalls = 0;
    const handler: ToolHandler = {
      idempotent: true,
      async execute(input) {
        handlerCalls++;
        expect(input).toEqual({ query: 'codex replay safety' });
        return { ok: true, slug: 'notes/codex-replay-safety' };
      },
    };

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'Look up codex replay safety.' }],
      tools: [lookupTool],
      toolHandlers: new Map([['lookup_brain', handler]]),
      cacheSystem: true,
      promptCacheKey: 'gbrain-subagent-123',
    });

    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('Codex final answer.');
    expect(handlerCalls).toBe(1);
    expect(result.totalUsage).toEqual({
      input_tokens: 28,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(calls[1].url).toBe('https://chatgpt.com/backend-api/codex/responses');

    const firstBody = requestBody(calls[0]);
    expect(firstBody.model).toBe('gpt-5.5');
    expect(firstBody.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(firstBody.service_tier).toBeUndefined();
    expect(firstBody.prompt_cache_key).toBe('gbrain-subagent-123');
    expect(firstBody.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Look up codex replay safety.' }] },
    ]);

    const secondBody = requestBody(calls[1]);
    expect(secondBody.prompt_cache_key).toBe('gbrain-subagent-123');
    expect(secondBody.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Look up codex replay safety.' }] },
      {
        type: 'function_call',
        call_id: 'call_lookup_1',
        name: 'lookup_brain',
        arguments: '{"query":"codex replay safety"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_lookup_1',
        output: '{"ok":true,"slug":"notes/codex-replay-safety"}',
      },
    ]);
  });

  test('replay reuses a complete prior Codex tool output without re-executing a non-idempotent handler', async () => {
    responses = [
      functionCallResponse({
        callId: 'call_charge_1',
        name: 'charge_card',
        args: { invoiceId: 'inv_test_123' },
        inputTokens: 5,
        outputTokens: 2,
      }),
      finalTextResponse('Prior charge output accepted.', { inputTokens: 7, outputTokens: 3 }),
    ];

    let handlerCalls = 0;
    const nonIdempotentHandler: ToolHandler = {
      idempotent: false,
      async execute() {
        handlerCalls++;
        return { charged: true, fresh: true };
      },
    };

    const priorOutput = { charged: true, transactionId: 'txn_prior_1' };
    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'Charge the stored test invoice.' }],
      tools: [
        {
          name: 'charge_card',
          description: 'Charge a card for an invoice.',
          inputSchema: {
            type: 'object',
            properties: { invoiceId: { type: 'string' } },
            required: ['invoiceId'],
            additionalProperties: false,
          },
        },
      ],
      toolHandlers: new Map([['charge_card', nonIdempotentHandler]]),
      onToolCallStart: async (_turnIdx, _messageIdx, _ordinal, toolName, input, providerToolCallId) => {
        expect(toolName).toBe('charge_card');
        expect(input).toEqual({ invoiceId: 'inv_test_123' });
        expect(providerToolCallId).toBe('call_charge_1');
        return { gbrainToolUseId: 'gb-charge-card-1' };
      },
      replayState: {
        priorMessages: [],
        priorTools: new Map([
          [
            'gb-charge-card-1',
            {
              status: 'complete' as const,
              output: priorOutput,
            },
          ],
        ]),
        nextTurnIdx: 0,
        nextMessageIdx: 0,
      },
    });

    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('Prior charge output accepted.');
    expect(handlerCalls).toBe(0);
    expect(result.totalUsage).toEqual({
      input_tokens: 12,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });

    expect(calls).toHaveLength(2);
    const secondBody = requestBody(calls[1]);
    expect(secondBody.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Charge the stored test invoice.' }] },
      {
        type: 'function_call',
        call_id: 'call_charge_1',
        name: 'charge_card',
        arguments: '{"invoiceId":"inv_test_123"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_charge_1',
        output: '{"charged":true,"transactionId":"txn_prior_1"}',
      },
    ]);
  });
});
