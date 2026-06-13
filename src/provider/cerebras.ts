import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type {
  ChatMessage,
  ProviderClient,
  ProviderInput,
  ProviderResponse,
  ProviderStreamEvent,
  ToolCall
} from './types.js';

type CerebrasMessage = {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {name: string; arguments: string};
  }>;
  tool_call_id?: string;
};

type CerebrasToolCall = NonNullable<CerebrasMessage['tool_calls']>[number];

type CerebrasCompletion = {
  choices?: Array<{message?: CerebrasMessage; delta?: CerebrasDelta}>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type CerebrasDelta = {
  content?: string | null;
  tool_calls?: Array<{
    id?: string | null;
    index?: number | null;
    type: 'function';
    function: {name?: string | null; arguments?: string | null};
  }> | null;
};

type StreamingToolCallAccumulator = {
  id: string;
  name: string;
  argumentsJson: string;
};

export class CerebrasProvider implements ProviderClient {
  readonly name = 'cerebras';

  private readonly client: Cerebras;

  constructor(apiKey?: string) {
    this.client = new Cerebras({apiKey});
  }

  async complete(input: ProviderInput): Promise<ProviderResponse> {
    const response = (await this.client.chat.completions.create({
      ...toCerebrasRequest(input)
    } as never)) as unknown as CerebrasCompletion;

    const rawMessage = response.choices?.[0]?.message as CerebrasMessage | undefined;
    if (!rawMessage) {
      throw new Error('Cerebras returned no assistant message.');
    }

    return {
      message: {
        role: 'assistant' as const,
        content: rawMessage.content ?? '',
        toolCalls: rawMessage.tool_calls?.map(toToolCall)
      },
      usage: response.usage ? toTokenUsage(response.usage) : undefined
    };
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderStreamEvent> {
    const stream = (await this.client.chat.completions.create({
      ...toCerebrasRequest(input),
      stream: true,
      stream_options: {include_usage: true}
    } as never)) as unknown as AsyncIterable<CerebrasCompletion>;

    let content = '';
    const toolCalls = new Map<number, StreamingToolCallAccumulator>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        yield {type: 'usage', usage: toTokenUsage(chunk.usage)};
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      const contentDelta = delta?.content ?? '';
      if (contentDelta) {
        content += contentDelta;
        yield {type: 'content_delta', delta: contentDelta};
      }

      for (const toolCallDelta of delta?.tool_calls ?? []) {
        const index =
          typeof toolCallDelta.index === 'number'
            ? toolCallDelta.index
            : toolCalls.size;
        const current = toolCalls.get(index) ?? {
          id: toolCallDelta.id ?? `call_${index}`,
          name: '',
          argumentsJson: ''
        };
        current.id = toolCallDelta.id ?? current.id;
        current.name = toolCallDelta.function.name ?? current.name;
        current.argumentsJson += toolCallDelta.function.arguments ?? '';
        toolCalls.set(index, current);
      }
    }

    yield {
      type: 'message',
      message: {
        role: 'assistant',
        content,
        toolCalls: Array.from(toolCalls.values()).map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          argumentsJson: toolCall.argumentsJson
        }))
      }
    };
  }
}

function toCerebrasRequest(input: ProviderInput) {
  return {
    model: input.model,
    messages: input.messages.map(toCerebrasMessage),
    tools: input.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        strict: true,
        parameters: tool.parameters
      }
    })),
    tool_choice: 'auto'
  };
}

function toCerebrasMessage(message: ChatMessage): CerebrasMessage {
  const output: CerebrasMessage = {
    role: message.role,
    content: message.content
  };

  if (message.toolCalls?.length) {
    output.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: toolCall.argumentsJson
      }
    }));
  }

  if (message.toolCallId) {
    output.tool_call_id = message.toolCallId;
  }

  return output;
}

function toToolCall(toolCall: CerebrasToolCall): ToolCall {
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    argumentsJson: toolCall.function.arguments
  };
}

function toTokenUsage(usage: NonNullable<CerebrasCompletion['usage']>) {
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0
  };
}
