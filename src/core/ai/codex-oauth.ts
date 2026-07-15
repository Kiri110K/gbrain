/**
 * ChatGPT/Codex OAuth for the OpenAI-compatible embedding provider.
 *
 * Tokens are resolved from gbrain's own store first, then the Codex CLI store.
 * Refresh-token rotation is persisted atomically to the store it came from.
 * Runtime callers use codexOAuthFetch(), which re-checks freshness for every
 * request so long-lived serve/sync processes do not retain an expired token.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { configDir } from '../config.ts';

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_ISSUER = 'https://auth.openai.com';
export const CODEX_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CODEX_OAUTH_SCOPE = 'openid profile email offline_access';
export const CODEX_OAUTH_ACCESS_ENV = 'GBRAIN_CODEX_ACCESS_TOKEN';

const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const FALLBACK_REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_ENDPOINT_TIMEOUT_MS = 30 * 1000;
const REJECTED_TOKEN_COOLDOWN_MS = 5 * 60 * 1000;

export interface CodexTokenSet {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  account_id: string | null;
}

export interface CodexAuthFile {
  auth_mode?: string;
  tokens: CodexTokenSet;
  last_refresh?: string;
  [key: string]: unknown;
}

export interface CodexAuthSource {
  kind: 'gbrain' | 'codex-cli';
  path: string;
  data: CodexAuthFile;
}

export interface CodexAuthStatus {
  authenticated: boolean;
  source?: CodexAuthSource['kind'];
  path?: string;
  accountId?: string | null;
  email?: string;
  planType?: string;
  expiresAt?: string;
  lastRefresh?: string;
  hint?: string;
}

export interface CodexOAuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function randomBase64url(size: number): string {
  return base64url(randomBytes(size));
}

export function gbrainCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env === process.env) return join(configDir(), 'codex-auth.json');
  const override = env.GBRAIN_HOME?.trim();
  if (override && (!isAbsolute(override) || override.split(/[\\/]/).includes('..'))) {
    throw new Error(`GBRAIN_HOME must be an absolute path without '..' segments; got: ${override}`);
  }
  return join(override ? join(override, '.gbrain') : join(homedir(), '.gbrain'), 'codex-auth.json');
}

export function codexCliAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(home, 'auth.json');
}

export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function accessTokenExpiresAt(token: string | undefined): Date | null {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp * 1000) : null;
}

export function shouldRefreshCodexToken(
  auth: Pick<CodexAuthFile, 'tokens' | 'last_refresh'>,
  nowMs = Date.now(),
): boolean {
  const expiresAt = accessTokenExpiresAt(auth.tokens.access_token);
  if (expiresAt) return expiresAt.getTime() - nowMs <= REFRESH_WINDOW_MS;
  const lastRefresh = auth.last_refresh ? Date.parse(auth.last_refresh) : Number.NaN;
  return !Number.isFinite(lastRefresh) || nowMs - lastRefresh >= FALLBACK_REFRESH_AGE_MS;
}

function normalizeAuthFile(value: unknown): CodexAuthFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const tokens = obj.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  const t = tokens as Record<string, unknown>;
  if (typeof t.access_token !== 'string' || !t.access_token) return null;
  if (typeof t.refresh_token !== 'string' || !t.refresh_token) return null;
  return value as CodexAuthFile;
}

function readAuthFileSync(path: string): CodexAuthFile | null {
  try {
    return normalizeAuthFile(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

async function readAuthFile(path: string): Promise<CodexAuthFile | null> {
  try {
    return normalizeAuthFile(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

export function resolveCodexAuthSourceSync(env: NodeJS.ProcessEnv = process.env): CodexAuthSource | null {
  const ownPath = gbrainCodexAuthPath(env);
  if (existsSync(ownPath)) {
    const data = readAuthFileSync(ownPath);
    return data ? { kind: 'gbrain', path: ownPath, data } : null;
  }
  const cliPath = codexCliAuthPath(env);
  const data = readAuthFileSync(cliPath);
  return data ? { kind: 'codex-cli', path: cliPath, data } : null;
}

export async function resolveCodexAuthSource(env: NodeJS.ProcessEnv = process.env): Promise<CodexAuthSource | null> {
  const ownPath = gbrainCodexAuthPath(env);
  try {
    await stat(ownPath);
    const data = await readAuthFile(ownPath);
    return data ? { kind: 'gbrain', path: ownPath, data } : null;
  } catch {
    // Own store absent: fall through to the Codex CLI store.
  }
  const cliPath = codexCliAuthPath(env);
  const data = await readAuthFile(cliPath);
  return data ? { kind: 'codex-cli', path: cliPath, data } : null;
}

export function codexAuthReady(env: NodeJS.ProcessEnv = process.env): { ready: boolean; hint?: string } {
  const source = resolveCodexAuthSourceSync(env);
  return source
    ? { ready: true }
    : {
        ready: false,
        hint: 'Run `gbrain auth login`, or sign in with the Codex CLI so its auth.json can be reused.',
      };
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${path.split('/').pop()}.${process.pid}.${randomBase64url(8)}.tmp`);
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (err) {
    // Never leave a secret-bearing temp file behind on any failure.
    await rm(tmp, { force: true });
    throw err;
  }
}

function accountIdFromIdToken(idToken: string | undefined): string | null {
  const auth = decodeJwtPayload(idToken)?.['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
  const id = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof id === 'string' && id ? id : null;
}

function refreshSetupError(message: string): Error {
  return new Error(`${message} Run \`gbrain auth login\` again.`);
}

export function classifyCodexRefreshError(status: number, body: string): Error {
  const lower = body.toLowerCase();
  if (/refresh_token_(expired|reused|invalidated)/.test(lower)) {
    return refreshSetupError('The ChatGPT/Codex refresh token is no longer usable.');
  }
  return new Error(
    `ChatGPT/Codex token refresh failed (HTTP ${status}). ` +
    'Run `gbrain auth login` again if the problem persists.',
  );
}

interface TokenEndpointResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

async function refreshSource(
  source: CodexAuthSource,
  deps: CodexOAuthDeps,
): Promise<CodexAuthSource> {
  const transport = deps.fetch ?? fetch;
  const response = await transport(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: source.data.tokens.refresh_token,
    }),
    // A hung token endpoint must not wedge the module-level in-flight promise.
    signal: AbortSignal.timeout(TOKEN_ENDPOINT_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) throw classifyCodexRefreshError(response.status, body);
  let payload: TokenEndpointResponse;
  try {
    payload = JSON.parse(body) as TokenEndpointResponse;
  } catch {
    throw new Error('ChatGPT/Codex token refresh returned invalid JSON. Run `gbrain auth login` again.');
  }
  const accessToken = payload.access_token ?? source.data.tokens.access_token;
  const refreshToken = payload.refresh_token ?? source.data.tokens.refresh_token;
  const idToken = payload.id_token ?? source.data.tokens.id_token;
  if (!accessToken || !refreshToken) {
    throw new Error('ChatGPT/Codex token refresh returned incomplete tokens. Run `gbrain auth login` again.');
  }
  const next: CodexAuthFile = {
    ...source.data,
    auth_mode: source.data.auth_mode ?? 'chatgpt',
    tokens: {
      ...source.data.tokens,
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountIdFromIdToken(idToken) ?? source.data.tokens.account_id ?? null,
    },
    last_refresh: new Date((deps.now ?? Date.now)()).toISOString(),
  };
  // Guard against clobbering state that changed while our refresh was in
  // flight: a concurrent login rotated to a different grant (its on-disk
  // refresh token matches neither our snapshot nor our rotation), or a
  // logout removed the store. In both cases skip persistence — the fresh
  // access token still serves this caller until it expires.
  const onDisk = await readAuthFile(source.path);
  const diskToken = onDisk?.tokens.refresh_token;
  const newerGrantLanded = diskToken !== undefined &&
    diskToken !== source.data.tokens.refresh_token && diskToken !== refreshToken;
  const storeRemoved = onDisk === null && !existsSync(source.path);
  if (!newerGrantLanded && !storeRemoved) {
    await atomicWriteJson(source.path, next);
  }
  return { ...source, data: next };
}

const refreshInFlightByPath = new Map<string, Promise<CodexAuthSource>>();

export async function ensureFreshCodexToken(
  opts: CodexOAuthDeps & { force?: boolean; expectedAccessToken?: string } = {},
): Promise<{ accessToken: string; accountId: string | null; source: CodexAuthSource | null }> {
  const source = await resolveCodexAuthSource(opts.env);
  if (!source) {
    // Last resort: an access token injected directly into the env (e.g. CI,
    // or the gateway env snapshot). Not refreshable, but readiness treats it
    // as authenticated, so requests must honor it too.
    const envToken = (opts.env ?? process.env)[CODEX_OAUTH_ACCESS_ENV];
    if (envToken) return { accessToken: envToken, accountId: null, source: null };
    throw new Error(
      'No ChatGPT/Codex OAuth login found. Run `gbrain auth login`, or sign in with the Codex CLI.',
    );
  }
  const now = (opts.now ?? Date.now)();
  const force = opts.force === true &&
    (!opts.expectedAccessToken || source.data.tokens.access_token === opts.expectedAccessToken);
  if (!force && !shouldRefreshCodexToken(source.data, now)) {
    return {
      accessToken: source.data.tokens.access_token,
      accountId: source.data.tokens.account_id ?? accountIdFromIdToken(source.data.tokens.id_token),
      source,
    };
  }

  let inFlight = refreshInFlightByPath.get(source.path);
  if (!inFlight) {
    inFlight = refreshSource(source, opts).finally(() => {
      refreshInFlightByPath.delete(source.path);
    });
    refreshInFlightByPath.set(source.path, inFlight);
  }
  const fresh = await inFlight;
  return {
    accessToken: fresh.data.tokens.access_token,
    accountId: fresh.data.tokens.account_id ?? accountIdFromIdToken(fresh.data.tokens.id_token),
    source: fresh,
  };
}

function withAuthorization(init: RequestInit | undefined, accessToken: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return { ...init, headers };
}

/** Injectable constructor for the per-request auth wrapper (production + tests). */
export function makeCodexOAuthFetch(deps: {
  fetch?: typeof fetch;
  ensureFresh?: typeof ensureFreshCodexToken;
  now?: () => number;
} = {}): typeof fetch {
  const transport = deps.fetch ?? fetch;
  const ensureFresh = deps.ensureFresh ?? ensureFreshCodexToken;
  const now = deps.now ?? Date.now;
  // When even a freshly-rotated token gets 401 (wrong entitlement/scope),
  // back off instead of burning a single-use refresh token on every request.
  let rejectedFresh: { token: string; untilMs: number } | null = null;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const first = await ensureFresh();
    const response = await transport(input, withAuthorization(init, first.accessToken));
    if (response.status !== 401) return response;
    if (rejectedFresh && rejectedFresh.token === first.accessToken && now() < rejectedFresh.untilMs) {
      return response;
    }
    const refreshed = await ensureFresh({
      force: true,
      expectedAccessToken: first.accessToken,
    });
    const retried = await transport(input, withAuthorization(init, refreshed.accessToken));
    if (retried.status === 401) {
      rejectedFresh = { token: refreshed.accessToken, untilMs: now() + REJECTED_TOKEN_COOLDOWN_MS };
    }
    return retried;
  }) as typeof fetch;
}

/** Per-request auth wrapper used by the openai-codex recipe. */
export const codexOAuthFetch = makeCodexOAuthFetch();

export async function prepareCodexOAuthEnv(
  env: Record<string, string | undefined>,
  selectedModels: Array<string | undefined>,
): Promise<Record<string, string | undefined>> {
  if (!selectedModels.some(model => model?.split(/[:/]/, 1)[0] === 'openai-codex')) return env;
  try {
    const fresh = await ensureFreshCodexToken({ env: env as NodeJS.ProcessEnv });
    return { ...env, [CODEX_OAUTH_ACCESS_ENV]: fresh.accessToken };
  } catch {
    // Gateway setup and unrelated commands remain non-fatal. diagnoseEmbedding
    // and the request-time fetch wrapper surface the actionable auth error.
    return env;
  }
}

export function buildCodexAuthorizeUrl(state: string, codeChallenge: string): string {
  const url = new URL(`${CODEX_OAUTH_ISSUER}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', CODEX_OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  transport: typeof fetch,
): Promise<CodexAuthFile> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: verifier,
  });
  const response = await transport(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(TOKEN_ENDPOINT_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ChatGPT/Codex authorization code exchange failed (HTTP ${response.status}).`);
  }
  const payload = JSON.parse(text) as TokenEndpointResponse;
  if (!payload.id_token || !payload.access_token || !payload.refresh_token) {
    throw new Error('ChatGPT/Codex authorization response did not include all required tokens.');
  }
  return {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: payload.id_token,
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      account_id: accountIdFromIdToken(payload.id_token),
    },
    last_refresh: new Date().toISOString(),
  };
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch] ?? ch));
}

export async function handleCodexOAuthCallback(
  requestUrl: string,
  expectedState: string,
  verifier: string,
  transport: typeof fetch = fetch,
): Promise<CodexAuthFile> {
  const url = new URL(requestUrl, CODEX_OAUTH_REDIRECT_URI);
  if (url.pathname !== '/auth/callback') throw new Error('Unexpected OAuth callback path.');
  if (url.searchParams.get('state') !== expectedState) throw new Error('OAuth state mismatch. Please retry `gbrain auth login`.');
  const oauthError = url.searchParams.get('error');
  if (oauthError) throw new Error(`ChatGPT/Codex login was not completed (${oauthError}).`);
  const code = url.searchParams.get('code');
  if (!code) throw new Error('OAuth callback did not include an authorization code.');
  return exchangeAuthorizationCode(code, verifier, transport);
}

function respond(res: ServerResponse, status: number, title: string, detail: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${htmlEscape(title)}</title><h1>${htmlEscape(title)}</h1><p>${htmlEscape(detail)}</p>`);
}

function openBrowser(url: string): void {
  if (process.platform !== 'darwin') return;
  const child = spawn('open', [url], { stdio: 'ignore', detached: true });
  child.unref();
}

export async function loginCodexOAuth(opts: {
  noBrowser?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
  onUrl?: (url: string) => void;
} = {}): Promise<CodexAuthStatus> {
  const verifier = randomBase64url(64);
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = randomBase64url(32);
  const authorizeUrl = buildCodexAuthorizeUrl(state, challenge);
  const transport = opts.fetch ?? fetch;

  return new Promise<CodexAuthStatus>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error, status?: CodexAuthStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err); else resolve(status!);
    };
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Stray requests (favicon.ico, browser prefetch) must not abort the login.
      if (new URL(req.url ?? '/', CODEX_OAUTH_REDIRECT_URI).pathname !== '/auth/callback') {
        respond(res, 404, 'Not found', 'Waiting for the OAuth callback on /auth/callback.');
        return;
      }
      // A callback landing after timeout/settlement must not exchange the
      // code or write credentials.
      if (settled) {
        respond(res, 409, 'GBrain login closed', 'This login attempt already finished. Run `gbrain auth login` again.');
        return;
      }
      try {
        const auth = await handleCodexOAuthCallback(req.url ?? '/', state, verifier, transport);
        await atomicWriteJson(gbrainCodexAuthPath(), auth);
        respond(res, 200, 'GBrain login complete', 'You can return to the terminal.');
        finish(undefined, statusFromSource({ kind: 'gbrain', path: gbrainCodexAuthPath(), data: auth }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        respond(res, 400, 'GBrain login failed', message);
        finish(err instanceof Error ? err : new Error(message));
      }
    });
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for the OAuth callback. Run `gbrain auth login` again.')),
      opts.timeoutMs ?? LOGIN_TIMEOUT_MS,
    );
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        finish(new Error('Cannot start OAuth callback on 127.0.0.1:1455; the port is in use (another login may be running).'));
      } else {
        finish(new Error(`Cannot start OAuth callback server: ${err.message}`));
      }
    });
    server.listen(1455, '127.0.0.1', () => {
      opts.onUrl?.(authorizeUrl);
      if (!opts.noBrowser) openBrowser(authorizeUrl);
    });
  });
}

function claimString(claims: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = claims?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function statusFromSource(source: CodexAuthSource): CodexAuthStatus {
  const claims = decodeJwtPayload(source.data.tokens.id_token);
  const authClaim = claims?.['https://api.openai.com/auth'];
  const auth = authClaim && typeof authClaim === 'object' && !Array.isArray(authClaim)
    ? authClaim as Record<string, unknown>
    : null;
  return {
    authenticated: true,
    source: source.kind,
    path: source.path,
    accountId: source.data.tokens.account_id ?? accountIdFromIdToken(source.data.tokens.id_token),
    email: claimString(claims, 'email'),
    planType: claimString(auth, 'chatgpt_plan_type', 'plan_type'),
    expiresAt: accessTokenExpiresAt(source.data.tokens.access_token)?.toISOString(),
    lastRefresh: source.data.last_refresh,
  };
}

export function getCodexAuthStatus(env: NodeJS.ProcessEnv = process.env): CodexAuthStatus {
  const source = resolveCodexAuthSourceSync(env);
  if (!source) {
    return {
      authenticated: false,
      hint: 'Run `gbrain auth login`, or sign in with the Codex CLI.',
    };
  }
  return statusFromSource(source);
}

export async function logoutCodexOAuth(env: NodeJS.ProcessEnv = process.env): Promise<{
  removed: boolean;
  codexCliFallback: boolean;
}> {
  const ownPath = gbrainCodexAuthPath(env);
  let removed = false;
  try {
    await rm(ownPath);
    removed = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { removed, codexCliFallback: existsSync(codexCliAuthPath(env)) };
}
