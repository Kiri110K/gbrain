import { AIConfigError } from './errors.ts';

export const CODEX_BASE_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
] as const;

export type CodexBaseModel = (typeof CODEX_BASE_MODELS)[number];
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CodexWireReasoningEffort = 'low' | 'medium' | 'high';
export type CodexLatencyTier = 'standard' | 'fast';
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';
export type CodexToolChoice = 'auto' | 'none' | 'required';

export interface CodexRuntimeOptions {
  reasoning: {
    effort: CodexReasoningEffort;
    summary: CodexReasoningSummary;
  };
  latency: CodexLatencyTier;
  store: boolean;
  toolChoice: CodexToolChoice;
  parallelToolCalls: boolean;
}

export interface CodexResolvedProfile {
  /** Raw model id accepted by the Codex Responses backend. */
  providerModelId: CodexBaseModel;
  /** User-facing model/profile slug, preserved for budgets and diagnostics. */
  displayModelId: string;
  /** Typed provider runtime options selected by the slug. */
  runtime: CodexRuntimeOptions;
}

export interface CodexWireRuntimeOptions {
  store: boolean;
  reasoning: {
    effort: CodexWireReasoningEffort;
    summary: CodexReasoningSummary;
  };
  service_tier?: 'priority';
  tool_choice: CodexToolChoice;
  parallel_tool_calls: boolean;
}

export const DEFAULT_CODEX_RUNTIME: CodexRuntimeOptions = Object.freeze({
  reasoning: Object.freeze({ effort: 'medium', summary: 'auto' }),
  latency: 'standard',
  store: false,
  toolChoice: 'auto',
  parallelToolCalls: true,
});

const EFFORTS = new Set<CodexReasoningEffort>(['low', 'medium', 'high', 'xhigh']);
const LATENCIES = new Set<CodexLatencyTier>(['standard', 'fast']);
const BASE_MODELS_LONGEST_FIRST = [...CODEX_BASE_MODELS].sort((a, b) => b.length - a.length);

function cloneRuntime(runtime: CodexRuntimeOptions = DEFAULT_CODEX_RUNTIME): CodexRuntimeOptions {
  return {
    ...runtime,
    reasoning: { ...runtime.reasoning },
  };
}

function unknownProfileError(modelId: string): AIConfigError {
  return new AIConfigError(
    `Unknown Codex profile "${modelId}".`,
    `Known base models: ${CODEX_BASE_MODELS.join(', ')}. ` +
      `Use <base>, <base>-<low|medium|high|xhigh>, or ` +
      `<base>-<low|medium|high|xhigh>-<standard|fast>.`,
  );
}

export function resolveCodexProfile(modelId: string): CodexResolvedProfile {
  const base = BASE_MODELS_LONGEST_FIRST.find((candidate) =>
    modelId === candidate || modelId.startsWith(`${candidate}-`),
  );

  if (!base) {
    throw new AIConfigError(
      `Unknown Codex model/profile "${modelId}".`,
      `Known base models: ${CODEX_BASE_MODELS.join(', ')}. ` +
        `Profile format: <base>-<low|medium|high|xhigh>-<standard|fast>.`,
    );
  }

  const suffixRaw = modelId.slice(base.length);
  if (!suffixRaw) {
    return {
      providerModelId: base,
      displayModelId: modelId,
      runtime: cloneRuntime(),
    };
  }

  const suffix = suffixRaw.slice(1);
  if (!suffix) {
    throw unknownProfileError(modelId);
  }

  const parts = suffix.split('-');
  if (parts.some((part) => part.length === 0)) {
    throw unknownProfileError(modelId);
  }
  const [effort, latency] = parts;

  if (!effort || !EFFORTS.has(effort as CodexReasoningEffort) || parts.length > 2) {
    throw unknownProfileError(modelId);
  }

  if (latency && !LATENCIES.has(latency as CodexLatencyTier)) {
    throw new AIConfigError(
      `Unknown Codex latency tier in profile "${modelId}".`,
      `Use standard or fast.`,
    );
  }

  const runtime = cloneRuntime();
  runtime.reasoning.effort = effort as CodexReasoningEffort;
  runtime.latency = (latency as CodexLatencyTier | undefined) ?? runtime.latency;

  return {
    providerModelId: base,
    displayModelId: modelId,
    runtime,
  };
}

/**
 * User-facing `xhigh` means "highest supported Codex effort". Today the
 * Responses wire accepts `high`, so the mapping is intentionally isolated here;
 * if Codex later accepts `xhigh` directly, only this helper changes.
 */
export function codexWireReasoningEffort(
  effort: CodexReasoningEffort,
): CodexWireReasoningEffort {
  return effort === 'xhigh' ? 'high' : effort;
}

/**
 * Centralize Codex runtime lowering. Slugs remain stable even if Codex changes
 * exact wire values for priority/fast service tiers or highest reasoning effort.
 */
export function toCodexWireRuntimeOptions(
  runtime: CodexRuntimeOptions,
): CodexWireRuntimeOptions {
  return {
    store: runtime.store,
    reasoning: {
      effort: codexWireReasoningEffort(runtime.reasoning.effort),
      summary: runtime.reasoning.summary,
    },
    ...(runtime.latency === 'fast' ? { service_tier: 'priority' as const } : {}),
    tool_choice: runtime.toolChoice,
    parallel_tool_calls: runtime.parallelToolCalls,
  };
}
