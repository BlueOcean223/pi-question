# pi-question

**English** | [简体中文](README.zh-CN.md)

A [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that gives the LLM a Claude Code-style `ask_user_question` tool: when the model is blocked on a decision that's genuinely yours to make, it presents an interactive option picker instead of guessing.

## Features

- **Single question**: numbered option list — press `1`-`9` to pick instantly, or `↑↓` + Enter; single-select submits as soon as you pick
- **Multiple questions (up to 4)**: tab bar with short header chips (`■`/`□` answered state), `Tab`/`←→` to switch, auto-jumps to the next unanswered question, final **Submit** review page
- **"Other" built in**: every question gets an inline free-text row — focus it and just start typing. Text persists per question; if you end up picking a regular option instead, your text is attached as a note rather than discarded
- **multiSelect**: `Space`/`Enter` toggle `[x]`/`[ ]`, an explicit **Next/Submit** button confirms the question — no ambiguous Enter
- **Option previews**: single-select options can carry a multi-line markdown `preview` (code snippet, mockup, config example) rendered side-by-side with the option list (stacked on narrow terminals); digits move focus for comparing, `Enter` decides, `n` adds a note. The "Other" free-text row stays available too — previews don't take it away
- **"Chat about this"**: every question offers an escape hatch that ends the dialog and asks the model to clarify instead — any answers you already picked are carried along
- **Model-friendly results**: answers are keyed by the full question text (no chip-label decoding), selected previews and notes are echoed back as annotations, and cancelling returns guidance ("continue with your best judgment, or ask different questions") instead of a bare rejection
- **Input validation**: 1-4 questions with 2-4 options each; duplicate question texts or option labels are rejected with retryable error messages
- **Recommended options**: prompt-level convention — the tool description tells the model to put its recommendation first with ` (Recommended)` appended
- **Polished terminal UX**: full-width digits/space normalized (CJK input methods), wrap-around navigation, `Home`/`End`/`PageUp`/`PageDown`, and a stable layout — switching tabs never shifts the UI
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
| `1`-`9` | Pick an option directly (single-select commits, multiSelect toggles; in preview layout digits only move focus). Full-width digits `１-９` work too |
| `↑` `↓` | Move between rows (wraps around; also leaves the inline input, saving your text) |
| `Home` `End` `PageUp` `PageDown` | Jump to the first / last row |
| `Enter` | Select (single) / toggle (multiSelect) / confirm on the **Next/Submit** button / save the inline input |
| `Space` | Toggle option (multiSelect); on the "Other" row, toggle your typed answer in/out |
| Any character | On the "Other" row: start typing your answer right away |
| `n` | Add a note (preview questions) |
| `Tab` / `←` `→` | Switch questions (multi-question mode) |
| `Esc` | Cancel dialog (inside the inline input: save text and go back) |

## License

MIT
