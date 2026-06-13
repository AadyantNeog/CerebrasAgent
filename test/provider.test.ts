import {describe, expect, it} from 'vitest';
import type {AgentConfig} from '../src/config.js';
import {createProvider} from '../src/provider/registry.js';
import {OllamaProvider} from '../src/provider/ollama.js';

const baseConfig: AgentConfig = {
  cwd: process.cwd(),
  provider: 'cerebras',
  model: 'test-model',
  apiKey: 'test-key',
  approvalPolicy: 'approve-mutations',
  autoApproveReadonly: true,
  commandTimeoutMs: 10_000
};

describe('createProvider', () => {
  it('creates the Cerebras provider', () => {
    expect(createProvider({...baseConfig, provider: 'cerebras'}).name).toBe('cerebras');
  });

  it('creates the Ollama provider', () => {
    expect(
      createProvider({
        ...baseConfig,
        provider: 'ollama',
        model: 'gemma4:e4b-32k',
        baseUrl: 'http://127.0.0.1:11434'
      }).name
    ).toBe('ollama');
  });
});

describe('OllamaProvider', () => {
  it('normalizes fenced JSON tool calls emitted as assistant text', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: [
              '```json',
              '{',
              '  "name": "get_current_directory",',
              '  "arguments": {}',
              '}',
              '```'
            ].join('\n')
          },
          prompt_eval_count: 10,
          eval_count: 5
        }),
        {status: 200}
      );

    try {
      const provider = new OllamaProvider();
      const response = await provider.complete({
        model: 'qwen2.5-coder:14b-65k',
        messages: [{role: 'user', content: 'where am I'}],
        tools: [{
          name: 'get_current_directory',
          description: 'Get cwd',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false
          },
          requiresApproval: false,
          async execute() {
            return {success: true, summary: 'cwd'};
          }
        }]
      });

      expect(response.message.content).toBe('');
      expect(response.message.toolCalls).toEqual([
        {
          id: 'ollama_text_0',
          name: 'get_current_directory',
          argumentsJson: '{}'
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
