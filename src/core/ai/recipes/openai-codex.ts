import type { Recipe } from '../types.ts';
import { AIConfigError } from '../errors.ts';
import {
  CODEX_OAUTH_ACCESS_ENV,
  codexAuthReady,
  ensureFreshCodexToken,
  makeCodexOAuthFetch,
} from '../codex-oauth.ts';

/** OpenAI embeddings authenticated by a ChatGPT/Codex OAuth subscription. */
export const openaiCodex: Recipe = {
  id: 'openai-codex',
  name: 'OpenAI via ChatGPT/Codex OAuth',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.openai.com/v1',
  auth_env: {
    required: [],
    setup_url: 'https://auth.openai.com',
  },
  touchpoints: {
    embedding: {
      models: ['text-embedding-3-large', 'text-embedding-3-small'],
      default_dims: 1536,
      dims_options: [256, 512, 768, 1024, 1536, 3072],
      cost_per_1m_tokens_usd: 0.13,
      price_last_verified: '2026-04-20',
      max_batch_tokens: 100_000,
    },
  },
  authReady(env) {
    return env[CODEX_OAUTH_ACCESS_ENV] ? { ready: true } : codexAuthReady(env);
  },
  resolveAuth(env) {
    const token = env[CODEX_OAUTH_ACCESS_ENV];
    // The recipe's custom fetch replaces this placeholder at request time.
    // That per-request path is what keeps long-lived processes fresh. A real
    // injected token is still used when the async gateway setup path supplied
    // one, and is directly testable through applyResolveAuth().
    if (!token && !codexAuthReady(env).ready) {
      throw new AIConfigError(
        'OpenAI Codex OAuth embeddings are not authenticated.',
        'Run `gbrain auth login`, or sign in with the Codex CLI.',
      );
    }
    return {
      headerName: 'Authorization',
      token: `Bearer ${token ?? 'codex-oauth-request-time'}`,
    };
  },
  resolveOpenAICompatConfig(env) {
    const runtimeFetch = makeCodexOAuthFetch({
      ensureFresh: opts => ensureFreshCodexToken({ ...opts, env }),
    });
    return { baseURL: 'https://api.openai.com/v1', fetch: runtimeFetch };
  },
  probe: async () => {
    const status = codexAuthReady();
    return status.ready ? { ready: true } : { ready: false, hint: status.hint };
  },
  setup_hint: 'Run `gbrain auth login`, or sign in with the Codex CLI.',
};
