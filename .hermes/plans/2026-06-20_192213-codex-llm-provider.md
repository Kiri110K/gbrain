# Codex LLM Provider Implementation Plan

> **For Hermes:** Use the available coding/delegation workflow to implement this plan task-by-task; do not batch unrelated tasks into one diff.

**Goal:** Add a first-class `codex` LLM provider to GBrain so non-embedding LLM work can route through Codex/ChatGPT OAuth-backed models instead of spending the low-balance OpenAI API key.

**Architecture:** Add `codex` as a recipe-backed provider, but do **not** pretend it is OpenAI-compatible. The Codex backend is a Responses-style endpoint (`https://chatgpt.com/backend-api/codex`) with different request/response/tool-call shapes, so GBrain should add a small dedicated `codex-responses` transport inside the existing AI gateway and keep embeddings/rerankers on existing providers. Keep auth explicit and secret-safe; no token values in logs/docs/tests.

**Tech Stack:** TypeScript, Bun, GBrain AI gateway (`src/core/ai/gateway.ts`), provider recipes (`src/core/ai/recipes/*`), existing `ai`/Vercel SDK for current providers, direct `fetch`/SSE parsing for Codex if needed, `bun:test`.

---

## Current Context

Repo checked: `/home/kiri110k/repos/gbrain` on `master...origin/master`.

Relevant current architecture:

- Provider identity lives in recipe files under `src/core/ai/recipes/`.
- Recipe registry is in `src/core/ai/recipes/index.ts`.
- Provider/model parsing and recipe resolution live in `src/core/ai/model-resolver.ts`.
- Touchpoint validation and gateway routing live mostly in `src/core/ai/gateway.ts`.
- Provider capabilities for subagent/tool-loop gating live in `src/core/ai/capabilities.ts`.
- `Recipe.implementation` currently allows only:
  - `native-openai`
  - `native-google`
  - `native-anthropic`
  - `openai-compatible`
- `chat()` currently routes everything through Vercel AI SDK `generateText()` after `resolveChatProvider()`.
- `expand()` and OCR currently route through AI SDK `generateObject()` / `generateText()` on the configured expansion model.
- Existing OpenAI recipe uses `OPENAI_API_KEY`; Codex must not reuse that for LLM chat if the point is to preserve OpenAI key balance for embeddings.

Key assumption to confirm during implementation:

- Provider id should be `codex`, so model strings look like `codex:gpt-5.5`.
- Codex should support chat/tool-loop and optional text expansion.
- Codex should **not** offer embeddings or reranking.
- OpenAI embeddings stay configured as-is, e.g. `openai:text-embedding-3-large`.

Live-brain test safety:

- Tests may use Kirill's real local corpus as source material, but only by copying `/home/kiri110k/brain` first.
- Never run tests against the live `/home/kiri110k/brain` path or a live GBrain DB/config that can mutate it.
- Use a temp fixture root such as `mktemp -d` / `test/tmp/...`, copy with `rsync -a --exclude .git /home/kiri110k/brain/ "$TMP/brain/"`, and point any test-only env/config at the copy.
- Clean up temp copies after tests unless preserving an artifact for debugging.

---

## Recommended Scope

### Phase 1: Usable Codex chat provider

Deliver `codex:gpt-5.5` as a chat provider through `gateway.chat()`.

This unblocks:

- manual/agent LLM tasks that use GBrain's chat gateway,
- future autonomy routes that use `models.chat`,
- moving non-embedding LLM work away from `OPENAI_API_KEY`.

### Phase 2: Tool-loop/subagent confidence

Only mark `supports_subagent_loop: true` after mocked and/or live tool-call replay tests pass.

Codex tool calls are structurally different from Anthropic/OpenAI-chat-completions, so this should be tested, not asserted optimistically.

### Phase 3: Optional text expansion

Support `models.expansion = codex:gpt-5.5` after a dedicated `codexGenerateJson()` path works for query expansion. This can be same PR if small, but it is separable.

### Not in scope for first patch

- Embeddings through Codex.
- Reranking through Codex.
- Replacing the existing OpenAI embedding key.
- Broad autonomous defaults. The provider should exist, but local config should opt into it deliberately.

---

## Auth Decision

Codex is not a normal OpenAI API-key provider. Use a layered auth plan:

1. **MVP / safest repo-level interface**
   - `GBRAIN_CODEX_ACCESS_TOKEN` preferred.
   - `CODEX_ACCESS_TOKEN` accepted as a fallback.
   - Optional `GBRAIN_CODEX_BASE_URL`, defaulting to `https://chatgpt.com/backend-api/codex`.
   - Never log token values.

2. **Local convenience follow-up**
   - If Kirill wants GBrain to reuse Hermes' `openai-codex` OAuth store, add it as an explicit opt-in source, e.g. `GBRAIN_CODEX_AUTH_SOURCE=hermes`.
   - Read-only by default; no silent writes to `~/.hermes/auth.json`.
   - Token refresh is a separate, tested helper and must not expose token contents.

This keeps GBrain independent and safe while still leaving a path to the practical local setup.

---

## Step-by-Step Plan

### Task 1: Add recipe contract tests for `codex`

**Objective:** Define the desired provider surface before implementation.

**Files:**

- Create: `test/ai/recipe-codex.test.ts`
- Modify later: `src/core/ai/recipes/codex.ts`
- Modify later: `src/core/ai/recipes/index.ts`

**Test cases:**

```ts
import { describe, expect, test } from 'bun:test';
import { getRecipe, listRecipes } from '../../src/core/ai/recipes/index.ts';
import { classifyCapabilities } from '../../src/core/ai/capabilities.ts';

// Exact model list can be revised during implementation, but keep the contract explicit.
const EXPECTED_CODEX_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
];

describe('codex recipe', () => {
  test('is registered as a chat provider', () => {
    const recipe = getRecipe('codex');
    expect(recipe.id).toBe('codex');
    expect(recipe.implementation).toBe('codex-responses');
    expect(recipe.touchpoints.chat?.models).toEqual(EXPECTED_CODEX_MODELS);
    expect(recipe.touchpoints.embedding).toBeUndefined();
    expect(recipe.touchpoints.reranker).toBeUndefined();
  });

  test('advertises explicit token auth without OpenAI API key dependency', () => {
    const recipe = getRecipe('codex');
    expect(recipe.auth_env?.required).toEqual(['GBRAIN_CODEX_ACCESS_TOKEN']);
    expect(recipe.auth_env?.optional).toContain('CODEX_ACCESS_TOKEN');
    expect(recipe.auth_env?.optional).toContain('GBRAIN_CODEX_BASE_URL');
  });

  test('appears in recipe list', () => {
    expect(listRecipes().some((r) => r.id === 'codex')).toBe(true);
  });

  test('capabilities classify as usable or explicitly degraded, not unknown', () => {
    const verdict = classifyCapabilities('codex:gpt-5.5');
    expect(['ok', 'degraded:no_caching', 'degraded:no_parallel']).toContain(verdict);
  });
});
```

**Run:**

```bash
bun test test/ai/recipe-codex.test.ts
```

**Expected:** FAIL initially because the recipe and `codex-responses` implementation do not exist.

---

### Task 2: Extend provider implementation types

**Objective:** Make the gateway type system aware that Codex is a dedicated transport, not OpenAI-compatible.

**Files:**

- Modify: `src/core/ai/types.ts`
- Modify: `src/core/ai/gateway.ts`

**Implementation:**

Add one new implementation literal:

```ts
export type Implementation =
  | 'native-openai'
  | 'native-google'
  | 'native-anthropic'
  | 'openai-compatible'
  | 'codex-responses';
```

Then add explicit `case 'codex-responses'` handling in gateway switch sites that currently switch over `recipe.implementation`.

Initial behavior:

- `instantiateEmbedding()` should throw a clear `AIConfigError` for `codex-responses`.
- `instantiateExpansion()` can throw until Task 8 adds text expansion support.
- `instantiateChat()` should not return a Vercel model; route Codex chat through a separate branch in `chat()` instead.

**Run:**

```bash
bun run typecheck
```

**Expected:** Type errors will point to every switch that needs an explicit `codex-responses` branch.

---

### Task 3: Add `src/core/ai/recipes/codex.ts`

**Objective:** Register provider metadata and model allow-list.

**Files:**

- Create: `src/core/ai/recipes/codex.ts`
- Modify: `src/core/ai/recipes/index.ts`

**Recipe shape:**

```ts
import type { Recipe } from '../types.ts';
import { AIConfigError } from '../errors.ts';

const CODEX_BASE_URL_DEFAULT = 'https://chatgpt.com/backend-api/codex';

function readCodexToken(env: Record<string, string | undefined>): string {
  const token = env.GBRAIN_CODEX_ACCESS_TOKEN || env.CODEX_ACCESS_TOKEN;
  if (!token) {
    throw new AIConfigError(
      'Codex chat requires GBRAIN_CODEX_ACCESS_TOKEN or CODEX_ACCESS_TOKEN.',
      'Authenticate with a Codex/ChatGPT OAuth flow, export only the access token, and do not use OPENAI_API_KEY for Codex chat.',
    );
  }
  return token;
}

export const codex: Recipe = {
  id: 'codex',
  name: 'OpenAI Codex / ChatGPT OAuth',
  tier: 'native',
  implementation: 'codex-responses',
  base_url_default: CODEX_BASE_URL_DEFAULT,
  auth_env: {
    required: ['GBRAIN_CODEX_ACCESS_TOKEN'],
    optional: ['CODEX_ACCESS_TOKEN', 'GBRAIN_CODEX_BASE_URL'],
    setup_url: 'https://chatgpt.com/',
  },
  touchpoints: {
    chat: {
      models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
      supports_tools: true,
      supports_subagent_loop: false, // flip only after Task 7 tool-loop tests pass
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      // Subscription-backed usage does not map cleanly to per-token API pricing.
      // Keep pricing absent or document an estimate only if budget code accepts it.
      price_last_verified: '2026-06-20',
    },
    // Add expansion in Task 8 if implemented.
  },
  setup_hint: 'Set GBRAIN_CODEX_ACCESS_TOKEN or CODEX_ACCESS_TOKEN. Do not put token values in logs or docs.',
  resolveAuth(env) {
    return { headerName: 'Authorization', token: `Bearer ${readCodexToken(env)}` };
  },
  resolveOpenAICompatConfig(env) {
    return { baseURL: (env.GBRAIN_CODEX_BASE_URL || CODEX_BASE_URL_DEFAULT).replace(/\/+$/, '') };
  },
};
```

Note: if `resolveOpenAICompatConfig` feels semantically wrong for a non-OpenAI-compatible provider, extract a provider-base-url helper instead of abusing that method.

**Registry update:**

```ts
import { codex } from './codex.ts';

// Add to the recipes array/map alongside other chat providers.
```

**Run:**

```bash
bun test test/ai/recipe-codex.test.ts
```

**Expected:** Recipe registration tests pass; gateway tests still fail/missing.

---

### Task 4: Build a pure Codex Responses adapter

**Objective:** Keep Codex wire-format conversion isolated and unit-testable.

**Files:**

- Create: `src/core/ai/codex-responses.ts`
- Create: `test/ai/codex-responses.test.ts`

**Functions to implement:**

```ts
import type { ChatBlock, ChatMessage, ChatResult, ChatToolDef } from './gateway.ts';

export interface CodexResponsesConfig {
  baseURL: string;
  accessToken: string;
  model: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export function toCodexInput(messages: ChatMessage[]): unknown[];
export function toCodexTools(tools: ChatToolDef[] | undefined): unknown[] | undefined;
export function normalizeCodexResponse(input: {
  response: unknown;
  providerId: string;
  modelId: string;
}): ChatResult;
export async function codexChat(input: {
  cfg: CodexResponsesConfig;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDef[];
}): Promise<ChatResult>;
```

**Unit test coverage:**

1. Plain text user/assistant messages convert to Responses input items.
2. GBrain `tool-call` blocks convert into Codex-compatible function-call history if needed.
3. GBrain `tool-result` blocks convert into Codex-compatible function-call output items.
4. Tool definitions convert from `ChatToolDef` JSON Schema to Responses `function` tools.
5. Text response normalizes to `ChatResult.text`, `blocks`, `stopReason: 'end'`, usage tokens, `model`, `providerId`.
6. Function-call response normalizes to `blocks: [{ type: 'tool-call', ... }]` and `stopReason: 'tool_calls'`.
7. Invalid JSON arguments become safe object/string payloads without throwing the whole gateway.
8. API errors redact authorization and never include token values.

**Run:**

```bash
bun test test/ai/codex-responses.test.ts
```

**Expected:** FAIL before implementation, PASS after adapter is complete.

---

### Task 5: Implement Codex HTTP transport

**Objective:** Actually call the Codex Responses endpoint without using `OPENAI_API_KEY`.

**Files:**

- Modify: `src/core/ai/codex-responses.ts`
- Test: `test/ai/codex-responses.test.ts`

**Wire target:**

- Base URL default: `https://chatgpt.com/backend-api/codex`
- Responses endpoint: `${baseURL}/responses`
- Models endpoint for later discovery: `${baseURL}/models?client_version=1.0.0`

**Request body, non-streaming first:**

```ts
const body = {
  model,
  instructions: system || undefined,
  input: toCodexInput(messages),
  tools: toCodexTools(tools),
  tool_choice: tools?.length ? 'auto' : undefined,
  parallel_tool_calls: tools?.length ? true : undefined,
  store: false,
  reasoning: { effort: 'medium', summary: 'auto' },
};
```

Implementation notes:

- Omit `tools`, `tool_choice`, and `parallel_tool_calls` when no tools are present.
- Be prepared to omit `max_output_tokens`; Hermes' Codex path notes that the Codex backend may reject body-level max-token fields for some models.
- Use `fetch` with an `Authorization` header containing the Codex bearer token.
- Redact token from every thrown error.
- If a live spike proves non-streaming is rejected or hangs, switch to SSE parsing with the existing `eventsource-parser` dependency.

**Mocked transport test:**

Use a temporary `globalThis.fetch` stub that asserts:

- URL is `${baseURL}/responses`.
- Header contains an `Authorization` bearer token without exposing the token value in assertion messages.
- Body contains `store: false`.
- Body does **not** contain `OPENAI_API_KEY` or any OpenAI embedding setting.

**Run:**

```bash
bun test test/ai/codex-responses.test.ts
```

---

### Task 6: Integrate Codex into `gateway.chat()`

**Objective:** Make `gateway.chat({ model: 'codex:gpt-5.5', ... })` route through the new transport.

**Files:**

- Modify: `src/core/ai/gateway.ts`
- Create: `test/ai/gateway-codex-chat.test.ts`

**Implementation shape:**

After `resolveChatProvider(modelStr)`, branch before AI SDK `generateText()`:

```ts
const { model, recipe, modelId } = await resolveChatProvider(modelStr);

if (recipe.implementation === 'codex-responses') {
  const cfg = requireConfig();
  const auth = applyResolveAuth(recipe, cfg, 'chat');
  const token = auth.apiKey;
  if (!token) throw new AIConfigError('Codex chat did not resolve a bearer token.', recipe.setup_hint);
  const baseURL = (cfg.base_urls?.[recipe.id]
    || cfg.env.GBRAIN_CODEX_BASE_URL
    || recipe.base_url_default
    || '').replace(/\/+$/, '');

  const result = await codexChat({
    cfg: {
      baseURL,
      accessToken: token,
      model: modelId,
      maxOutputTokens: opts.maxTokens ?? 4096,
      signal: withDefaultTimeout(opts.abortSignal, AI_CHAT_TIMEOUT_MS),
    },
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
  });

  _recordBudget(`${recipe.id}:${modelId}`, result.usage.input_tokens, result.usage.output_tokens);
  return result;
}
```

Adjust exact shape to current local helper scope; `_recordBudget` currently lives inside `chat()`, so keep the branch below that helper definition.

**Tests:**

- `configureGateway({ chat_model: 'codex:gpt-5.5', env: { GBRAIN_CODEX_ACCESS_TOKEN: 'test-token' }, ... })`
- Call `chat()` with a stubbed Codex response.
- Assert result model is `codex:gpt-5.5`.
- Assert no `OPENAI_API_KEY` is required.
- Assert missing token throws `AIConfigError` with setup hint and no secret content.

**Run:**

```bash
bun test test/ai/gateway-codex-chat.test.ts
bun test test/ai/recipe-codex.test.ts test/ai/codex-responses.test.ts test/ai/gateway-codex-chat.test.ts
```

---

### Task 7: Validate and then enable tool-loop support

**Objective:** Ensure Codex can safely drive GBrain's provider-neutral tool loop before declaring it subagent-capable.

**Files:**

- Modify: `src/core/ai/recipes/codex.ts`
- Test: existing tool-loop tests or new `test/ai/gateway-codex-tool-loop.test.ts`

**Test scenarios:**

1. Model returns one function call.
2. GBrain executes mocked tool handler.
3. Tool result is sent back in the next model turn.
4. Model returns final text.
5. Replay state with prior tool execution does not duplicate non-idempotent tool execution.
6. Tool-call IDs are stable enough for persisted `ChatBlock` replay.

Only after those pass, change:

```ts
supports_subagent_loop: true,
```

Keep:

```ts
supports_prompt_cache: false,
```

unless Codex prompt-cache behavior is explicitly implemented and tested in GBrain. Codex may support prompt caching via `prompt_cache_key`, but that is not the same as current Anthropic-style cache-control metadata.

**Run:**

```bash
bun test test/ai/gateway-codex-tool-loop.test.ts
bun test test/ai/gateway-codex-chat.test.ts
```

---

### Task 8: Add optional Codex text expansion

**Objective:** Let `models.expansion = codex:gpt-5.5` work for search query expansion without routing through OpenAI API key.

**Files:**

- Modify: `src/core/ai/recipes/codex.ts`
- Modify: `src/core/ai/gateway.ts`
- Test: `test/ai/gateway-codex-expansion.test.ts`

**Recipe addition:**

```ts
touchpoints: {
  chat: { ... },
  expansion: {
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
    price_last_verified: '2026-06-20',
  },
}
```

**Gateway addition:**

- In `expand()`, after resolving provider, if `recipe.implementation === 'codex-responses'`, call a new `codexGenerateJson()` helper instead of `generateObject()`.
- Validate the parsed object with the existing `ExpansionSchema`.
- On failure, preserve current best-effort behavior: warn only for config errors and return `[query]`.

**Tests:**

- Mock Codex JSON text response: `{ "queries": ["...", "..."] }`.
- Assert original query is included and deduped.
- Mock malformed JSON and assert fallback `[query]`.
- Assert missing token returns `[query]` with a config warning, not a crash.

**Run:**

```bash
bun test test/ai/gateway-codex-expansion.test.ts
```

---

### Task 9: Update provider/model CLI surfaces

**Objective:** Make `gbrain providers`, `gbrain models`, and setup/help output show Codex correctly.

**Files:**

- Inspect/modify: `src/commands/providers.ts`
- Inspect/modify: `src/commands/models.ts`
- Possibly modify: `src/commands/init-provider-picker.ts`
- Tests: existing provider/model CLI tests or new focused tests.

**Expected behavior:**

- `codex` appears as chat-capable.
- It does not appear as embedding-capable.
- Missing token is reported as missing `GBRAIN_CODEX_ACCESS_TOKEN` / `CODEX_ACCESS_TOKEN`, not `OPENAI_API_KEY`.
- If provider readiness probes are used, Codex probe should be fast and timeout-bounded.

**Run:**

```bash
bun test test/providers.test.ts test/init-provider-picker.test.ts
bun src/cli.ts models --json
```

---

### Task 10: Documentation and setup instructions

**Objective:** Document how to use Codex without accidentally spending OpenAI API balance.

**Files:**

- Modify: `docs/ENGINES.md`
- Modify: `docs/GBRAIN_VERIFY.md`
- Modify: `docs/operations/spend-controls.md`
- Modify: `skills/conventions/model-routing.md`

**Docs must state:**

- Codex provider id: `codex`.
- Example model: `codex:gpt-5.5`.
- Auth envs:
  - `GBRAIN_CODEX_ACCESS_TOKEN` preferred.
  - `CODEX_ACCESS_TOKEN` fallback.
  - `GBRAIN_CODEX_BASE_URL` optional.
- Codex is for chat/expansion, not embeddings/rerank.
- To keep OpenAI API key embeddings-only:

```bash
gbrain config set models.chat codex:gpt-5.5
gbrain config set models.expansion codex:gpt-5.5
# Leave embedding settings pointed at OpenAI, e.g. openai:text-embedding-3-large.
```

- Never paste token values into docs, shell history examples, or issue reports.

---

### Task 11: Verification pass

**Objective:** Prove the implementation works without breaking existing providers.

**Local verification commands:**

```bash
bun test test/ai/recipe-codex.test.ts \
  test/ai/codex-responses.test.ts \
  test/ai/gateway-codex-chat.test.ts \
  test/ai/gateway-codex-expansion.test.ts

bun run typecheck
bun run check:gateway-routed
bun run verify
```

**Optional live smoke, only with explicit permission / local token already present:**

```bash
# Do not print the token.
set +x
export GBRAIN_CODEX_ACCESS_TOKEN='[REDACTED]'
bun src/cli.ts models --json | jq '.providers[]? | select(.id == "codex")'
```

Then run one minimal LLM call through whatever GBrain command currently uses `gateway.chat()` directly. If the command requires DB config, source env safely without printing values:

```bash
set -a
source "$HOME/.gbrain/postgres.env" >/dev/null 2>&1
set +a
# Run the chosen GBrain chat/think/agent smoke command with --model codex:gpt-5.5.
```

**Success criteria:**

- `codex:gpt-5.5` resolves as a valid chat model.
- Missing Codex token gives a clear config error.
- Codex chat call does not require or touch `OPENAI_API_KEY`.
- OpenAI embeddings still work exactly as before.
- Existing OpenAI/Anthropic/OpenRouter tests still pass.
- No token appears in logs, test snapshots, or generated docs.

---

## Files Likely to Change

Core implementation:

- `src/core/ai/types.ts`
- `src/core/ai/recipes/codex.ts` (new)
- `src/core/ai/recipes/index.ts`
- `src/core/ai/codex-responses.ts` (new)
- `src/core/ai/gateway.ts`
- `src/core/ai/capabilities.ts` (provider hint text only, maybe no logic change)

CLI/provider surfaces:

- `src/commands/providers.ts`
- `src/commands/models.ts`
- `src/commands/init-provider-picker.ts` if provider picker needs touchpoint-specific ordering/readiness behavior.

Tests:

- `test/ai/recipe-codex.test.ts` (new)
- `test/ai/codex-responses.test.ts` (new)
- `test/ai/gateway-codex-chat.test.ts` (new)
- `test/ai/gateway-codex-tool-loop.test.ts` (new if enabling subagent loop)
- `test/ai/gateway-codex-expansion.test.ts` (new if adding expansion)
- Existing provider/model tests as needed.

Docs:

- `docs/ENGINES.md`
- `docs/GBRAIN_VERIFY.md`
- `docs/operations/spend-controls.md`
- `skills/conventions/model-routing.md`

---

## Risks and Tradeoffs

1. **Codex is not OpenAI-compatible.**
   - Risk: trying to use `createOpenAICompatible()` against `chatgpt.com/backend-api/codex` will fail or silently mis-shape tool calls.
   - Mitigation: dedicated `codex-responses` transport.

2. **OAuth tokens expire.**
   - Risk: `GBRAIN_CODEX_ACCESS_TOKEN` works for a short time but autonomy fails later.
   - Mitigation: MVP supports explicit token; follow-up adds opt-in Hermes auth reuse or GBrain-native refresh.

3. **Tool-call semantics are easy to get subtly wrong.**
   - Risk: subagent loops duplicate tools or lose tool results on replay.
   - Mitigation: do not mark `supports_subagent_loop: true` until replay tests pass.

4. **Budget accounting does not map cleanly to ChatGPT subscription usage.**
   - Risk: GBrain budget code may require pricing metadata or may misrepresent cost.
   - Mitigation: test budget paths; either omit prices if allowed or use explicit “subscription/unpriced” handling.

5. **Codex model catalog changes.**
   - Risk: hardcoded model list gets stale.
   - Mitigation: use a small fallback list now; later add optional model discovery from `/models?client_version=1.0.0`.

6. **Prompt caching semantics differ.**
   - Risk: falsely marking cache support hides expensive/degraded behavior.
   - Mitigation: keep `supports_prompt_cache: false` until GBrain implements Codex-specific cache routing.

---

## Open Questions Before Coding

1. Should the provider id be exactly `codex`, or should GBrain mirror Hermes and use `openai-codex`?
   - Recommendation: `codex` for shorter config, with optional alias later if needed.

2. Should first implementation read Hermes' `openai-codex` OAuth store?
   - Recommendation: no for the first patch; add explicit opt-in after the transport works.

3. Do we need Codex for query expansion immediately?
   - Recommendation: chat first; expansion is small but should be a separate tested branch.

4. Which live smoke command should be canonical for `gateway.chat()`?
   - Recommendation: pick the smallest existing CLI command that calls `gateway.chat()` without launching broad autonomy.

---

## General Implementation Summary

Add a new `codex` recipe and a new `codex-responses` gateway transport. Route `codex:gpt-5.5` through the Codex Responses endpoint using a Codex OAuth access token, not `OPENAI_API_KEY`. Keep OpenAI reserved for embeddings. Add mocked unit tests for recipe registration, request conversion, response normalization, gateway chat routing, token-missing errors, and tool-loop replay before enabling subagent/autonomy support. Then update provider/model CLI output and docs so local setup can switch `models.chat` and optionally `models.expansion` to Codex deliberately.
