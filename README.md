# @tworks/re-agent

Extremely minimal, raw and risky TypeScript multi-agent ReAct framework on the DeepSeek Responses API.
If you want to play with it - you were warned, this is experimental code. 
If you encounter any issue or if you have a feature request describe it in issues.

One orchestrator loop answers each turn; it runs local shell commands, SSHes to
configured hosts, `delegate`s to sub-agents, and can author new specialist
agents at runtime with `create_agent`. Shipped sub-agents: `config-editor`
(remote host configuration), `vision` (reads images) and `secrets-manager`
(GitHub Actions secrets — every write is encrypted with a libsodium sealed box
and paused for your approval; ask it to set a key by name, e.g. "set the
DEEPSEEK_API_KEY repository secret for this repo from_env DEEPSEEK_API_KEY").

Runs from any directory: the project you launch it in is the working directory,
and all writable state (sessions, conversation memory, agents created in a
session) is kept per project and last conversation is automatically restored. 

## Why just Deepseek
It is enough for what I do and there is close to 0 chance it burns your cash in an hour (https://www.youtube.com/shorts/7vBb4VvYX7g).
At the moment I do not plan extending support for more providers.


## Install & run

```sh
npm npm i -g .        #from a checkout - not released to npm by purpose
export DEEPSEEK_API_KEY=...
export GITHUB_TOKEN=...     #optional: lets secrets-manager set GitHub secrets
                            #alt: put a PAT in ./secrets/github-secrets-pat (git-ignored)
cd my-project
react-agent                 # bare start resumes this project's last conversation
```

Useful flags and commands: `react-agent --new` starts a fresh conversation,
`--resume <convId>` picks one; at the prompt `restart` reboots in place — it
reloads the config, agent registry and compiled sub-agents from disk while
keeping the conversation context — and `q` quits.

## Where state lives

| Root | What |
| --- | --- |
| working dir (`cwd`) | where `run_command` and sub-agents operate |
| `$REACT_STATE_DIR` | override for all writable state |
| `<cwd>/.react` | per-project state when present |
| `~/.react-agent/projects/<name>-<hash>` | default state dir for a project |
| `~/.react-agent/agents` | shared roster, usable from every project |

State holds `memory/sessions` (per-turn mailboxes + handoff workspace),
`memory/conversations` (short-term transcript), `memory/agents` (durable KB),
and `runtime/agents` (agents created via `create_agent`). Set `REACT_HOME` to
move the `~/.react-agent` home.

## Development

```sh
npm run build     # tsc
npm run smoke     # offline checks, no network
```

See `agents.md` for the architecture map.
