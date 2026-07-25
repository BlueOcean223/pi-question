# pi-question

**English** | [简体中文](README.zh-CN.md)

A [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that gives the LLM a Claude Code-style `ask_user_question` tool: when the model is blocked on a decision that's genuinely yours to make, it presents an interactive option picker instead of guessing.

## Features

- **Single question**: option list with `↑↓` + Enter, plus an automatic "Type something." free-text option (inline editor)
- **Multiple questions (up to 4)**: tab bar with short header chips (`■`/`□` answered state), `Tab`/`←→` to switch, auto-jumps to the next unanswered question, final **Submit** page summarizing all answers
- **multiSelect**: `Space` toggles `[x]`/`[ ]`, Enter confirms the question; custom free-text entries can be added alongside picked options
- **Option previews**: an option can carry a multi-line `preview` (code snippet, mockup, config example) rendered in a bordered block while focused — for visually comparing concrete artifacts
- **Recommended options**: prompt-level convention — the tool description tells the model to put its recommendation first with ` (Recommended)` appended
- Graceful fallbacks: cancel with Esc at any point; returns an error result in non-TUI mode (e.g. `pi -p`)
- No runtime dependencies of its own: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` are provided by your pi install

## Installation

Clone this repo first:

```bash
git clone https://github.com/BlueOcean223/pi-question.git
cd pi-question
```

**Option A — Symlink into global extensions (recommended for development)**

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)" ~/.pi/agent/extensions/pi-question
```

Then restart pi, or run `/reload` inside a session.

**Option B — Load ad-hoc**

```bash
pi -e "$(pwd)/index.ts"
```

## Try it

Ask pi something ambiguous, e.g.:

> I want to add auth to my app — ask me about my preferences using ask_user_question before you start.

## Keys

| Key | Action |
| --- | --- |
| `↑` `↓` | Move between options |
| `Enter` | Select (single) / confirm question (multiSelect) / open editor on "Type something." |
| `Space` | Toggle option (multiSelect) |
| `Tab` / `←` `→` | Switch questions (multi-question mode) |
| `Esc` | Cancel dialog (or leave the inline editor) |

## License

MIT
