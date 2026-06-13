import type {ToolDefinition} from '../tools/types.js';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ProviderResponse = {
  message: ChatMessage;
  usage?: TokenUsage;
};

export type ProviderInput = {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
};

export type ProviderStreamEvent =
  | {type: 'content_delta'; delta: string}
  | {type: 'message'; message: ChatMessage}
  | {type: 'usage'; usage: TokenUsage};

export type ProviderClient = {
  name: string;
  complete(input: ProviderInput): Promise<ProviderResponse>;
  stream?(input: ProviderInput): AsyncIterable<ProviderStreamEvent>;
};

export type ProviderName = 'cerebras' | 'ollama';
