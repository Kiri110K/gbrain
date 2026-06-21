import { AIConfigError, AITransientError } from './errors.ts';
import type { ChatBlock, ChatMessage, ChatResult, ChatToolDef } from './gateway.ts';

type JsonRecord = Record<string, unknown>;
type CodexTextPart = { type: 'input_text' | 'output_text'; text: string };

export interface CodexResponsesConfig {
  baseURL: string;
  accessToken: string;
  model: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function codexTextTypeForRole(role: ChatMessage['role']): CodexTextPart['type'] {
  return role === 'assistant' ? 'output_text' : 'input_text';
}

function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

/**
 * Convert gbrain's provider-neutral chat history into Codex Responses-style input.
 *
 * This is intentionally transport-free: it only produces the JSON-ish payload items
 * that Task 5's HTTP layer can send to the Responses endpoint.
 */
export function toCodexInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];

  for (const message of messages) {
    if (typeof message.content === 'string') {
      input.push({
        role: message.role,
        content: [{ type: codexTextTypeForRole(message.role), text: message.content }],
      });
      continue;
    }

    const textParts: CodexTextPart[] = [];
    const flushTextParts = (): void => {
      if (textParts.length === 0) return;
      input.push({ role: message.role, content: [...textParts] });
      textParts.length = 0;
    };

    for (const block of message.content) {
      if (block.type === 'text') {
        textParts.push({ type: codexTextTypeForRole(message.role), text: block.text });
        continue;
      }

      flushTextParts();

      if (block.type === 'tool-call') {
        input.push({
          type: 'function_call',
          call_id: block.toolCallId,
          name: block.toolName,
          arguments: stringifyPayload(block.input),
        });
        continue;
      }

      input.push({
        type: 'function_call_output',
        call_id: block.toolCallId,
        output: stringifyPayload(block.output),
      });
    }

    flushTextParts();
  }

  return input;
}

/** Convert gbrain tool definitions into Codex Responses function tool schemas. */
export function toCodexTools(tools: ChatToolDef[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
}

function parseFunctionArguments(value: unknown): unknown {
  if (value === undefined) return {};
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (trimmed.length === 0) return {};

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Preserve the raw provider payload so callers can log/debug/retry safely.
    return value;
  }
}

function numberFromFirst(candidates: unknown[]): number {
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function normalizeUsage(response: JsonRecord | undefined): ChatResult['usage'] {
  const usage = isRecord(response?.usage) ? response.usage : undefined;
  const inputDetails = isRecord(usage?.input_tokens_details)
    ? usage.input_tokens_details
    : isRecord(usage?.inputTokensDetails)
      ? usage.inputTokensDetails
      : undefined;

  return {
    input_tokens: numberFromFirst([
      usage?.input_tokens,
      usage?.inputTokens,
      usage?.prompt_tokens,
      usage?.promptTokens,
    ]),
    output_tokens: numberFromFirst([
      usage?.output_tokens,
      usage?.outputTokens,
      usage?.completion_tokens,
      usage?.completionTokens,
    ]),
    cache_read_tokens: numberFromFirst([
      usage?.cache_read_tokens,
      usage?.cacheReadTokens,
      inputDetails?.cached_tokens,
      inputDetails?.cachedTokens,
    ]),
    cache_creation_tokens: numberFromFirst([
      usage?.cache_creation_tokens,
      usage?.cacheCreationTokens,
    ]),
  };
}

function normalizeStopReason(
  response: JsonRecord | undefined,
  hasToolCalls: boolean,
): ChatResult['stopReason'] {
  if (hasToolCalls) return 'tool_calls';

  const incompleteDetails = isRecord(response?.incomplete_details)
    ? response.incomplete_details
    : isRecord(response?.incompleteDetails)
      ? response.incompleteDetails
      : undefined;
  const raw = asString(
    response?.finish_reason ??
      response?.finishReason ??
      response?.stop_reason ??
      response?.stopReason ??
      response?.status ??
      incompleteDetails?.reason,
  );
  const reason = raw?.replaceAll('-', '_');

  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
      return 'length';
    case 'refusal':
      return 'refusal';
    case 'content_filter':
      return 'content_filter';
    case 'stop':
    case 'end':
    case 'completed':
      return 'end';
    case 'incomplete': {
      const detailReason = asString(incompleteDetails?.reason)?.replaceAll('-', '_');
      return detailReason === 'max_output_tokens' || detailReason === 'max_tokens'
        ? 'length'
        : 'other';
    }
    case undefined:
      return 'end';
    default:
      return 'other';
  }
}

function appendTextBlock(blocks: ChatBlock[], value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) return;
  blocks.push({ type: 'text', text: value });
}

function appendFunctionCallBlock(blocks: ChatBlock[], item: JsonRecord): void {
  const callId =
    asString(item.call_id) ??
    asString(item.callId) ??
    asString(item.id) ??
    '';
  const toolName =
    asString(item.name) ??
    asString(item.tool_name) ??
    asString(item.toolName) ??
    '';
  const rawArguments = item.arguments ?? item.args ?? item.input;

  blocks.push({
    type: 'tool-call',
    toolCallId: callId,
    toolName,
    input: parseFunctionArguments(rawArguments),
  });
}

function appendFromCodexItem(blocks: ChatBlock[], item: unknown): void {
  if (!isRecord(item)) return;

  const type = asString(item.type);
  if (type === 'function_call' || type === 'function_tool_call') {
    appendFunctionCallBlock(blocks, item);
    return;
  }

  if (type === 'output_text' || type === 'text') {
    appendTextBlock(blocks, item.text);
    return;
  }

  if (Array.isArray(item.content)) {
    for (const part of item.content) appendFromCodexItem(blocks, part);
  }
}

/** Normalize a raw Codex Responses JSON payload into gbrain's ChatResult shape. */
export function normalizeCodexResponse(input: {
  response: unknown;
  providerId: string;
  modelId: string;
}): ChatResult {
  const response = isRecord(input.response) ? input.response : undefined;
  const blocks: ChatBlock[] = [];

  if (response && Array.isArray(response.output)) {
    for (const item of response.output) appendFromCodexItem(blocks, item);
  }
  appendTextBlock(blocks, response?.output_text);
  appendTextBlock(blocks, response?.outputText);

  const text = blocks
    .filter((block): block is Extract<ChatBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const hasToolCalls = blocks.some((block) => block.type === 'tool-call');

  return {
    text,
    blocks,
    stopReason: normalizeStopReason(response, hasToolCalls),
    usage: normalizeUsage(response),
    model: `${input.providerId}:${input.modelId}`,
    providerId: input.providerId,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redact Codex transport secrets from user-visible error text. */
export function redactCodexSecrets(
  text: string,
  secrets: Array<string | null | undefined> = [],
): string {
  let redacted = text.replace(/\b(Bearer\s+)[^;\s]+/gi, '$1***');

  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }

  return redacted;
}

function codexErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function readCodexResponseText(
  response: Response,
  secrets: Array<string | null | undefined>,
): Promise<string> {
  try {
    return await response.text();
  } catch (err) {
    const redacted = redactCodexSecrets(codexErrorText(err), secrets);
    throw new AITransientError(
      `Codex Responses response body read failed: ${redacted}`,
      new Error(redacted),
    );
  }
}

function buildCodexRequestBody(input: {
  cfg: CodexResponsesConfig;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDef[];
}): JsonRecord {
  const body: JsonRecord = {
    model: input.cfg.model,
    input: toCodexInput(input.messages),
    store: false,
    reasoning: { effort: 'medium', summary: 'auto' },
  };

  if (input.system && input.system.trim().length > 0) {
    body.instructions = input.system;
  }

  const tools = toCodexTools(input.tools);
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }

  if (Number.isFinite(input.cfg.maxOutputTokens) && Number(input.cfg.maxOutputTokens) > 0) {
    body.max_output_tokens = input.cfg.maxOutputTokens;
  }

  return body;
}

export async function codexChat(input: {
  cfg: CodexResponsesConfig;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDef[];
}): Promise<ChatResult> {
  const { cfg } = input;
  const url = `${cfg.baseURL.replace(/\/+$/, '')}/responses`;
  const secrets = [cfg.accessToken];

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildCodexRequestBody(input)),
      signal: cfg.signal,
    });
  } catch (err) {
    const redacted = redactCodexSecrets(codexErrorText(err), secrets);
    throw new AITransientError(`Codex Responses request failed: ${redacted}`, new Error(redacted));
  }

  const rawText = await readCodexResponseText(response, secrets);
  const redactedText = redactCodexSecrets(rawText, secrets);

  if (!response.ok) {
    const message = `Codex Responses request failed with status ${response.status}: ${redactedText}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new AIConfigError(
        message,
        response.status === 401 || response.status === 403
          ? 'Check your Codex access token is valid and can access this model.'
          : 'Check your Codex model id and request options match the Responses API.',
      );
    }
    throw new AITransientError(message);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch (err) {
    const redacted = redactCodexSecrets(codexErrorText(err), secrets);
    throw new AITransientError(
      `Codex Responses request returned invalid JSON: ${redactedText || redacted}`,
      new Error(redacted),
    );
  }

  return normalizeCodexResponse({
    providerId: 'codex',
    modelId: cfg.model,
    response: parsed,
  });
}
