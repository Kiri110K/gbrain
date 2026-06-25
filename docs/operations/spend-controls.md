# Spend controls

GBrain's embedding-spend gates in one place: every gate, its config key, default,
whether it blocks or just informs, how to widen or disable it, and how the
`spend.posture` switch governs all of them.

The orienting idea: **GBrain itself is rounding error; the spend that matters is
downstream embedding.** These gates exist so a routine sync or enrich can't run up
an unexpected embedding bill, while never wedging an unattended cron.

## Keeping OpenAI API balance embeddings-only with Codex

These spend gates govern embedding spend. Chat, text query expansion, and
subagent loops are controlled by model routing. To route non-embedding LLM work
through Codex while keeping an OpenAI API key for embeddings only:

```bash
# Cheap/fast default chat and text expansion.
gbrain config set models.chat codex:gpt-5.5-medium-fast
gbrain config set models.expansion codex:gpt-5.5-medium-fast

# Deep reasoning surfaces are separate from chat/expansion.
gbrain config set models.think codex:gpt-5.5-xhigh-fast
gbrain config set models.tier.deep codex:gpt-5.5-xhigh-fast

# Gateway-native subagent/autonomous loops.
gbrain config set models.subagent codex:gpt-5.5-medium-fast
gbrain config set models.tier.subagent codex:gpt-5.5-medium-fast
gbrain config set agent.use_gateway_loop true

# Leave embedding_model pointed at OpenAI, e.g. openai:text-embedding-3-large.
```

Codex provider details:

- Provider id: `codex`; example profiles: `codex:gpt-5.5-medium-fast` and
  `codex:gpt-5.5-xhigh-fast`.
- Profile slugs are GBrain runtime profiles, not raw provider model IDs; the
  gateway sends the base model plus typed Codex options.
- Transport: dedicated `codex-responses`, not OpenAI-compatible.
- Auth envs: `GBRAIN_CODEX_ACCESS_TOKEN` preferred, `CODEX_ACCESS_TOKEN`
  fallback, `GBRAIN_CODEX_BASE_URL` optional.
- Codex is for chat, text query expansion, and replay-tested subagent tool
  loops. It is not an embedding or reranker provider.
- Codex must never use `OPENAI_API_KEY`; when `embedding_model` is
  `openai:text-embedding-3-large`, that OpenAI key remains embeddings-only.

Secret hygiene: never paste token values into docs, shell history examples,
logs, issue reports, or screenshots. Use placeholders such as
`<codex-access-token>` or `[REDACTED]`. Explicit env access tokens can expire;
refresh/auth-store reuse is future/opt-in behavior, not automatic.

Cost/accounting caveat: `models.chat` and `models.expansion` alone do not route
every non-embedding LLM surface; check think/deep, subagent, dream/autopilot,
facts extraction, and eval rows with `gbrain models`. Codex is approved for
tool-loop/subagent use after replay tests and participates in prompt-cache
routing (`supports_prompt_cache:true`) via `prompt_cache_key` plus Codex
cache-locality headers. Subscription-backed Codex usage still may not map
cleanly to OpenAI API token pricing. Text query expansion can use Codex; image
OCR still needs a multimodal expansion model/provider and safely skips Codex.

## `spend.posture` — one switch for "cost is not my constraint"

```bash
gbrain config set spend.posture tokenmax   # all cost gates become informational
gbrain config set spend.posture gated      # default — gates enforce
```

| Value | Effect |
|-------|--------|
| `gated` (default) | Every cost gate enforces its limit as documented below. |
| `tokenmax` | Every cost gate prints its estimate and **proceeds** — informational only. Spend is still recorded to the ledger; posture removes the *ceiling*, not the *accounting*. |

`spend.posture` is deliberately separate from `search.mode=tokenmax` (which governs
retrieval payload size, not embedding spend). When a gate fires and
`search.mode=tokenmax` but `spend.posture` is unset, the gate prints a one-line hint
pointing at this switch.

**Precedence:** an explicit per-call cap (`--max-usd N`, `--max-cost N`) always wins
over posture. `tokenmax` only governs the default/absent case — it never overrides a
number you typed on the command line.

## Off switches (`off` / `unlimited` / `none`)

The USD-limit knobs accept `off`, `unlimited`, or `none` (case-insensitive) to mean
"no limit" — no more setting sentinel values like `100000`.

- `0` is **not** "off". On `sync.cost_gate_min_usd`, `0` means "block on any nonzero
  spend" (a real choice). On the backfill caps, `0` falls back to the default.
- Internally "no limit" is the string `unlimited` in any printed/JSON output and "no
  cap" inside the budget tracker — never a raw `Infinity` (which would serialize to
  `null` in ledger rows).

## The gates

| Gate | Config key | Default | Blocks? | Off switch | tokenmax |
|------|-----------|---------|---------|-----------|----------|
| Sync inline-embed cost gate | `sync.cost_gate_min_usd` | `0.50` | TTY prompt / non-TTY auto-defer | `off` (or `0` = block-on-any) | informational |
| Backfill 24h per-source spend cap | `embed.backfill_max_usd_per_source_24h` | `25` | refuses submission | `off` (`0` → default) | bypassed (still ledgered) |
| Backfill per-job budget | `embed.backfill_max_usd` | `10` | caps the job's tracker | `off` (`0` → default) | uncapped (still ledgered) |
| Backfill cooldown | `embed.backfill_cooldown_min` | `10` | skips re-submission inside window | — (latency knob, not spend) | **not** bypassed |
| `reindex-code` cost gate | — (preview before re-embed) | — | TTY prompt / non-TTY refuse + exit 2 | `--max-cost off` | informational |
| `enrich` / `onboard --auto` | `--max-usd` (per-call) | — | refuse without a cap (non-TTY) | `--max-usd off` | runs uncapped (still ledgered) |

### Sync inline-embed cost gate

Fires only when sync embeds **inline** (federated_v2 off, or `--serial` without
`--no-embed`). Under federated_v2 + parallel, embedding is deferred to capped backfill
jobs and the gate is informational. The estimate prices the **delta** — the files this
sync will actually import (fetched-first, so it sees commits the run is about to pull) —
not the whole tree. A busy brain with a dirty working tree but caught-up commits
estimates `$0`, because an attached-HEAD sync imports only the committed diff.

Behavior above the floor:
- **TTY:** prompts `[y/N]`.
- **Non-interactive (cron/agent):** **auto-defers** embeds to capped backfill jobs and
  exits 0 — it never wedges the pipeline. The backlog drains via the jobs worker or
  `gbrain embed --stale`. Pass `--yes` to embed inline instead.

Output format splits on the explicit `--json` flag: `--json` emits a structured
envelope; otherwise human text. Every gate message carries paste-ready knobs.

`--full` re-embeds the stale backlog inline (full sync sweeps it), so a `--full`
estimate is `delta + stale backlog`, labeled as such.

### Estimate labels

- `~N tokens (delta: changed files since last sync)` — the precise estimate.
- `<=N tokens (full-tree ceiling for K source(s): <reasons> …)` — a conservative
  over-count used only when a precise delta can't be computed: a first sync, a chunker
  version drift (forces a full re-chunk), or git being unavailable. Unchanged files
  still skip via `content_hash` at execution, so the ceiling over-states real spend.

## Notes & limits

- **Pre-pull window:** the gate fetches before estimating, so it prices what the run
  will pull. If a fetch fails (offline), it estimates against local HEAD and labels the
  result; the bounded residual is priced on the next run.
- **Single-source `gbrain sync`** carries the same gate as `sync --all` (it previously
  embedded inline with no preview).
- **Recovery under parallel:** `--skip-failed` / `--retry-failed` work under parallel
  sync (the failure ledger is per-source and lock-serialized) — you no longer have to
  drop to `--serial`, which is what used to arm the inline gate.

## Escape hatches at a glance

```bash
# Never gate this brain on cost:
gbrain config set spend.posture tokenmax

# Widen the sync inline floor to $5:
gbrain config set sync.cost_gate_min_usd 5

# Disable the sync inline floor entirely:
gbrain config set sync.cost_gate_min_usd off

# Lift the backfill 24h spend cap:
gbrain config set embed.backfill_max_usd_per_source_24h off

# Run enrich uncapped non-interactively:
gbrain enrich --max-usd off        # or: gbrain config set spend.posture tokenmax
```
