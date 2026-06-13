# Terminal Agent Learning Guide

This project is a TypeScript terminal coding agent. It is intentionally small enough to study, but it includes the core pieces used by real coding agents:

- a terminal UI built with Ink
- a multi-turn agent loop
- provider abstraction for Cerebras and Ollama
- streaming assistant output
- tool calling
- approval-gated mutations
- patch-based edits
- file search with ripgrep fallback behavior
- tests for tools, providers, path safety, and the agent loop

The guide explains how the code is organized and how the agent loop works.

## 1. Current Capabilities

The app can:

- chat with a model from the terminal
- stream assistant text as it arrives
- show token usage
- switch providers at runtime with `/provider cerebras` and `/provider ollama`
- switch model with `/model <name>`
- navigate slash commands, providers, and models with the arrow keys
- list, read, and search files
- create files
- apply unified-diff patches
- replace full files with `edit_file` for compatibility
- delete files
- run shell commands
- request approval before any mutating action
- keep all file operations inside the selected workspace root

The two implemented providers are:

```text
cerebras  default model: gpt-oss-120b
ollama    default model: gemma4:e4b-32k
```

The built-in Ollama model list includes:

```text
gemma4:e4b-32k
qwen2.5-coder:14b-65k
```

Ollama uses the local HTTP API at:

```text
http://127.0.0.1:11434
```

You can override this with:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4:e4b-32k
```

## 2. Runtime Flow

At a high level:

```text
user enters prompt
  -> Ink UI sends prompt to Agent
  -> Agent sends messages + tool schemas to active provider
  -> provider streams assistant deltas or returns a complete response
  -> model either answers or requests tool calls
  -> Agent validates tool args
  -> read-only tools run immediately
  -> mutating tools ask the UI for approval
  -> tool results are appended to model history
  -> Agent asks the model again
  -> loop stops when there are no more tool calls
```

The important idea is that the model never directly touches the filesystem or shell. It asks for tool calls. The local TypeScript runtime decides whether those calls are valid and allowed.

## 3. Important Files

```text
src/cli.tsx                CLI flags and Ink startup
src/config.ts              Provider/model/env/default config
src/ui/App.tsx             Terminal UI, slash commands, approvals
src/agent/Agent.ts         Multi-turn agent loop
src/agent/types.ts         Agent callback/dependency types
src/provider/types.ts      Unified provider interface
src/provider/registry.ts   Provider factory
src/provider/cerebras.ts   Cerebras provider
src/provider/ollama.ts     Ollama provider
src/tools/registry.ts      Tool implementations
src/tools/schemas.ts       Zod schemas for tool args
src/tools/path.ts          Workspace path confinement
src/tools/types.ts         Tool contracts
test/*.test.ts             Tests
```

Read order for learning:

1. `src/provider/types.ts`
2. `src/tools/types.ts`
3. `src/tools/registry.ts`
4. `src/agent/Agent.ts`
5. `src/provider/cerebras.ts`
6. `src/provider/ollama.ts`
7. `src/ui/App.tsx`
8. `src/cli.tsx`
9. `test/agent.test.ts`
10. `test/tools.test.ts`
11. `test/provider.test.ts`

## 4. TypeScript Project Setup

The project uses native ES modules:

```json
{
  "type": "module"
}
```

The TypeScript config uses NodeNext module resolution, so source imports include `.js`:

```ts
import {Agent} from './agent/Agent.js';
```

During development, TypeScript resolves that to `.ts` or `.tsx`. After build, the compiled JavaScript imports still point to `.js`.

Common commands:

```bash
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

The project uses:

- `tsx` to run TypeScript directly
- `typescript` for typechecking/builds
- `vitest` for tests
- `eslint` for linting
- `ink` for terminal rendering
- `zod` for runtime validation
- `diff` for unified diffs and patch application
- `execa` for shell commands and ripgrep search

## 5. CLI and Config

The CLI entrypoint is `src/cli.tsx`.

It parses flags with Commander:

```bash
npm run dev
npm run dev -- --cwd .
npm run dev -- --provider cerebras
npm run dev -- --provider ollama
npm run dev -- --provider ollama --model gemma4:e4b-32k
```

The runtime config is built in `src/config.ts`.

Provider and model choices are also exported from this module so the UI can
build its keyboard-driven navigation menus from the same source as the CLI
defaults.

`AgentConfig` includes:

```ts
export type AgentConfig = {
  cwd: string;
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  approvalPolicy: ApprovalPolicy;
  autoApproveReadonly: boolean;
  commandTimeoutMs: number;
};
```

The provider defaults are:

```ts
defaultModelFor('cerebras') // gpt-oss-120b
defaultModelFor('ollama')   // gemma4:e4b-32k
```

Environment variables:

```text
AGENT_PROVIDER     optional default provider
CEREBRAS_API_KEY   required for Cerebras
CEREBRAS_MODEL     optional Cerebras model override
OLLAMA_BASE_URL    optional Ollama server URL
OLLAMA_MODEL       optional Ollama model override
```

## 6. Provider Interface

The provider contract lives in `src/provider/types.ts`.

```ts
export type ProviderClient = {
  name: string;
  complete(input: ProviderInput): Promise<ProviderResponse>;
  stream?(input: ProviderInput): AsyncIterable<ProviderStreamEvent>;
};
```

`complete()` is required.

`stream()` is optional. If a provider implements it, the agent uses streaming. If not, the agent falls back to `complete()`.

The stream event type is a discriminated union:

```ts
export type ProviderStreamEvent =
  | {type: 'content_delta'; delta: string}
  | {type: 'message'; message: ChatMessage}
  | {type: 'usage'; usage: TokenUsage};
```

This is a useful TypeScript pattern. The `type` field lets the agent safely branch on event shape:

```ts
if (event.type === 'content_delta') {
  callbacks.onAssistantMessageDelta?.(event.delta);
}
```

## 7. Provider Registry

`src/provider/registry.ts` creates the right provider from config:

```ts
export function createProvider(config: AgentConfig): ProviderClient {
  if (config.provider === 'cerebras') {
    return new CerebrasProvider(config.apiKey);
  }

  if (config.provider === 'ollama') {
    return new OllamaProvider(config.baseUrl);
  }

  const exhaustive: never = config.provider;
  throw new Error(`Unsupported provider: ${exhaustive}`);
}
```

The `never` assignment is an exhaustiveness check. If you later add a new provider to the `ProviderName` union but forget to handle it here, TypeScript will complain.

## 8. Cerebras Provider

`src/provider/cerebras.ts` adapts the Cerebras SDK to the local provider interface.

It converts:

- local `ChatMessage` objects to Cerebras messages
- local `ToolDefinition` objects to function tools
- Cerebras tool calls back to local `ToolCall`
- Cerebras usage fields to local `TokenUsage`
- streaming chunks to `ProviderStreamEvent`

The rest of the app does not import the Cerebras SDK directly. That isolation is what makes the provider layer maintainable.

## 9. Ollama Provider

`src/provider/ollama.ts` talks to Ollama's local HTTP API:

```text
POST /api/chat
```

It supports both:

```text
stream: false
stream: true
```

Ollama streaming responses are newline-delimited JSON. The provider reads the `ReadableStream`, buffers text, splits on newlines, parses each JSON object, and emits local stream events.

The default Ollama model is:

```text
gemma4:e4b-32k
```

Before using it, make sure Ollama is running and the model is available:

```bash
ollama pull gemma4:e4b-32k
ollama serve
```

Then run:

```bash
npm run dev -- --provider ollama
```

Inside the app:

```text
/provider ollama
/provider cerebras
/model gemma4:e4b-32k
```

Switching providers recreates the agent instance. The visible transcript remains, but the model conversation state starts fresh for the new provider.

## 10. Agent Loop

The agent loop is in `src/agent/Agent.ts`.

It stores message history:

```ts
private readonly messages: ChatMessage[] = [{role: 'system', content: systemPrompt}];
```

Each user prompt is appended:

```ts
this.messages.push({role: 'user', content: userMessage});
```

Then the loop calls the provider:

```ts
for (let turn = 0; turn < maxToolTurns; turn += 1) {
  const providerInput = {
    model: this.deps.config.model,
    messages: this.messages,
    tools: this.deps.tools
  };

  if (this.deps.provider.stream) {
    response = await this.collectStreamingResponse(providerInput, callbacks);
  } else {
    const providerResponse = await this.deps.provider.complete(providerInput);
    response = providerResponse.message;
  }

  this.messages.push(response);

  const toolCalls = response.toolCalls ?? [];
  if (toolCalls.length === 0) {
    return;
  }

  for (const toolCall of toolCalls) {
    await this.handleToolCall(toolCall, callbacks);
  }
}
```

The loop stops when the model returns no tool calls.

`maxToolTurns` prevents infinite loops:

```ts
const maxToolTurns = 12;
```

## 11. Streaming

When a provider supports streaming, the agent consumes stream events:

```ts
for await (const event of this.deps.provider.stream(providerInput)) {
  if (event.type === 'content_delta') {
    callbacks.onAssistantMessageDelta?.(event.delta);
  }

  if (event.type === 'usage') {
    callbacks.onTokenUsage?.(event.usage);
  }

  if (event.type === 'message') {
    response = event.message;
  }
}
```

The UI appends deltas to one active assistant transcript item. This gives live text output while still storing one final assistant message in the agent history.

If a provider does not implement `stream()`, the app still works through `complete()`.

## 12. Tool Calls as Messages

Tool results are appended as `tool` role messages:

```ts
this.messages.push({
  role: 'tool',
  toolCallId,
  content: JSON.stringify(result)
});
```

This is how chat-completion tool calling works:

```text
assistant -> asks for read_file
tool      -> returns file content
assistant -> uses that content in the next response
```

The model cannot see your filesystem by itself. It only sees the tool results your runtime gives it.

## 13. Tools

Tools are registered in `src/tools/registry.ts`.

Current tools:

```text
get_current_directory
list_files
read_file
search_files
apply_patch
create_file
edit_file
delete_file
run_command
```

Each tool has:

```ts
{
  name: 'read_file',
  description: 'Read a UTF-8 text file from the workspace.',
  parameters: { ... },
  requiresApproval: false,
  async execute(rawArgs, context) { ... }
}
```

The `parameters` field is JSON schema for the model.

Zod validates arguments at runtime:

```ts
const args = pathArgsSchema.parse(rawArgs);
```

This two-layer validation matters:

1. JSON schema helps the model call tools correctly.
2. Zod protects your local runtime from malformed model output.

## 14. Read-Only Tools

Read-only tools do not require approval:

```text
get_current_directory
list_files
read_file
search_files
```

`read_file` has a size limit:

```ts
const textFileLimitBytes = 250_000;
```

This avoids dumping huge files into model context.

`search_files` tries ripgrep first:

```text
rg --line-number --fixed-strings ...
```

If `rg` is not available or fails unexpectedly, the tool falls back to a TypeScript file walker and literal search. This keeps the feature portable while still being fast in normal developer environments.

## 15. Mutating Tools

Mutating tools require approval:

```text
apply_patch
create_file
edit_file
delete_file
run_command
```

The agent checks `requiresApproval` before running a tool:

```ts
if (tool.requiresApproval) {
  const request = await this.createApprovalRequest(tool, args, toolCall.id);
  const decision = await callbacks.requestApproval(request);

  if (!decision.approved) {
    // Return rejection as a tool result
    return;
  }
}
```

The UI pauses the agent until the user presses `y` or `n`.

## 16. Patch-Based Editing

The preferred edit tool is:

```text
apply_patch
```

It accepts:

```ts
{
  path: string;
  patch: string;
}
```

The patch must be a unified diff for a single existing file. The tool uses `applyPatch` from the `diff` package with `fuzzFactor: 0`, so it must apply cleanly.

The older `edit_file` tool still exists for compatibility. It replaces the entire file content. The system prompt tells the model to prefer `apply_patch` for existing-file edits because patches are smaller, easier to review, and safer for large files.

## 17. Diff Previews

Mutating file tools generate previews before approval.

For transcript readability, the UI summarizes diffs:

```text
diff: +3 -1
```

The approval panel still shows the actual patch or generated diff.

This mirrors practical coding-agent UI design:

- compact progress in the conversation
- detailed diff at the decision point

## 18. Workspace Path Safety

`src/tools/path.ts` keeps file access inside the workspace root.

It resolves the requested path:

```ts
const resolved = resolve(root, inputPath);
const relation = relative(root, resolved);
```

If the relative path starts with `..`, the path escaped the workspace and is rejected.

This blocks paths like:

```text
../outside.txt
../../secrets.txt
C:\Users\someone\.ssh\id_rsa
```

Always keep path confinement separate from model instructions. The model can be asked to do anything; the local runtime is responsible for enforcing boundaries.

## 19. Shell Commands

`run_command` uses `execaCommand`:

```ts
const result = await execaCommand(args.command, {
  cwd: context.config.cwd,
  shell: true,
  timeout: context.config.commandTimeoutMs,
  reject: false,
  all: true
});
```

Important choices:

- commands run from the workspace
- timeout prevents hanging processes
- non-zero exits are returned as tool results
- stdout and stderr are captured together
- every command requires approval

A future version could add risk classification, but this version is intentionally conservative.

## 20. Ink UI

The UI is in `src/ui/App.tsx`.

Ink lets you write terminal interfaces with React components:

```tsx
<Box flexDirection="column">
  <Text>Hello</Text>
</Box>
```

Important UI state:

```ts
const [activeConfig, setActiveConfig] = useState(config);
const [input, setInput] = useState('');
const [busy, setBusy] = useState(false);
const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
const [approval, setApproval] = useState<PendingApproval | null>(null);
const [usage, setUsage] = useState<UsageTotals>(emptyUsage);
```

`activeConfig` is what makes runtime provider switching possible. When you run `/provider ollama`, the UI updates `activeConfig`, which recreates the `Agent` with a different provider.

## 21. Slash Commands

Slash commands are handled locally by the UI. They are not sent to the model.

Current commands:

```text
/help
/clear
/tokens
/model
/model <name>
/provider
/provider cerebras
/provider ollama
/cwd
/exit
```

Examples:

```text
/help
/provider ollama
/provider cerebras
/model gemma4:e4b-32k
/tokens
/clear
/exit
```

There is intentionally only one command for showing command help: `/help`.

There is intentionally only one command for quitting: `/exit`.

## 22. Transcript Items

The transcript is structured data:

```ts
type TranscriptItem = {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'approval' | 'error' | 'separator';
  title: string;
  text?: string;
  tone: ...;
  compact?: boolean;
};
```

This is better than storing preformatted strings. The UI can render users, assistant messages, tools, approvals, errors, and separators differently.

Tool calls are compact rows. User and assistant messages get stronger layout treatment.

## 23. Thinking Timer

The UI shows a thinking timer while the agent is waiting for a provider response or continuing after an approval:

```ts
const [showThinking, setShowThinking] = useState(false);
const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
const [thinkingSeconds, setThinkingSeconds] = useState(0);
```

`useEffect` updates elapsed time and cleans up the interval:

```ts
useEffect(() => {
  if (!showThinking || thinkingStartedAt === null) {
    return;
  }

  const timer = setInterval(() => {
    setThinkingSeconds(Math.floor((Date.now() - thinkingStartedAt) / 1000));
  }, 250);

  return () => clearInterval(timer);
}, [showThinking, thinkingStartedAt]);
```

The cleanup matters because React effects can rerun many times.

## 24. Approval Promise Pattern

The approval flow is an async UI pattern.

The agent asks:

```ts
requestApproval(request): Promise<ApprovalDecision>
```

The UI stores the promise resolver:

```ts
return new Promise<ApprovalDecision>((resolve) => {
  setApproval({request, resolve});
});
```

The approval panel listens for `y` or `n`:

```ts
useInput((input) => {
  if (input.toLowerCase() === 'y') {
    onResolve({approved: true});
  }
});
```

When the user decides, the resolver wakes the agent loop back up.

## 25. Token Usage

Providers emit usage when available:

```ts
{type: 'usage', usage}
```

or return it from `complete()`.

The UI accumulates totals:

```ts
setUsage((current) => ({
  promptTokens: current.promptTokens + nextUsage.promptTokens,
  completionTokens: current.completionTokens + nextUsage.completionTokens,
  totalTokens: current.totalTokens + nextUsage.totalTokens,
  requests: current.requests + 1
}));
```

When you switch provider or model, usage resets because you are starting a new runtime agent configuration.

## 26. Tests

The test files are:

```text
test/path.test.ts       path confinement
test/tools.test.ts      tool behavior, patching, search, command execution
test/agent.test.ts      tool loop, approvals, streaming
test/provider.test.ts   provider factory behavior
```

The agent tests use fake providers. This keeps them offline and deterministic.

The provider tests do not call real external APIs. They only verify provider creation.

## 27. Adding a Tool

To add a new tool:

1. Add a Zod schema in `src/tools/schemas.ts`.
2. Add a `ToolDefinition` in `src/tools/registry.ts`.
3. Decide whether it needs approval.
4. Add tests in `test/tools.test.ts`.

Example tool shape:

```ts
{
  name: 'count_lines',
  description: 'Count lines in a UTF-8 workspace file.',
  parameters: {
    type: 'object',
    properties: {
      path: {type: 'string'}
    },
    required: ['path'],
    additionalProperties: false
  },
  requiresApproval: false,
  async execute(rawArgs, context) {
    const args = pathArgsSchema.parse(rawArgs);
    const target = resolveWorkspacePath(context.config.cwd, args.path);
    const content = await readFile(target, 'utf8');
    return {
      success: true,
      summary: `${args.path} has ${content.split(/\r?\n/).length} lines.`
    };
  }
}
```

Every tool should return a concise `summary` because the summary is shown in the UI and sent back to the model.

## 28. Adding a Provider

The current implemented providers are only:

```text
cerebras
ollama
```

To add a new provider later:

1. Extend `ProviderName` in `src/provider/types.ts`.
2. Implement `ProviderClient` in `src/provider/<name>.ts`.
3. Add it to `createProvider()` in `src/provider/registry.ts`.
4. Add config defaults in `src/config.ts`.
5. Add provider tests.

Provider implementation shape:

```ts
export class MyProvider implements ProviderClient {
  readonly name = 'my-provider';

  async complete(input: ProviderInput): Promise<ProviderResponse> {
    // convert app messages/tools to provider format
    // call provider
    // convert provider response to ChatMessage
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderStreamEvent> {
    // optional streaming support
  }
}
```

The agent should not need to change when a provider is added. That is the purpose of the provider abstraction.

## 29. Design Tradeoffs

Current choices:

- `apply_patch` is preferred for edits because it is concise and reviewable.
- `edit_file` remains available for compatibility.
- all mutating tools require approval.
- search uses `rg` first but has a TypeScript fallback.
- provider switching resets agent conversation state.
- visible transcript remains after provider switching.
- session history is in memory only.
- Ollama usage is estimated from `prompt_eval_count` and `eval_count` when available.

These choices favor clarity and safety over maximum autonomy.

## 30. Common Failure Modes

Ollama is not running:

- provider request fails
- UI shows an error
- start Ollama with `ollama serve`

Ollama model is missing:

- provider request fails
- pull the model with `ollama pull gemma4:e4b-32k`

Cerebras API key is missing:

- Cerebras provider construction or request fails
- set `CEREBRAS_API_KEY`

Patch does not apply:

- `apply_patch` fails before writing
- model can inspect the current file and try a corrected patch

User rejects a tool:

- tool is not executed
- model receives a rejected tool result

Command exits non-zero:

- result is returned with `success: false`
- stdout/stderr are still available to the model

Huge file read:

- `read_file` refuses files over the configured size limit

## 31. What Makes This an Agent

A chatbot returns text.

This app is an agent because it has:

```text
state      conversation history
tools      read_file, search_files, apply_patch, run_command
policy     approvals and workspace confinement
loop       model -> tool call -> observation -> model
UI         streaming, approvals, transcript, provider switching
```

The loop is the important part. The model can request observations, receive results, and decide what to do next.

## 32. Useful Learning Exercises

Try these one at a time:

1. Add a `/status` command that shows provider, model, cwd, and token usage.
2. Add `read_file_range` with `startLine` and `endLine`.
3. Add `.gitignore` awareness to the TypeScript search fallback.
4. Add command risk classification for read-only commands.
5. Add transcript export to `.cerebras-agent/session.json`.
6. Add a token budget warning.
7. Add provider health checks for Ollama.
8. Add tests for slash command parsing.
9. Add a config file such as `.cerebras-agent.json`.
10. Add session restoration after restart.

Each exercise teaches a different part of TypeScript, UI state, or agent architecture.

## 33. Next Architectural Improvements

The highest-value future improvements are:

- command risk classification
- persistent sessions
- context compaction for long conversations
- configurable approval policy
- `.gitignore`-aware search fallback
- model/provider health checks
- a local config file
- better patch diagnostics when a patch fails
- more provider tests around stream parsing
