# Terminal Agent

A TypeScript terminal coding agent with Cerebras and local Ollama provider support.

## Features

- Ink-based terminal UI with a single inline transcript.
- Cerebras and Ollama providers.
- Streaming assistant responses.
- Token usage display.
- Read-only tools for listing, reading, and searching files.
- Ripgrep-backed search with a TypeScript fallback.
- Approval-gated tools for file creation, patch edits, full-file edits, deletion, and shell commands.
- Diff previews before file mutations.
- Runtime provider/model switching with slash commands.
- Workspace path confinement for file tools.
- Tests for the agent loop, providers, tools, and path safety.

## Setup

For the default local Ollama provider:

```bash
npm install
ollama pull gemma4:e4b-32k
ollama pull qwen2.5-coder:14b-65k
ollama serve
npm run dev -- --cwd .
```

To use Cerebras instead:

```bash
set CEREBRAS_API_KEY=your_key_here
npm run dev -- --provider cerebras
```

On macOS/Linux, use `export CEREBRAS_API_KEY=your_key_here`.

## Commands

```bash
npm run dev
npm run build
npm test
```

The agent can inspect files immediately. File creation, edits, deletion, and shell commands require approval in the terminal UI.

## Providers

```bash
npm run dev -- --provider cerebras
npm run dev -- --provider ollama
```

Defaults:

```text
provider -> ollama
cerebras -> gpt-oss-120b
ollama   -> gemma4:e4b-32k
```

Selectable Ollama models:

```text
gemma4:e4b-32k
qwen2.5-coder:14b-65k
```

Inside the app:

```text
/help
/provider cerebras
/provider ollama
/model <name>
/tokens
/clear
/exit
```

Run `/help` to open the keyboard-driven command menu. `/provider` and
`/model` open their nested selection lists directly. Use Up/Down to move,
Enter or Right to select, Left to go back, and Escape to close.

Use the mouse wheel, Page Up, and Page Down to scroll through conversation
history. Home jumps to the oldest retained message and End returns to the
newest message.

## Learning Guide

Read [docs/LEARNING_GUIDE.md](docs/LEARNING_GUIDE.md) for a detailed walkthrough of the TypeScript structure, provider layer, agentic loop, streaming, tool system, approvals, patch editing, Ink UI, and suggested learning exercises.
