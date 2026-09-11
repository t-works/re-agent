# react-agent

Minimal TypeScript multi-agent ReAct framework on the DeepSeek Responses API.
One orchestrator loop answers each turn; it runs local shell commands, SSHes to
configured hosts, `delegate`s to sub-agents, and can author new specialist
agents at runtime with `create_agent`.

Runs from any directory: the project you launch it in is the working directory,
and all writable state (sessions, conversation memory, agents created in a
session) is kept per project.

## Install & run

```sh
npm i -g react-agent        # or: npm i -g .   from a checkout
export DEEPSEEK_API_KEY=...
cd my-project
react-agent                 # bare start resumes this project's last conversation
```

Useful flags and commands: `react-agent --new` starts a fresh conversation,
`--resume <convId>` picks one; at the prompt `restart` reloads the process
(agent registry, compiled sub-agents) keeping the conversation context, and
`q` quits.

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
