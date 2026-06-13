import type {ProviderName} from './provider/types.js';
import {existsSync, statSync} from 'node:fs';

export type ApprovalPolicy = 'approve-mutations';

export const availableProviders = ['ollama', 'cerebras'] as const satisfies readonly ProviderName[];

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

export function createAgentConfig(input: {
  cwd: string;
  provider?: string;
  model?: string;
  autoApproveReadonly?: boolean;
}): AgentConfig {
  if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) {
    throw new Error(`Workspace directory does not exist: ${input.cwd}`);
  }

  const provider = parseProvider(
    input.provider ?? process.env.AGENT_PROVIDER ?? process.env.CEREBRAS_PROVIDER ?? 'ollama'
  );

  return {
    cwd: input.cwd,
    provider,
    model: input.model ?? defaultModelFor(provider),
    apiKey: provider === 'cerebras' ? process.env.CEREBRAS_API_KEY : undefined,
    baseUrl: provider === 'ollama' ? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434' : undefined,
    approvalPolicy: 'approve-mutations',
    autoApproveReadonly: input.autoApproveReadonly ?? true,
    commandTimeoutMs: 60_000
  };
}

function parseProvider(value: string): ProviderName {
  if (value === 'cerebras' || value === 'ollama') {
    return value;
  }

  throw new Error(`Unsupported provider "${value}". Available providers: cerebras, ollama`);
}

export function defaultModelFor(provider: ProviderName): string {
  if (provider === 'ollama') {
    return process.env.OLLAMA_MODEL ?? 'gemma4:e4b-32k';
  }

  return process.env.CEREBRAS_MODEL ?? 'gpt-oss-120b';
}

export function availableModelsFor(provider: ProviderName): string[] {
  const builtInModels =
    provider === 'ollama'
      ? ['gemma4:e4b-32k', 'qwen2.5-coder:14b-65k']
      : ['gpt-oss-120b'];
  return [...new Set([defaultModelFor(provider), ...builtInModels])];
}
