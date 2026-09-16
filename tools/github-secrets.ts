// GitHub Actions secret tools: set_github_secret / list_github_secrets /
// delete_github_secret.
//
// GitHub stores secret values write-only: the API takes an encrypted blob (a
// libsodium sealed box over the scope's public key) and can never hand the
// plaintext back. Encryption is not something to improvise per call — a PUT of
// an unencrypted value is rejected (422) and a hand-rolled cipher would store
// something GitHub cannot decrypt — so the tool owns it, using
// libsodium-wrappers (the reference implementation), imported lazily on first
// use so boot stays cheap and a missing package is one clear error message.
//
// The plaintext never has to reach the model: pass `from_env` (a variable of
// this process) or `from_file` (a local file) and the value goes straight from
// the source into the sealed box. Every write and delete pauses for human
// approval through the injected ask() channel — the same gate run_command and
// run_ssh use, reached over the mailbox when the caller is a sub-agent.
// Results report names, scope and source only — never the value.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import type { Tool } from '../lib/react';
import type { ApprovalRequest } from '../lib/guard';

export type SecretScope = 'repo' | 'environment' | 'org';

export type GithubSecretsOpts = {
  ask: (q: ApprovalRequest) => Promise<boolean>; // approval gate for writes/deletes
  token?: string;                                // default: GITHUB_TOKEN, then GH_TOKEN, then tokenFile
  tokenFile?: string;                            // fallback PAT file (e.g. secrets/github-secrets-pat); also GITHUB_TOKEN_FILE
  repo?: string;                                 // default: the git remote of `dir` (owner/name)
  dir?: string;                                  // where to derive the repo from (default: cwd)
  apiBase?: string;                              // default https://api.github.com
  fetchImpl?: typeof fetch;                      // injection point for offline tests
};

const DEFAULT_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
// GitHub's rule for secret names; the GITHUB_ prefix is reserved on top of it.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCOPES: SecretScope[] = ['repo', 'environment', 'org'];

// ---- sealed box (lazy libsodium) ------------------------------------------

type Sodium = {
  ready: Promise<void>;
  base64_variants: { ORIGINAL: number };
  from_base64(s: string, v?: number): Uint8Array;
  from_string(s: string): Uint8Array;
  to_base64(b: Uint8Array, v?: number): string;
  crypto_box_seal(m: Uint8Array, pk: Uint8Array): Uint8Array;
};

let sodiumReady: Promise<Sodium> | null = null;

function sodium(): Promise<Sodium> {
  if (!sodiumReady) {
    sodiumReady = (async () => {
      let mod: { default?: Sodium } & Partial<Sodium>;
      try {
        // Lazy + dynamic: only a secret write pays for libsodium, and a missing
        // package degrades to one actionable message instead of a boot crash.
        mod = (await import('libsodium-wrappers')) as unknown as { default?: Sodium } & Partial<Sodium>;
      } catch (e) {
        throw new Error(
          `libsodium-wrappers is not installed (${(e as Error).message}) — run \`npm i libsodium-wrappers\` in the framework directory`
        );
      }
      const s = (mod.default ?? mod) as Sodium;
      await s.ready;
      return s;
    })().catch((e) => {
      sodiumReady = null; // a failed import must not be cached as the answer forever
      throw e;
    });
  }
  return sodiumReady;
}

/** libsodium crypto_box_seal(value, box public key) -> base64 — exactly what the API expects. */
export async function sealSecret(value: string, publicKeyB64: string): Promise<string> {
  const s = await sodium();
  const sealed = s.crypto_box_seal(s.from_string(value), s.from_base64(publicKeyB64, s.base64_variants.ORIGINAL));
  return s.to_base64(sealed, s.base64_variants.ORIGINAL);
}

// ---- repo / target resolution ---------------------------------------------

/** owner/name out of a GitHub remote URL (https or scp-like), '' if it is not one. */
export function parseGithubRepo(url: string): string {
  const m = url.trim().replace(/\.git$/, '').match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/);
  return m ? `${m[1]}/${m[2]}` : '';
}

/** Normalize an explicit repo argument: owner/name or a full remote URL. */
export function normalizeRepo(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  const fromUrl = parseGithubRepo(t);
  if (fromUrl) return fromUrl;
  return /^[^/\s]+\/[^/\s]+$/.test(t) ? t.replace(/\.git$/, '') : '';
}

/** Default repo from the working directory's git remote (the project the agent runs in). */
export function defaultRepo(dir = process.cwd()): string {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return parseGithubRepo(url);
  } catch {
    return ''; // no git, no remote, no repo — then the caller must pass one explicitly
  }
}

/**
 * The PAT, in order: the explicit option, the process env (GITHUB_TOKEN, then
 * GH_TOKEN), then a token file — the file is only ever the fallback, and only
 * its path is ever known to the model, never its content.
 */
function resolveToken(explicit?: string, tokenFile?: string): string {
  const fromEnv = (explicit || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const file = (tokenFile || process.env.GITHUB_TOKEN_FILE || '').trim();
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return ''; // an absent readable token file is simply "no token"
  }
}

type Target = { scope: SecretScope; repo: string; org: string; environment: string };
type Endpoint = { base: string; label: string };

/** The /secrets base for a scope, or the reason the target is not usable. */
function endpoint(t: Target, apiBase: string): Endpoint | { error: string } {
  if (t.scope === 'org') {
    if (!t.org) return { error: 'org scope needs `org` (the organization login)' };
    return { base: `${apiBase}/orgs/${t.org}/actions/secrets`, label: `org ${t.org}` };
  }
  if (!t.repo)
    return {
      error:
        'no GitHub repo to write to: pass repo: "owner/name" (or scope: "org" with an org) — no github remote was found in this directory',
    };
  if (t.scope === 'environment') {
    if (!t.environment) return { error: 'environment scope needs `environment` (it must already exist on the repo)' };
    return {
      base: `${apiBase}/repos/${t.repo}/environments/${t.environment}/secrets`,
      label: `environment ${t.environment} in ${t.repo}`,
    };
  }
  return { base: `${apiBase}/repos/${t.repo}/actions/secrets`, label: `repo ${t.repo}` };
}

function targetFrom(args: Record<string, unknown>, o: GithubSecretsOpts): Target | { error: string } {
  const rawScope = String(args.scope ?? 'repo').trim() || 'repo';
  if (!SCOPES.includes(rawScope as SecretScope))
    return { error: `unknown scope "${rawScope}" — use one of: ${SCOPES.join(', ')}` };
  const rawRepo = String(args.repo ?? '').trim();
  const repoArg = rawRepo ? normalizeRepo(rawRepo) : '';
  if (rawRepo && !repoArg) return { error: `invalid repo "${rawRepo}" — use "owner/name"` };
  return {
    scope: rawScope as SecretScope,
    repo: repoArg || (o.repo ?? '').trim() || defaultRepo(o.dir ?? process.cwd()),
    org: String(args.org ?? '').trim(),
    environment: String(args.environment ?? '').trim(),
  };
}

// ---- API plumbing ---------------------------------------------------------

type ApiResult = { ok: boolean; status: number; data: Record<string, unknown>; error: string };

/** Turn a GitHub error into something the model can act on. */
function explain(status: number, data: Record<string, unknown>): string {
  const msg = typeof data.message === 'string' ? ` (${data.message})` : '';
  if (status === 401) return `GitHub rejected the token (401)${msg} — export GITHUB_TOKEN (or GH_TOKEN) with secrets write access, then restart`;
  if (status === 403) return `token lacks permission (403)${msg} — repo admin is required (classic "repo" scope, or a fine-grained PAT with Secrets: write; org admin for org secrets)`;
  if (status === 404) return `not found (404)${msg} — check the repo name and, for environment secrets, that the environment already exists`;
  if (status === 422) return `GitHub rejected the payload (422)${msg} — invalid secret name or value`;
  if (status === 429) return `rate limited by GitHub (429)${msg} — retry later`;
  if (status >= 500) return `GitHub server error ${status}${msg} — retry later`;
  return `GitHub API returned ${status}${msg}`;
}

async function api(
  o: GithubSecretsOpts,
  token: string,
  method: 'GET' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown
): Promise<ApiResult> {
  const doFetch = o.fetchImpl ?? ((u: string | URL, init?: RequestInit) => globalThis.fetch(u, init));
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'react-agent-secrets',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: `request to GitHub failed: ${(e as Error).message}` };
  }
  // 204 has no body; anything else should be JSON (an HTML error page must not throw).
  const text = await res.text().catch(() => '');
  let data: Record<string, unknown> = {};
  if (text) {
    try { data = JSON.parse(text) as Record<string, unknown>; }
    catch { data = { message: text.slice(0, 200) }; }
  }
  return { ok: res.ok, status: res.status, data, error: res.ok ? '' : explain(res.status, data) };
}

/** The value to store, from exactly one source — the plaintext stays out of the model's context. */
function resolveValue(args: Record<string, unknown>): { value?: string; source?: string; error?: string } {
  const given = (['value', 'from_env', 'from_file'] as const).filter((k) => String(args[k] ?? '') !== '');
  if (!given.length)
    return { error: 'no value given: pass exactly one of value (literal), from_env (env var name) or from_file (local file path)' };
  if (given.length > 1) return { error: `ambiguous value: pass only one of value/from_env/from_file (got ${given.join(', ')})` };

  const kind = given[0];
  if (kind === 'value') return { value: String(args.value), source: 'literal value' };
  if (kind === 'from_env') {
    const name = String(args.from_env).trim();
    if (process.env[name] === undefined)
      return { error: `env var ${name} is not set in this process — export it (or use from_file) and retry` };
    return { value: process.env[name] as string, source: `env ${name}` };
  }
  const path = String(args.from_file).trim();
  try {
    return { value: readFileSync(path, 'utf8').replace(/\r?\n+$/, ''), source: `file ${path}` };
  } catch (e) {
    return { error: `cannot read ${path}: ${(e as Error).message}` };
  }
}

function checkName(raw: unknown): { name: string } | { error: string } {
  const name = String(raw ?? '').trim();
  if (!name) return { error: 'secret name is required' };
  if (!NAME_RE.test(name)) return { error: `invalid secret name "${name}" — GitHub allows [A-Za-z_][A-Za-z0-9_]*` };
  if (name.startsWith('GITHUB_')) return { error: `"${name}" uses GitHub's reserved GITHUB_ prefix — pick another name` };
  return { name };
}

const TOKEN_HINT =
  'No GitHub token: this process has no GITHUB_TOKEN/GH_TOKEN and no readable token file (GITHUB_TOKEN_FILE). Export a PAT with secrets write access (repo admin for environment/org scopes) or point GITHUB_TOKEN_FILE at a PAT file, then restart.';

// ---- the tools ------------------------------------------------------------

type Prep = { name: string; target: Target; ep: Endpoint; label: string };

/** Name + target resolution for a write/delete — run BEFORE any approval prompt. */
function prepareTarget(
  args: Record<string, unknown>,
  o: GithubSecretsOpts,
  apiBase: string
): Prep | { error: string } {
  const named = checkName(args.name);
  if ('error' in named) return { error: named.error };
  const t = targetFrom(args, o);
  if ('error' in t) return { error: t.error };
  const ep = endpoint(t, apiBase);
  if ('error' in ep) return { error: ep.error };
  return { name: named.name, target: t, ep, label: ep.label };
}

/** set_github_secret validation: a malformed call must not cost the user an approval prompt. */
function prepareSet(
  args: Record<string, unknown>,
  o: GithubSecretsOpts,
  apiBase: string
): Prep | { error: string } {
  const p = prepareTarget(args, o, apiBase);
  if ('error' in p) return p;
  const v = resolveValue(args);
  if (v.error) return { error: v.error };
  if (!v.value) return { error: 'refusing to write an empty secret value — delete the secret instead' };
  return p;
}

/**
 * Build the GitHub secret tools for one principal (orchestrator or sub-agent).
 * ask() is required: every write and delete goes through it, and a denial is
 * final for that call — the value is never encrypted or sent.
 */
export function makeGithubSecretsTools(o: GithubSecretsOpts): Tool[] {
  const apiBase = (o.apiBase ?? DEFAULT_API).replace(/\/+$/, '');
  const token = resolveToken(o.token, o.tokenFile);

  /** Wrap a tool body: validate (for writes), ask, check the token — and never throw. */
  const gated = (
    name: string,
    verb: string,
    describe: ((args: Record<string, unknown>) => Prep | { error: string }) | null,
    run: (args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>
  ) => async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
    try {
      if (describe) {
        const p = describe(args);
        if ('error' in p) return { ok: false, output: p.error };
        const approved = await o.ask({
          tool: name,
          command: `${verb} secret ${p.name} on ${p.label}`,
          reason: 'writes to GitHub — the secret value itself is never shown or stored locally',
        });
        if (!approved) return { ok: false, output: 'DENIED by user approval: nothing was written to GitHub' };
      }
      if (!token) return { ok: false, output: TOKEN_HINT };
      return await run(args);
    } catch (e) {
      return { ok: false, output: `${name} failed: ${(e as Error).message}` }; // tools never throw
    }
  };

  const scopeProps = {
    scope: { type: 'string', description: 'repo (default: Actions secrets), environment, or org' },
    repo: { type: 'string', description: "owner/name to act on (default: this directory's git remote)" },
    environment: { type: 'string', description: 'environment name — required for scope: "environment" (it must already exist)' },
    org: { type: 'string', description: 'organization login — required for scope: "org"' },
  };

  const setSecret: Tool = {
    name: 'set_github_secret',
    description:
      "Create or update a GitHub secret (repository, environment or organization scope). Encryption is done here (libsodium sealed box over the scope's public key) — never write a secret with curl/gh yourself: a raw PUT is rejected with 422. GitHub never returns a secret value, so confirm with list_github_secrets. Pass the value through exactly one of: value (literal), from_env (name of a variable of this process — keeps the plaintext out of the conversation), or from_file (path to a local file whose content is the value). Every write pauses for human approval.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'secret name, [A-Za-z_][A-Za-z0-9_]* (e.g. DEEPSEEK_API_KEY)' },
        value: { type: 'string', description: 'the literal secret value (prefer from_env/from_file when available)' },
        from_env: { type: 'string', description: 'read the value from this environment variable of the current process' },
        from_file: { type: 'string', description: 'read the value from this local file (trailing newlines dropped)' },
        ...scopeProps,
      },
      required: ['name'],
    },
    run: gated('set_github_secret', 'set', (args) => prepareSet(args, o, apiBase), async (args) => {
      const p = prepareSet(args, o, apiBase);
      if ('error' in p) return { ok: false, output: p.error };
      const v = resolveValue(args);
      if (v.error || v.value === undefined) return { ok: false, output: v.error ?? 'no value given' };

      const pk = await api(o, token, 'GET', `${p.ep.base}/public-key`);
      if (!pk.ok) return { ok: false, output: `could not fetch the public key for ${p.label}: ${pk.error}` };
      const keyId = String(pk.data.key_id ?? '');
      const key = String(pk.data.key ?? '');
      if (!keyId || !key)
        return { ok: false, output: `GitHub returned no usable public key for ${p.label} — is that scope reachable with this token?` };

      const encrypted = await sealSecret(v.value, key);
      const put = await api(o, token, 'PUT', `${p.ep.base}/${p.name}`, { encrypted_value: encrypted, key_id: keyId });
      if (!put.ok) return { ok: false, output: `secret ${p.name} NOT set on ${p.label}: ${put.error}` };
      const action = put.status === 201 ? 'created' : 'updated';
      return {
        ok: true,
        output: `secret ${p.name} ${action} on ${p.label} — value from ${v.source} (${v.value.length} chars, never echoed); key_id ${keyId}`,
      };
    }),
  };

  const listSecrets: Tool = {
    name: 'list_github_secrets',
    description:
      'List the secrets defined on a scope (repository, environment or organization). GitHub returns names and timestamps only — a secret value can never be read back through the API, so this is how a write is verified. Read-only, no approval needed.',
    parameters: { type: 'object', properties: { ...scopeProps }, required: [] },
    run: gated('list_github_secrets', 'list', null, async (args) => {
      const t = targetFrom(args, o);
      if ('error' in t) return { ok: false, output: t.error };
      const ep = endpoint(t, apiBase);
      if ('error' in ep) return { ok: false, output: ep.error };
      const res = await api(o, token, 'GET', `${ep.base}?per_page=100`);
      if (!res.ok) return { ok: false, output: `could not list secrets for ${ep.label}: ${res.error}` };
      const secrets = Array.isArray(res.data.secrets)
        ? (res.data.secrets as { name?: string; updated_at?: string }[])
        : [];
      if (!secrets.length) return { ok: true, output: `${ep.label}: no secrets defined` };
      const lines = secrets.map((s) => `- ${s.name ?? '?'} (updated ${String(s.updated_at ?? '?').slice(0, 10)})`).join('\n');
      return { ok: true, output: `${ep.label}: ${secrets.length} secret(s) — values are write-only, never readable:\n${lines}` };
    }),
  };

  const deleteSecret: Tool = {
    name: 'delete_github_secret',
    description:
      'Delete a secret from a scope (repository, environment or organization). Irreversible — the value cannot be recovered, only re-set with set_github_secret. Pauses for human approval.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'secret name to delete' }, ...scopeProps },
      required: ['name'],
    },
    run: gated('delete_github_secret', 'delete', (args) => prepareTarget(args, o, apiBase), async (args) => {
      const p = prepareTarget(args, o, apiBase);
      if ('error' in p) return { ok: false, output: p.error };
      const res = await api(o, token, 'DELETE', `${p.ep.base}/${p.name}`);
      if (!res.ok) return { ok: false, output: `secret ${p.name} NOT deleted from ${p.label}: ${res.error}` };
      return { ok: true, output: `secret ${p.name} deleted from ${p.label}` };
    }),
  };

  return [setSecret, listSecrets, deleteSecret];
}
