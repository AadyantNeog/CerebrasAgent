import {describe, expect, it, vi} from 'vitest';
import {Agent} from '../src/agent/Agent.js';
import type {AgentConfig} from '../src/config.js';
import type {ProviderClient} from '../src/agent/types.js';
import type {ToolDefinition} from '../src/tools/types.js';

const config: AgentConfig = {
  cwd: process.cwd(),
  provider: 'cerebras',
  model: 'test-model',
  approvalPolicy: 'approve-mutations',
  autoApproveReadonly: true,
  commandTimeoutMs: 10_000
};

describe('Agent', () => {
  it('executes an approved tool call and continues to final response', async () => {
    const execute = vi.fn(async () => ({
      success: true,
      summary: 'created file'
    }));

    const provider = fakeProvider([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{id: 'call-1', name: 'create_file', argumentsJson: '{"path":"a.txt"}'}]
      },
      {role: 'assistant', content: 'Done.'}
    ]);

    const agent = new Agent({
      config,
      provider,
      tools: [fakeTool({execute})]
    });

    const assistantMessages: string[] = [];
    await agent.send('create a file', {
      onAssistantMessage: (message) => assistantMessages.push(message),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onError: vi.fn(),
      requestApproval: vi.fn(async () => ({approved: true}))
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(assistantMessages).toEqual(['Done.']);
  });

  it('does not execute a rejected mutation', async () => {
    const execute = vi.fn(async () => ({
      success: true,
      summary: 'created file'
    }));

    const provider = fakeProvider([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{id: 'call-1', name: 'create_file', argumentsJson: '{"path":"a.txt"}'}]
      },
      {role: 'assistant', content: 'I did not change the file.'}
    ]);

    const agent = new Agent({
      config,
      provider,
      tools: [fakeTool({execute})]
    });

    await agent.send('create a file', {
      onAssistantMessage: vi.fn(),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onError: vi.fn(),
      requestApproval: vi.fn(async () => ({approved: false}))
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('streams assistant deltas when the provider supports streaming', async () => {
    const provider: ProviderClient = {
      name: 'fake',
      async complete() {
        throw new Error('complete should not be called');
      },
      async *stream() {
        yield {type: 'content_delta', delta: 'Hel'};
        yield {type: 'content_delta', delta: 'lo'};
        yield {type: 'message', message: {role: 'assistant', content: 'Hello'}};
      }
    };

    const agent = new Agent({
      config,
      provider,
      tools: []
    });

    const deltas: string[] = [];
    const fullMessages: string[] = [];
    await agent.send('say hi', {
      onAssistantMessage: (message) => fullMessages.push(message),
      onAssistantMessageDelta: (delta) => deltas.push(delta),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onError: vi.fn(),
      requestApproval: vi.fn(async () => ({approved: true}))
    });

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(fullMessages).toEqual([]);
  });
});

function fakeProvider(messages: Awaited<ReturnType<ProviderClient['complete']>>['message'][]): ProviderClient {
  let index = 0;
  return {
    name: 'fake',
    async complete() {
      const message = messages[index++];
      if (!message) {
        throw new Error('No fake response left.');
      }

      return {message};
    }
  };
}

function fakeTool(input: {
  execute: ToolDefinition['execute'];
}): ToolDefinition {
  return {
    name: 'create_file',
    description: 'Create file',
    parameters: {
      type: 'object',
      properties: {
        path: {type: 'string'}
      },
      required: ['path'],
      additionalProperties: false
    },
    requiresApproval: true,
    risk: 'write',
    async makePreview() {
      return 'preview';
    },
    execute: input.execute
  };
}
