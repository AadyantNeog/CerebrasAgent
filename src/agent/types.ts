import type {AgentConfig} from '../config.js';
import type {ToolDefinition, ToolResult} from '../tools/types.js';
import type {ChatMessage, ProviderClient, TokenUsage, ToolCall} from '../provider/types.js';

export type ApprovalRequest = {
  id: string;
  toolName: string;
  args: unknown;
  risk: 'write' | 'delete' | 'command';
  preview: string;
};

export type ApprovalDecision = {
  approved: boolean;
  reason?: string;
};

export type AgentCallbacks = {
  onAssistantMessage(message: string): void;
  onAssistantMessageDelta?(delta: string): void;
  onToolStart(toolName: string, args: unknown): void;
  onToolResult(toolName: string, result: ToolResult): void;
  onTokenUsage?(usage: TokenUsage): void;
  onError(error: Error): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
};

export type AgentDependencies = {
  config: AgentConfig;
  provider: ProviderClient;
  tools: ToolDefinition[];
};

export type {ChatMessage, ProviderClient, TokenUsage, ToolCall};
