# pi-auto-mode

A [Pi](https://github.com/mariozechner/pi) extension that gates every bash command through an OpenRouter model before it runs. Unsafe or off-task commands are blocked; the agent sees the reason.

## How it works

The extension hooks Pi's `tool_call` event. For each proposed bash command it sends the current task plus the command to an OpenRouter model with a strict judge prompt. The judge replies with minified JSON:

```json
{ "verdict": "allow", "reason": "...", "categories": ["env-read"], "severity": "unknown" }
```

- `categories` — one or more command-type labels for the command
- `severity` — `unknown` | `low` | `medium` | `high`, the command's potential impact

- `allow` — the command runs
- `block` — Pi receives the block with the judge's reason
- OpenRouter error, timeout, or unparsable verdict — **blocked** (fail closed)
- `OPENROUTER_API_KEY` missing — everything is blocked

Verdicts are cached per task+command pair.

## Install

```bash
pi install git:github.com/5c077m4n/pi-auto-mode
```

Requires `OPENROUTER_API_KEY` in Pi's environment.

## Configuration

| Env var                 | Default               | Meaning                            |
| ----------------------- | --------------------- | ---------------------------------- |
| `PIAUTOMODE_MODEL`      | `typesafe/jev-router` | OpenRouter model used as the judge |
| `PIAUTOMODE_TIMEOUT_MS` | `30000`               | Judge request timeout              |

## Try it for one invocation

```bash
OPENROUTER_API_KEY=... pi -e git:github.com/5c077m4n/pi-auto-mode -p "run: echo hello"
```
