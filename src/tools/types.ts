import type {AgentConfig} from '../config.js';

export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type ToolResult = {
  success: boolean;
  summary: string;
  content?: string;
  diff?: string;
};

export type ToolContext = {
  config: AgentConfig;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
  requiresApproval: boolean;
  risk?: 'write' | 'delete' | 'command';
  makePreview?: (args: unknown, context: ToolContext) => Promise<string>;
  execute: (args: unknown, context: ToolContext) => Promise<ToolResult>;
};
