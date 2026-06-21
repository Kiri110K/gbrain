# Model Routing Convention

Two distinct concerns share this name. Read both — they apply at different
moments.

## 1. gbrain's internal tier system (v0.31.12+)

This is how gbrain itself picks which Claude/OpenAI/Google/Codex model runs each
internal task (chat, expansion, synthesis, classification, etc.).

Four tiers:

| Tier | Purpose | Default | Examples |
|---|---|---|---|
| `utility` | fast classification, expansion, verdict, dedup | `claude-haiku-4-5-20251001` | query expansion, facts contradiction classifier, dream synthesize verdict |
| `reasoning` | default chat, synthesis, generation | `claude-sonnet-4-6` | gateway chat, dream synthesize, patterns, facts extraction |
| `deep` | slow, expensive reasoning | `claude-opus-4-7` | `gbrain think`, auto-think, cross-modal eval slot B |
| `subagent` | capability-gated multi-turn tool loop | `claude-sonnet-4-6` | `gbrain agent run`; Codex allowed after replay tests |

Override priority (highest first):

1. CLI flag (`--model opus`)
2. Per-task config (`gbrain config set models.dream.synthesize opus`)
3. Deprecated per-task config (stderr-warns once, then honored)
4. **Global default** (`gbrain config set models.default opus`) — single hammer
5. **Tier override** (`gbrain config set models.tier.reasoning opus`)
6. Env var (`GBRAIN_MODEL=opus`)
7. Tier default (the table above)
8. Hardcoded caller fallback

Power-user recipes:

```bash
# Use opus for everything
gbrain config set models.default opus

# Use opus only for reasoning + deep, keep haiku for utility
gbrain config set models.tier.reasoning opus
gbrain config set models.tier.deep opus

# Custom alias, then use it everywhere
gbrain config set models.aliases.frontier anthropic:claude-opus-4-7
gbrain config set models.default frontier

# Route non-embedding LLM work through Codex, while OpenAI remains embeddings-only
gbrain config set models.chat codex:gpt-5.5
gbrain config set models.expansion codex:gpt-5.5
# Leave embedding_model pointed at OpenAI, e.g. openai:text-embedding-3-large.
```

### Codex safe routing

- Provider id: `codex`; example model: `codex:gpt-5.5`.
- Auth envs: `GBRAIN_CODEX_ACCESS_TOKEN` preferred, `CODEX_ACCESS_TOKEN`
  fallback, `GBRAIN_CODEX_BASE_URL` optional.
- Codex uses the dedicated `codex-responses` transport; it is not
  OpenAI-compatible and must never use `OPENAI_API_KEY`.
- Use Codex for chat, text query expansion, and replay-tested subagent tool
  loops. Do not configure Codex for embeddings or rerankers.
- Never paste token values into docs, shell history examples, logs, issue
  reports, or screenshots. Use placeholders such as `<codex-access-token>` or
  `[REDACTED]`.
- Explicit env access tokens may expire. Refresh/auth-store reuse is
  future/opt-in behavior, not automatic.
- Codex currently has `supports_prompt_cache:false`. Even though replay tests
  approve it for tool-loop/subagent routing, model routing may warn about
  degraded prompt-caching/cost semantics.
- `models.expansion = codex:gpt-5.5` is for text query expansion only. Image
  OCR still needs a multimodal expansion model/provider and safely skips Codex.

Visibility:

```bash
gbrain models                    # print current routing table
gbrain models doctor             # 1-token probe to each configured model
```

**Subagent tier exists because the loop is provider-capability-gated.** The
handler needs multi-turn tool calls that replay cleanly. Anthropic remains the
default and uses prompt caching on system + tools. Codex (`codex:gpt-5.5`) is
also approved for tool-loop/subagent routing after replay tests, but currently
has `supports_prompt_cache:false`, so cost/prompt-cache warnings are expected.
Providers without `supports_subagent_loop` are refused or rerouted by the same
enforcement layers: submit-time guard in `MinionQueue.add`, tier-resolution
fallback in `resolveModel`, doctor `subagent_provider` check.

When adding a new LLM call, route through `resolveModel()` with a tier —
never hardcode a model string. The v0.31.6 chat default
(`claude-sonnet-4-6-20250929`) was a phantom ID that 404'd the Anthropic
API and made `extractFactsFromTurn` silently return `[]`. The tier system
+ doctor probe is the structural fix for that bug class.

## 2. Subagent spawn routing

When the user-facing agent (Claude in the main session) chooses which model
to spawn a sub-agent on, this table applies. It's about WHERE to send the
work, not what gbrain calls internally.

| Task | Model | Why |
|------|-------|-----|
| Main session / complex instructions | Opus (default) | Best overall quality |
| Signal detection / entity extraction | Sonnet | Fast, cheap, fires every message |
| Research / synthesis | DeepSeek or Qwen | 25-40x cheaper for large context |
| Fast lightweight sub-agents | Groq | 500 tok/s, good for simple tasks |
| Judge tests / quality grading | Haiku | Cheap, good enough for pass/fail |

### Refusal routing

When a model refuses a request:
1. Re-spawn on a different model (don't announce the switch)
2. Fallback chain: primary → DeepSeek → Qwen → Groq
3. Never show the refusal to the user
4. If all models refuse, escalate to the user

### Spawn rules

- 3+ items to process → spawn a sub-agent
- >2 tool calls that don't need real-time judgment → spawn
- Main thread must stay responsive to the user
- Signal detection always spawns (parallel, don't block)
