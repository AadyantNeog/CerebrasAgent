import type {
  ChatMessage,
  ProviderClient,
  ProviderInput,
  ProviderResponse,
  ProviderStreamEvent,
  ToolCall
} from './types.js';

type OllamaMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
};

type OllamaChatResponse = {
  message?: OllamaMessage;
  prompt_eval_count?: number;
  eval_count?: number;
};

type OllamaStreamChunk = OllamaChatResponse & {
  done?: boolean;
};

export class OllamaProvider implements ProviderClient {
  readonly name = 'ollama';

  constructor(private readonly baseUrl = 'http://127.0.0.1:11434') {}

  async complete(input: ProviderInput): Promise<ProviderResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        model: input.model,
        messages: input.messages.map(toOllamaMessage),
        tools: input.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(await formatOllamaError(response));
    }

    const body = (await response.json()) as OllamaChatResponse;
    return {
      message: toChatMessage(body.message, input),
      usage: toUsage(body)
    };
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderStreamEvent> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        model: input.model,
        messages: input.messages.map(toOllamaMessage),
        tools: input.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(await formatOllamaError(response));
    }

    if (!response.body) {
      throw new Error('Ollama stream response did not include a body.');
    }

    let content = '';
    const nativeToolCalls: ToolCall[] = [];
    let usage: ProviderResponse['usage'];
    const bufferForTextToolFallback = needsTextToolFallback(input.model);

    for await (const chunk of readJsonLines<OllamaStreamChunk>(response.body)) {
      const delta = chunk.message?.content ?? '';
      if (delta) {
        content += delta;
        if (!bufferForTextToolFallback) {
          yield {type: 'content_delta', delta};
        }
      }

      for (const toolCall of chunk.message?.tool_calls ?? []) {
        nativeToolCalls.push({
          id: `ollama_${nativeToolCalls.length}`,
          name: toolCall.function.name,
          argumentsJson: JSON.stringify(toolCall.function.arguments ?? {})
        });
      }

      if (chunk.done) {
        usage = toUsage(chunk);
      }
    }

    if (usage) {
      yield {type: 'usage', usage};
    }

    const textToolCalls = nativeToolCalls.length === 0 && bufferForTextToolFallback
      ? parseTextToolCalls(content, input)
      : [];
    const toolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : textToolCalls;
    const finalContent = toolCalls.length > 0 ? '' : content;

    if (finalContent && bufferForTextToolFallback) {
      yield {type: 'content_delta', delta: finalContent};
    }

    yield {
      type: 'message',
      message: {
        role: 'assistant',
        content: finalContent,
        toolCalls
      }
    };
  }
}

function needsTextToolFallback(model: string): boolean {
  return model.toLowerCase().startsWith('qwen2.5-coder:');
}

function toOllamaMessage(message: ChatMessage): OllamaMessage {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content ?? ''
    };
  }

  const output: OllamaMessage = {
    role: message.role,
    content: message.content ?? ''
  };

  if (message.toolCalls?.length) {
    output.tool_calls = message.toolCalls.map((toolCall) => ({
      function: {
        name: toolCall.name,
        arguments: parseArguments(toolCall.argumentsJson)
      }
    }));
  }

  return output;
}

function toChatMessage(message: OllamaMessage | undefined, input: ProviderInput): ChatMessage {
  if (!message) {
    throw new Error('Ollama returned no assistant message.');
  }

  const nativeToolCalls = message.tool_calls?.map((toolCall, index) => ({
    id: `ollama_${index}`,
    name: toolCall.function.name,
    argumentsJson: JSON.stringify(toolCall.function.arguments ?? {})
  })) ?? [];
  const textToolCalls = nativeToolCalls.length === 0
    ? parseTextToolCalls(message.content ?? '', input)
    : [];
  const toolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : textToolCalls;

  return {
    role: 'assistant',
    content: toolCalls.length > 0 ? '' : message.content ?? '',
    toolCalls
  };
}

function parseTextToolCalls(content: string, input: ProviderInput): ToolCall[] {
  const parsed = parseToolCallObject(content);
  if (!parsed || !input.tools.some((tool) => tool.name === parsed.name)) {
    return [];
  }

  return [{
    id: 'ollama_text_0',
    name: parsed.name,
    argumentsJson: JSON.stringify(parsed.arguments)
  }];
}

function parseToolCallObject(content: string): {name: string; arguments: Record<string, unknown>} | undefined {
  const candidates = extractJsonCandidates(content);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const toolCall = normalizeToolCallObject(parsed);
      if (toolCall) {
        return toolCall;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function extractJsonCandidates(content: string): string[] {
  const candidates: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of content.matchAll(fencePattern)) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  const trimmed = content.trim();
  if (trimmed) {
    candidates.push(trimmed);
  }

  return candidates;
}

function normalizeToolCallObject(value: unknown): {name: string; arguments: Record<string, unknown>} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string'
    ? record.name
    : typeof record.tool === 'string'
      ? record.tool
      : undefined;

  if (!name) {
    return undefined;
  }

  const rawArguments = record.arguments ?? record.args ?? {};
  const toolArguments = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
    ? rawArguments as Record<string, unknown>
    : {};

  return {name, arguments: toolArguments};
}

function toUsage(response: OllamaChatResponse): ProviderResponse['usage'] {
  const promptTokens = response.prompt_eval_count ?? 0;
  const completionTokens = response.eval_count ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  };
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function formatOllamaError(response: Response): Promise<string> {
  const text = await response.text();
  return `Ollama request failed (${response.status}): ${text || response.statusText}`;
}

async function* readJsonLines<T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          yield JSON.parse(trimmed) as T;
        }
      }
    }

    const remaining = buffer.trim();
    if (remaining) {
      yield JSON.parse(remaining) as T;
    }
  } finally {
    reader.releaseLock();
  }
}
