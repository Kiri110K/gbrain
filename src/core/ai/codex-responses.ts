import { AIConfigError, AITransientError } from './errors.ts';
import type { ChatBlock, ChatMessage, ChatResult, ChatToolDef } from './gateway.ts';
import {
  DEFAULT_CODEX_RUNTIME,
  toCodexWireRuntimeOptions,
  type CodexRuntimeOptions,
} from './codex-profiles.ts';

const DEFAULT_CODEX_INSTRUCTIONS = 'Follow the user request.';
type JsonRecord = Record<string, unknown>;
type CodexTextPart = { type: 'input_text' | 'output_text'; text: string };

export interface CodexResponsesConfig {
  baseURL: string;
  accessToken: string;
  /** Raw provider model id sent to Codex Responses. */
  model: string;
  /** Optional GBrain profile slug preserved in ChatResult/budget labels. */
  profileModel?: string;
  runtime?: CodexRuntimeOptions;
  /** Optional Responses prompt-cache routing key; improves cache locality across loop turns. */
  promptCacheKey?: string;
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

function normalizeCodexPromptCacheKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/[\x21-\x7e]/.test(trimmed)) return undefined;
  const safe = trimmed.replace(/[^\x21-\x7e]+/g, '-').slice(0, 200);
  return safe || undefined;
}

function codexCacheRoutingHeaders(normalizedPromptCacheKey: string | undefined): Record<string, string> {
  if (!normalizedPromptCacheKey) return {};
  return {
    // Hermes currently sends `session_id`; upstream Codex CLI sends the
    // hyphenated session/thread headers. Live probes showed these routing
    // headers are load-bearing for reliable ChatGPT Codex prompt-cache hits.
    session_id: normalizedPromptCacheKey,
    'session-id': normalizedPromptCacheKey,
    'thread-id': normalizedPromptCacheKey,
    'x-client-request-id': normalizedPromptCacheKey,
  };
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

function responseIncompleteDetails(response: JsonRecord | undefined): JsonRecord | undefined {
  return isRecord(response?.incomplete_details)
    ? response.incomplete_details
    : isRecord(response?.incompleteDetails)
      ? response.incompleteDetails
      : undefined;
}

function normalizeIncompleteStopReason(incompleteDetails: JsonRecord | undefined): ChatResult['stopReason'] {
  const detailReason = asString(incompleteDetails?.reason)?.replaceAll('-', '_');
  if (detailReason === 'max_output_tokens' || detailReason === 'max_tokens') return 'length';
  if (detailReason === 'content_filter') return 'content_filter';
  return 'other';
}

function normalizeStopReason(
  response: JsonRecord | undefined,
  hasToolCalls: boolean,
  hasRefusal: boolean,
): ChatResult['stopReason'] {
  const incompleteDetails = responseIncompleteDetails(response);
  const status = asString(response?.status)?.replaceAll('-', '_');
  if (status === 'incomplete' || incompleteDetails) return normalizeIncompleteStopReason(incompleteDetails);
  if (hasRefusal) return 'refusal';
  if (hasToolCalls) return 'tool_calls';

  const raw = asString(
    response?.finish_reason ??
      response?.finishReason ??
      response?.stop_reason ??
      response?.stopReason ??
      response?.status,
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
    case 'incomplete':
      return normalizeIncompleteStopReason(incompleteDetails);
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

function appendFromCodexItem(
  blocks: ChatBlock[],
  item: unknown,
  opts: { includeToolCalls?: boolean } = {},
): void {
  if (!isRecord(item)) return;

  const type = asString(item.type);
  if (type === 'function_call' || type === 'function_tool_call') {
    if (opts.includeToolCalls !== false) appendFunctionCallBlock(blocks, item);
    return;
  }

  if (type === 'output_text' || type === 'text') {
    appendTextBlock(blocks, item.text);
    return;
  }

  if (type === 'refusal') {
    appendTextBlock(blocks, item.refusal);
    return;
  }

  if (Array.isArray(item.content)) {
    for (const part of item.content) appendFromCodexItem(blocks, part, opts);
  }
}

function codexItemHasRefusal(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (asString(item.type) === 'refusal') return true;
  return Array.isArray(item.content) && item.content.some(codexItemHasRefusal);
}

/** Normalize a raw Codex Responses JSON payload into gbrain's ChatResult shape. */
export function normalizeCodexResponse(input: {
  response: unknown;
  providerId: string;
  modelId: string;
  providerModelId?: string;
}): ChatResult {
  const response = isRecord(input.response) ? input.response : undefined;
  const blocks: ChatBlock[] = [];
  const incomplete = asString(response?.status)?.replaceAll('-', '_') === 'incomplete'
    || responseIncompleteDetails(response) !== undefined;
  const output = response && Array.isArray(response.output) ? response.output : [];
  const includeToolCalls = !incomplete;

  for (const item of output) appendFromCodexItem(blocks, item, { includeToolCalls });
  appendTextBlock(blocks, response?.output_text);
  appendTextBlock(blocks, response?.outputText);

  const text = blocks
    .filter((block): block is Extract<ChatBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const hasToolCalls = blocks.some((block) => block.type === 'tool-call');
  const hasRefusal = output.some(codexItemHasRefusal);
  const providerMetadata = input.providerModelId && input.providerModelId !== input.modelId
    ? {
        codex: {
          providerModel: input.providerModelId,
          profileModel: input.modelId,
        },
      }
    : undefined;

  return {
    text,
    blocks,
    stopReason: normalizeStopReason(response, hasToolCalls, hasRefusal),
    usage: normalizeUsage(response),
    model: `${input.providerId}:${input.modelId}`,
    providerId: input.providerId,
    ...(providerMetadata ? { providerMetadata } : {}),
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

function sseDataPayloads(rawText: string): string[] {
  const events: string[] = [];
  let current: string[] = [];
  for (const line of rawText.split(/\r?\n/)) {
    if (line === '') {
      if (current.length > 0) {
        events.push(current.join('\n'));
        current = [];
      }
      continue;
    }
    if (line.startsWith('data:')) {
      current.push(line.slice(5).trimStart());
    }
  }
  if (current.length > 0) events.push(current.join('\n'));
  return events;
}

function sseOutputTextMessage(text: string): JsonRecord {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

function sseRefusalMessage(refusal: string): JsonRecord {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'refusal', refusal }],
  };
}

function stringifyCodexErrorDetail(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function codexErrorClassificationText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const parts = [
    asString(value.code),
    asString(value.type),
    asString(value.message),
    asString(value.error),
    codexErrorClassificationText(value.error),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function codexFailureIsConfig(error: unknown): boolean {
  const text = codexErrorClassificationText(error)?.toLowerCase().replaceAll('-', '_');
  if (!text) return false;
  if (
    text.includes('rate_limit')
    || text.includes('rate limit')
    || text.includes('too many requests')
    || text.includes('429')
    || text.includes('server')
    || text.includes('timeout')
    || text.includes('temporar')
    || text.includes('unavailable')
    || text.includes('overloaded')
    || text.includes('internal')
  ) return false;
  return text.includes('invalid')
    || text.includes('unsupported')
    || text.includes('not_found')
    || text.includes('not allowed')
    || text.includes('not_allowed')
    || text.includes('does not exist')
    || text.includes('unknown model')
    || text.includes('model')
    || text.includes('permission')
    || text.includes('authentication')
    || text.includes('auth')
    || text.includes('context_length')
    || text.includes('content_policy')
    || text.includes('policy')
    || text.includes('quota')
    || text.includes('billing');
}

function throwCodexFailure(prefix: string, error: unknown, secrets: Array<string | null | undefined>): never {
  const detail = error !== undefined ? `: ${redactCodexSecrets(stringifyCodexErrorDetail(error), secrets)}` : '';
  const message = `${prefix}${detail}`;
  if (codexFailureIsConfig(error)) {
    throw new AIConfigError(
      message,
      'Check your Codex model id, access token, quota, and request options match the Responses API.',
    );
  }
  throw new AITransientError(message);
}

interface CodexSseState {
  output: unknown[];
  textDeltas: string[];
  refusalDeltas: string[];
  terminalOutput?: unknown[];
  terminalOutputText?: string;
  terminalRefusalText?: string;
  usage?: unknown;
  id?: string;
  status: string;
  incompleteDetails?: unknown;
  error?: unknown;
  terminalSeen: boolean;
}

function createCodexSseState(): CodexSseState {
  return {
    output: [],
    textDeltas: [],
    refusalDeltas: [],
    status: 'completed',
    terminalSeen: false,
  };
}

function applyCodexSsePayload(
  state: CodexSseState,
  payload: string,
  secrets: Array<string | null | undefined>,
): void {
  if (!payload || payload === '[DONE]') return;
  let event: unknown;
  try {
    event = JSON.parse(payload) as unknown;
  } catch {
    return;
  }
  if (!isRecord(event)) return;
  const type = asString(event.type) ?? '';
  if (type === 'error') {
    throwCodexFailure('Codex Responses stream error', event, secrets);
  }
  if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
    state.textDeltas.push(event.delta);
    return;
  }
  if (type === 'response.output_text.done' && typeof event.text === 'string') {
    state.terminalOutputText = event.text;
    return;
  }
  if (type === 'response.refusal.delta' && typeof event.delta === 'string') {
    state.refusalDeltas.push(event.delta);
    return;
  }
  if (type === 'response.refusal.done' && typeof event.refusal === 'string') {
    state.terminalRefusalText = event.refusal;
    return;
  }
  if (type === 'response.output_item.done' && event.item !== undefined) {
    state.output.push(event.item);
    return;
  }
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
    state.terminalSeen = true;
    const response = isRecord(event.response) ? event.response : undefined;
    if (response) {
      state.usage = response.usage ?? state.usage;
      state.id = asString(response.id) ?? state.id;
      state.status = asString(response.status) ?? state.status;
      state.incompleteDetails = response.incomplete_details ?? response.incompleteDetails ?? state.incompleteDetails;
      state.error = response.error ?? state.error;
      if (Array.isArray(response.output)) state.terminalOutput = response.output;
      state.terminalOutputText = asString(response.output_text) ?? asString(response.outputText) ?? state.terminalOutputText;
    }
    if (type === 'response.incomplete') state.status = 'incomplete';
    if (type === 'response.failed') state.status = 'failed';
  }
}

function finalizeCodexSseState(
  state: CodexSseState,
  secrets: Array<string | null | undefined>,
): JsonRecord {
  if (!state.terminalSeen) {
    throw new AITransientError('Codex Responses stream did not emit a terminal response event.');
  }

  if (state.status === 'failed') {
    throwCodexFailure('Codex Responses stream failed', state.error, secrets);
  }

  if (state.output.length === 0 && state.textDeltas.length > 0) {
    state.output.push(sseOutputTextMessage(state.textDeltas.join('')));
  }

  const refusalText = state.refusalDeltas.length > 0
    ? state.refusalDeltas.join('')
    : state.terminalRefusalText;
  if (state.output.length === 0 && refusalText) {
    state.output.push(sseRefusalMessage(refusalText));
  }

  if (state.output.length === 0 && state.terminalOutput && state.terminalOutput.length > 0) {
    state.output.push(...state.terminalOutput);
  }

  if (state.output.length === 0 && state.terminalOutputText) {
    state.output.push(sseOutputTextMessage(state.terminalOutputText));
  }

  if (state.output.length === 0 && !state.usage) {
    throw new AITransientError('Codex Responses stream did not emit a completed response.');
  }

  return {
    id: state.id,
    status: state.status,
    output: state.output,
    usage: state.usage,
    incomplete_details: state.incompleteDetails,
    error: state.error,
  };
}

function parseCodexSseResponse(
  rawText: string,
  secrets: Array<string | null | undefined>,
): JsonRecord {
  const payloads = sseDataPayloads(rawText);
  if (payloads.length === 0) {
    throw new Error('not a Codex SSE response');
  }
  const state = createCodexSseState();
  for (const payload of payloads) applyCodexSsePayload(state, payload, secrets);
  return finalizeCodexSseState(state, secrets);
}

async function readCodexSseResponse(
  response: Response,
  secrets: Array<string | null | undefined>,
): Promise<JsonRecord> {
  if (!response.body) {
    throw new AITransientError('Codex Responses stream response had no body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = createCodexSseState();
  const current: string[] = [];
  let buffer = '';

  const flushPayload = (): boolean => {
    if (current.length === 0) return false;
    const payload = current.join('\n');
    current.length = 0;
    applyCodexSsePayload(state, payload, secrets);
    return state.terminalSeen;
  };

  const processLine = (line: string): boolean => {
    if (line === '') return flushPayload();
    if (line.startsWith('data:')) current.push(line.slice(5).trimStart());
    return false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (processLine(line)) {
          await reader.cancel().catch(() => undefined);
          return finalizeCodexSseState(state, secrets);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
    flushPayload();
    return finalizeCodexSseState(state, secrets);
  } catch (err) {
    if (err instanceof AITransientError || err instanceof AIConfigError) throw err;
    const redacted = redactCodexSecrets(codexErrorText(err), secrets);
    throw new AITransientError(
      `Codex Responses stream read failed: ${redacted}`,
      new Error(redacted),
    );
  } finally {
    reader.releaseLock();
  }
}

function parseCodexResponsePayload(
  rawText: string,
  secrets: Array<string | null | undefined>,
): unknown {
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return parseCodexSseResponse(rawText, secrets);
  }
}

function buildCodexRequestBody(input: {
  cfg: CodexResponsesConfig;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  promptCacheKey?: string;
}): JsonRecord {
  const runtime = input.cfg.runtime ?? DEFAULT_CODEX_RUNTIME;
  const {
    tool_choice: codexToolChoice,
    parallel_tool_calls: codexParallelToolCalls,
    ...wireRuntime
  } = toCodexWireRuntimeOptions(runtime);
  const promptCacheKey = input.promptCacheKey;

  const body: JsonRecord = {
    model: input.cfg.model,
    input: toCodexInput(input.messages),
    stream: true,
    ...wireRuntime,
  };

  const systemInstructions = input.system?.trim() || DEFAULT_CODEX_INSTRUCTIONS;
  body.instructions = systemInstructions;

  if (promptCacheKey) {
    // `prompt_cache_key` provides body-level cache affinity; Codex/Hermes-style
    // routing headers are sent with the HTTP request. Keep runtime options such
    // as `service_tier: priority` intact so fast profiles can combine priority
    // tier with prompt-cache routing.
    body.prompt_cache_key = promptCacheKey;
  }

  const tools = toCodexTools(input.tools);
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = codexToolChoice;
    body.parallel_tool_calls = codexParallelToolCalls;
  }

  const maxOutputTokens = Math.floor(Number(input.cfg.maxOutputTokens));
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    // Responses API supports max_output_tokens as the visible+reasoning token
    // ceiling. Keep invalid/legacy unset values off the wire.
    body.max_output_tokens = maxOutputTokens;
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
  const promptCacheKey = normalizeCodexPromptCacheKey(cfg.promptCacheKey);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        'Content-Type': 'application/json',
        ...codexCacheRoutingHeaders(promptCacheKey),
      },
      body: JSON.stringify(buildCodexRequestBody({ ...input, promptCacheKey })),
      signal: cfg.signal,
    });
  } catch (err) {
    const redacted = redactCodexSecrets(codexErrorText(err), secrets);
    throw new AITransientError(`Codex Responses request failed: ${redacted}`, new Error(redacted));
  }

  let parsed: unknown;
  let redactedText = '';
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
  const shouldReadAsSse = response.ok && !contentType.includes('json');
  if (shouldReadAsSse) {
    parsed = await readCodexSseResponse(response, secrets);
  } else {
    const rawText = await readCodexResponseText(response, secrets);
    redactedText = redactCodexSecrets(rawText, secrets);

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

    try {
      parsed = parseCodexResponsePayload(rawText, secrets);
    } catch (err) {
      if (err instanceof AITransientError || err instanceof AIConfigError) throw err;
      const redacted = redactCodexSecrets(codexErrorText(err), secrets);
      throw new AITransientError(
        `Codex Responses request returned invalid JSON/SSE: ${redactedText || redacted}`,
        new Error(redacted),
      );
    }
  }

  if (isRecord(parsed) && asString(parsed.status) === 'failed') {
    throwCodexFailure('Codex Responses request failed', parsed.error, secrets);
  }

  return normalizeCodexResponse({
    providerId: 'codex',
    modelId: cfg.profileModel ?? cfg.model,
    providerModelId: cfg.model,
    response: parsed,
  });
}
