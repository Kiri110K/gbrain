# OpenAI Codex OAuth embeddings

The `openai-codex` provider sends normal OpenAI-compatible embedding requests to `https://api.openai.com/v1/embeddings`, authenticated with a ChatGPT/Codex OAuth access token. It does not use the chatgpt.com backend and does not require `OPENAI_API_KEY`.

## Setup

Sign in, then initialize a brain:

```bash
gbrain auth login
gbrain auth status
gbrain init
```

When no API-key provider is configured in the environment, `gbrain init` detects the OAuth login and auto-picks `openai-codex:text-embedding-3-large` (1536d). Pass `--embedding-model openai-codex:text-embedding-3-small` (or any supported model/dimensions) to choose explicitly.

`gbrain auth login --no-browser` still prints the authorization URL but does not open it automatically. The OAuth client has a registered fixed callback, so login binds `127.0.0.1:1455` and waits for `GET /auth/callback`. If the port is occupied, finish or stop the other login and retry.

For an existing brain, use the supported embedding migration flow rather than changing `embedding_model` alone; vector dimensions are part of the schema. See [Switching providers](../integrations/embedding-providers.md#switching-providers-on-an-existing-brain).

## Token storage and precedence

GBrain resolves credentials in this order:

1. `<gbrain config dir>/codex-auth.json` (normally `~/.gbrain/codex-auth.json`; `GBRAIN_HOME` is honored).
2. `$CODEX_HOME/auth.json` (normally `~/.codex/auth.json`) when the gbrain-owned store does not exist.

Both files are written with mode `0600`. `gbrain auth login` writes only the gbrain-owned store. `gbrain auth logout` deletes only that store; it never removes Codex CLI credentials. If the fallback remains, run `codex logout` to remove it.

`gbrain auth status` prints the selected source path, account ID, email, plan type, access-token expiry, and last refresh when those claims are available. It never prints tokens.

## Automatic refresh

GBrain refreshes before a request when the access-token JWT expires within five minutes. If the JWT expiry cannot be parsed, it refreshes when `last_refresh` is more than eight days old. Refresh tokens rotate and are single-use, so the replacement access, ID, and refresh tokens are written atomically to the same source file immediately.

Every request in a long-lived process re-checks freshness. A 401 triggers one forced refresh and one retry. This means `gbrain serve` and long sync/embed runs survive access-token expiry without restarting or reconfiguring the gateway.

When GBrain reuses the Codex CLI store, rotated tokens are written back while preserving unrelated fields. Codex CLI re-reads this file, so the handoff is safe. There is a small race window if GBrain and Codex CLI refresh the same single-use token concurrently; one process may win and the other may need to reload the newly written file or log in again.

Errors containing `refresh_token_expired`, `refresh_token_reused`, or `refresh_token_invalidated` tell you to run `gbrain auth login` again.

## Models, pricing, and upstream policy

Supported models and dimensions mirror the direct OpenAI provider:

- `text-embedding-3-small` — 1536 default dimensions.
- `text-embedding-3-large` — 1536 default, up to 3072 dimensions.

These requests reach the OpenAI API and use the same embedding price rows as the direct `openai` provider; GBrain does not treat OAuth usage as free. Billing, quota, and entitlement semantics follow the authenticated account's plan and may change upstream. Check your account usage and current OpenAI terms before running a large backfill.

