import type { Recipe } from '../types.ts';
import { AIConfigError } from '../errors.ts';
import { CODEX_BASE_MODELS } from '../codex-profiles.ts';

/**
 * OpenAI Codex / ChatGPT OAuth backend.
 *
 * The dedicated Codex Responses transport is wired separately; do not route
 * this endpoint through the OpenAI API-key or OpenAI-compatible SDK paths.
 * Codex chat/tool calls are allowed via gateway.chat and the provider-neutral
 * tool loop. Query expansion is best-effort and uses the same Responses
 * transport with no tools.
 */
export const codex: Recipe = {
  id: 'codex',
  name: 'OpenAI Codex / ChatGPT OAuth',
  tier: 'native',
  implementation: 'codex-responses',
  base_url_default: 'https://chatgpt.com/backend-api/codex',
  auth_env: {
    required: ['GBRAIN_CODEX_ACCESS_TOKEN'],
    optional: ['CODEX_ACCESS_TOKEN', 'GBRAIN_CODEX_BASE_URL'],
  },
  touchpoints: {
    expansion: {
      models: [...CODEX_BASE_MODELS],
    },
    chat: {
      models: [...CODEX_BASE_MODELS],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
    },
  },
  resolveAuth(env) {
    const token = env.GBRAIN_CODEX_ACCESS_TOKEN?.trim() || env.CODEX_ACCESS_TOKEN?.trim();
    if (!token) {
      throw new AIConfigError(
        'Codex Responses require GBRAIN_CODEX_ACCESS_TOKEN (or CODEX_ACCESS_TOKEN fallback).',
        'Codex uses a Codex/ChatGPT OAuth access token. Export GBRAIN_CODEX_ACCESS_TOKEN (preferred) or CODEX_ACCESS_TOKEN; do not use OPENAI_API_KEY for Codex chat or expansion.',
      );
    }
    return { headerName: 'Authorization', token: `Bearer ${token}` };
  },
  setup_hint:
    'Codex chat and expansion use a Codex/ChatGPT OAuth access token. Export GBRAIN_CODEX_ACCESS_TOKEN (preferred) or CODEX_ACCESS_TOKEN; optionally set GBRAIN_CODEX_BASE_URL for a proxy. Do not use OPENAI_API_KEY for Codex.',
};
