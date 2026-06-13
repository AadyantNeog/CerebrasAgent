import {afterEach, describe, expect, it} from 'vitest';
import {
  availableModelsFor,
  availableProviders,
  createAgentConfig
} from '../src/config.js';

const originalAgentProvider = process.env.AGENT_PROVIDER;
const originalLegacyProvider = process.env.CEREBRAS_PROVIDER;

afterEach(() => {
  restoreEnvironmentVariable('AGENT_PROVIDER', originalAgentProvider);
  restoreEnvironmentVariable('CEREBRAS_PROVIDER', originalLegacyProvider);
});

describe('createAgentConfig', () => {
  it('uses Ollama by default', () => {
    delete process.env.AGENT_PROVIDER;
    delete process.env.CEREBRAS_PROVIDER;

    const config = createAgentConfig({cwd: process.cwd()});

    expect(config.provider).toBe('ollama');
    expect(config.model).toBe(process.env.OLLAMA_MODEL ?? 'gemma4:e4b-32k');
  });

  it('allows an explicit provider to override the default', () => {
    const config = createAgentConfig({
      cwd: process.cwd(),
      provider: 'cerebras'
    });

    expect(config.provider).toBe('cerebras');
    expect(config.model).toBe(process.env.CEREBRAS_MODEL ?? 'gpt-oss-120b');
  });

  it('exposes providers and models for keyboard navigation', () => {
    expect(availableProviders).toEqual(['ollama', 'cerebras']);
    expect(availableModelsFor('ollama')).toContain('gemma4:e4b-32k');
    expect(availableModelsFor('ollama')).toContain('qwen2.5-coder:14b-65k');
    expect(availableModelsFor('cerebras')).toContain('gpt-oss-120b');
  });
});

function restoreEnvironmentVariable(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
