import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import {
  accessTokenExpiresAt,
  buildCodexAuthorizeUrl,
  classifyCodexRefreshError,
  codexCliAuthPath,
  decodeJwtPayload,
  ensureFreshCodexToken,
  gbrainCodexAuthPath,
  handleCodexOAuthCallback,
  logoutCodexOAuth,
  makeCodexOAuthFetch,
  resolveCodexAuthSource,
  shouldRefreshCodexToken,
} from '../../src/core/ai/codex-oauth.ts';
import {
  configureGateway,
  diagnoseEmbedding,
  isAvailable,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { buildGatewayConfigWithAuth } from '../../src/core/ai/build-gateway-config.ts';

function jwt(payload: Record<string, unknown>): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.`;
}

function auth(access: string, refresh = 'refresh-1', exp = Math.floor(Date.now() / 1000) + 3600) {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({
        email: 'user@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
      }),
      access_token: jwt({ exp, marker: access }),
      refresh_token: refresh,
      account_id: 'acct-1',
    },
    last_refresh: new Date().toISOString(),
  };
}

async function inHomes<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'gbrain-codex-oauth-'));
  return withEnv({ GBRAIN_HOME: join(root, 'gbrain-home'), CODEX_HOME: join(root, 'codex-home') }, () => fn(root));
}

async function writeJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode });
  await chmod(path, mode);
}

afterEach(() => resetGateway());

describe('Codex OAuth token storage and JWT policy', () => {
  test('own store wins; Codex CLI store is the fallback', async () => inHomes(async () => {
    const own = gbrainCodexAuthPath();
    const cli = codexCliAuthPath();
    await writeJson(cli, auth('cli'));
    await writeJson(own, auth('own'));

    const primary = await resolveCodexAuthSource();
    expect(primary?.kind).toBe('gbrain');
    expect(decodeJwtPayload(primary?.data.tokens.access_token)?.marker).toBe('own');

    await Bun.file(own).delete();
    const fallback = await resolveCodexAuthSource();
    expect(fallback?.kind).toBe('codex-cli');
    expect(decodeJwtPayload(fallback?.data.tokens.access_token)?.marker).toBe('cli');
  }));

  test('logout removes only the gbrain-owned store', async () => inHomes(async () => {
    await writeJson(gbrainCodexAuthPath(), auth('own'));
    await writeJson(codexCliAuthPath(), auth('cli'));
    expect(await logoutCodexOAuth()).toEqual({ removed: true, codexCliFallback: true });
    const fallback = await resolveCodexAuthSource();
    expect(fallback?.kind).toBe('codex-cli');
    expect(decodeJwtPayload(fallback?.data.tokens.access_token)?.marker).toBe('cli');
  }));

  test('parses exp and refreshes at the five-minute boundary', () => {
    const now = Date.now();
    const fresh = auth('fresh', 'refresh', Math.floor((now + 10 * 60_000) / 1000));
    const stale = auth('stale', 'refresh', Math.floor((now + 4 * 60_000) / 1000));
    expect(accessTokenExpiresAt(fresh.tokens.access_token)?.getTime()).toBeGreaterThan(now);
    expect(shouldRefreshCodexToken(fresh, now)).toBe(false);
    expect(shouldRefreshCodexToken(stale, now)).toBe(true);
  });

  test('falls back to last_refresh age when access exp is unreadable', () => {
    const now = Date.now();
    const data = auth('unused') as any;
    data.tokens.access_token = 'opaque';
    data.last_refresh = new Date(now - 9 * 24 * 60 * 60_000).toISOString();
    expect(shouldRefreshCodexToken(data, now)).toBe(true);
    data.last_refresh = new Date(now - 24 * 60 * 60_000).toISOString();
    expect(shouldRefreshCodexToken(data, now)).toBe(false);
  });
});

describe('Codex OAuth refresh', () => {
  test('persists rotated tokens atomically at 0600 and preserves Codex CLI fields', async () => inHomes(async () => {
    const path = codexCliAuthPath();
    const stale = auth('old', 'refresh-old', Math.floor(Date.now() / 1000) - 60) as any;
    stale.OPENAI_API_KEY = 'preserve-me';
    stale.extra = { nested: true };
    stale.tokens.future_token_field = 'preserve-token-field';
    await writeJson(path, stale, 0o644);

    let refreshInit: RequestInit | undefined;
    const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      refreshInit = init;
      return new Response(JSON.stringify({
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-2' } }),
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, marker: 'new' }),
        refresh_token: 'refresh-new',
      }), { status: 200 });
    }) as typeof fetch;

    const result = await ensureFreshCodexToken({ fetch: fetchMock });
    expect(decodeJwtPayload(result.accessToken)?.marker).toBe('new');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.tokens.refresh_token).toBe('refresh-new');
    expect(saved.tokens.future_token_field).toBe('preserve-token-field');
    expect(saved.OPENAI_API_KEY).toBe('preserve-me');
    expect(saved.extra).toEqual({ nested: true });
    expect(new Headers(refreshInit?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(refreshInit?.body))).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(Array.from(new Bun.Glob('.*.tmp').scanSync({ cwd: join(path, '..') }))).toEqual([]);
  }));

  test('classifies single-use refresh token failures with a re-login hint', () => {
    for (const code of ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']) {
      expect(classifyCodexRefreshError(400, JSON.stringify({ error: code })).message)
        .toContain('gbrain auth login');
    }
    expect(classifyCodexRefreshError(500, 'upstream unavailable').message).not.toContain('upstream unavailable');
  });
});

describe('Codex OAuth request transport', () => {
  test('re-resolves auth per request and retries one 401 after forced refresh', async () => {
    const ensureCalls: Array<{ force?: boolean; expectedAccessToken?: string }> = [];
    const ensureFresh = (async (opts: { force?: boolean; expectedAccessToken?: string } = {}) => {
      ensureCalls.push(opts);
      const accessToken = opts.force ? 'token-new' : 'token-old';
      return { accessToken, accountId: null, source: {} as any };
    }) as typeof ensureFreshCodexToken;
    const seen: string[] = [];
    const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response('', { status: seen.length === 1 ? 401 : 200 });
    }) as typeof fetch;
    const oauthFetch = makeCodexOAuthFetch({ fetch: transport, ensureFresh });

    const response = await oauthFetch('https://api.openai.com/v1/embeddings', { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(seen).toEqual(['Bearer token-old', 'Bearer token-new']);
    expect(ensureCalls).toEqual([
      {},
      { force: true, expectedAccessToken: 'token-old' },
    ]);
  });
});

describe('Codex OAuth callback', () => {
  test('builds the registered authorize request with PKCE and Codex flags', () => {
    const url = new URL(buildCodexAuthorizeUrl('state-value', 'challenge-value'));
    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: 'openid profile email offline_access',
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state: 'state-value',
    });
  });

  test('rejects state mismatch before calling the token endpoint', async () => {
    let called = false;
    const fetchMock = (async () => { called = true; return new Response(); }) as unknown as typeof fetch;
    await expect(handleCodexOAuthCallback('/auth/callback?state=wrong&code=x', 'right', 'verifier', fetchMock))
      .rejects.toThrow('state mismatch');
    expect(called).toBe(false);
  });

  test('exchanges a valid callback using form-urlencoded PKCE fields', async () => {
    let requestBody = '';
    const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body);
      return new Response(JSON.stringify({
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-happy' } }),
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'refresh-happy',
      }), { status: 200 });
    }) as typeof fetch;
    const result = await handleCodexOAuthCallback(
      '/auth/callback?state=state-ok&code=code-ok',
      'state-ok',
      'verifier-ok',
      fetchMock,
    );
    expect(result.tokens.account_id).toBe('acct-happy');
    expect(requestBody).toContain('grant_type=authorization_code');
    expect(requestBody).toContain('code=code-ok');
    expect(requestBody).toContain('code_verifier=verifier-ok');
    expect(requestBody).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback');
    expect(requestBody).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
  });
});

describe('openai-codex readiness', () => {
  test('async gateway build injects a fresh token only for a selected Codex provider', async () => inHomes(async () => {
    await writeJson(gbrainCodexAuthPath(), auth('injected'));
    const selected = await buildGatewayConfigWithAuth({
      embedding_model: 'openai-codex:text-embedding-3-small',
      embedding_dimensions: 1536,
    } as any);
    expect(decodeJwtPayload(selected.env.GBRAIN_CODEX_ACCESS_TOKEN)?.marker).toBe('injected');

    const unrelated = await buildGatewayConfigWithAuth({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
    } as any);
    expect(unrelated.env.GBRAIN_CODEX_ACCESS_TOKEN).toBeUndefined();
  }));

  test('diagnose/isAvailable are false without either token store', async () => inHomes(async () => {
    configureGateway({
      embedding_model: 'openai-codex:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { GBRAIN_HOME: process.env.GBRAIN_HOME, CODEX_HOME: process.env.CODEX_HOME },
    });
    const diagnosis = diagnoseEmbedding();
    expect(diagnosis.ok).toBe(false);
    expect(!diagnosis.ok && diagnosis.reason).toBe('auth_unavailable');
    expect(isAvailable('embedding')).toBe(false);
  }));

  test('diagnose/isAvailable are true with a usable token store', async () => inHomes(async () => {
    await writeJson(gbrainCodexAuthPath(), auth('ready'));
    configureGateway({
      embedding_model: 'openai-codex:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { GBRAIN_HOME: process.env.GBRAIN_HOME, CODEX_HOME: process.env.CODEX_HOME },
    });
    expect(diagnoseEmbedding().ok).toBe(true);
    expect(isAvailable('embedding')).toBe(true);
  }));
});

describe('Codex OAuth hardening', () => {
  test('env-injected access token is honored when no store exists', async () => inHomes(async () => {
    const result = await ensureFreshCodexToken({
      env: { ...process.env, GBRAIN_CODEX_ACCESS_TOKEN: 'env-token' },
    });
    expect(result.accessToken).toBe('env-token');
    expect(result.source).toBeNull();
  }));

  test('refresh does not clobber a newer grant that landed mid-flight', async () => inHomes(async () => {
    const path = gbrainCodexAuthPath();
    await writeJson(path, auth('stale', 'refresh-old', Math.floor(Date.now() / 1000) + 10));
    const concurrent = auth('concurrent-login', 'refresh-other');
    const transport = (async () => {
      // Simulate a concurrent login rotating the store while our refresh runs.
      await writeJson(path, concurrent);
      return new Response(JSON.stringify({
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, marker: 'mine' }),
        refresh_token: 'refresh-mine',
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await ensureFreshCodexToken({ fetch: transport });
    // Caller still gets the fresh token it negotiated...
    expect(decodeJwtPayload(result.accessToken)?.marker).toBe('mine');
    // ...but the concurrent grant on disk is preserved, not overwritten.
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.tokens.refresh_token).toBe('refresh-other');
  }));

  test('persistent 401 does not burn a refresh per request (cooldown)', async () => {
    let refreshes = 0;
    let token = 'tok-0';
    const ensureFresh = (async (opts?: { force?: boolean }) => {
      if (opts?.force) {
        refreshes += 1;
        token = `tok-${refreshes}`;
      }
      return { accessToken: token, accountId: null, source: null };
    }) as unknown as typeof ensureFreshCodexToken;
    const transport = (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch;
    const wrapped = makeCodexOAuthFetch({ fetch: transport, ensureFresh });
    await wrapped('https://api.openai.com/v1/embeddings', { method: 'POST', body: '{}' });
    await wrapped('https://api.openai.com/v1/embeddings', { method: 'POST', body: '{}' });
    await wrapped('https://api.openai.com/v1/embeddings', { method: 'POST', body: '{}' });
    expect(refreshes).toBe(1);
  });
});
