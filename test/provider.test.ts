import {describe, expect, it} from 'vitest';
import type {AgentConfig} from '../src/config.js';
import {createProvider} from '../src/provider/registry.js';
import {OllamaProvider} from '../src/provider/ollama.js';
import {toCerebrasRequest} from '../src/provider/cerebras.js';

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

  it('streams normal Ollama text incrementally', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(jsonLineStream([
        {message: {role: 'assistant', content: 'Hel'}},
        {
          message: {role: 'assistant', content: 'lo'},
          done: true,
          prompt_eval_count: 3,
          eval_count: 2
        }
      ]), {status: 200});

    try {
      const provider = new OllamaProvider();
      const events = [];
      for await (const event of provider.stream({
        model: 'gemma4:e4b-32k',
        messages: [{role: 'user', content: 'say hello'}],
        tools: []
      })) {
        events.push(event);
      }

      expect(events.filter((event) => event.type === 'content_delta')).toEqual([
        {type: 'content_delta', delta: 'Hel'},
        {type: 'content_delta', delta: 'lo'}
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('CerebrasProvider', () => {
  it('omits tool settings when no tools are supplied', () => {
    const request = toCerebrasRequest({
      model: 'gpt-oss-120b',
      messages: [{role: 'user', content: 'hello'}],
      tools: []
    });

    expect(request).not.toHaveProperty('tools');
    expect(request).not.toHaveProperty('tool_choice');
  });
});

function jsonLineStream(values: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const value of values) {
        controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      }
      controller.close();
    }
  });
}
