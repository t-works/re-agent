# Future: GitHub secret management, beyond the first cut

Shipped: `tools/github-secrets.ts` (`set_github_secret` / `list_github_secrets` /
`delete_github_secret`, libsodium sealed box, every write approval-gated) plus
`agents/SECRETS-MANAGER`, which owns those tools and sources values with
`from_env` / `from_file` so plaintext never reaches the model.

## 1. More scopes
**Now:** repo (Actions), environment, org — the three this repo could need.
**Future:** Dependabot and Codespaces secrets (same shape, different path), and
repo *variables* (`/actions/variables`), which are not secret at all and could
skip the approval gate.

## 2. Verify by use, not by listing
`list_github_secrets` proves a name exists, never that its value is right —
GitHub cannot decrypt for us. A real check means a throwaway workflow that
consumes the secret (`workflow_dispatch`, one job, no echo of the value), read
through `GET /actions/runs/{id}/jobs`. Worth building the day the repo grows CI
and a wrong key would silently break a release.

## 3. Rotate as a first-class task
**Future:** a `rotate_secret` flow: generate a new value locally (never through
the model), set it on GitHub, update the local consumer, verify, then report the
old value as dead. Today that is three manual steps the agent has to be told.

## 4. Approval ergonomics
One approval per key is right for a single key and tedious for a set of five.
**Future:** let the orchestrator hand over a *plan* — keys, targets, value
sources, no values — that the user approves once, with each write still
audited. The mailbox channel already supports one ask per command; a batch ask
is a front-end change, not a guard change.

## 5. Value sources
**Future:** a named source table (`DEEPSEEK_API_KEY → env`, `NPM_TOKEN → file
secrets/npm.txt`) so a request can say "set the repo's standard key set" and the
agent resolves sources without guessing. Also worth considering: refusing
`value:` literals above some length, since a long literal in a task string is a
secret in a transcript.

## 6. Secret hygiene outside GitHub
`secrets/` in this repo is still untracked but not gitignored (the orchestrator
flagged it): `git add -A` would commit credentials. A `check_secrets_ignored`
step, or a `.gitignore` entry, is cheaper than the incident.
