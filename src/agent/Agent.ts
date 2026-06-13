import type {
  AgentCallbacks,
  AgentDependencies,
  ApprovalRequest,
  ChatMessage,
  ToolCall
} from './types.js';
import type {ToolDefinition, ToolResult} from '../tools/types.js';

const maxToolTurns = 12;

const systemPrompt = `You are a pragmatic AI coding agent running in a user's terminal.

You can inspect the workspace, read files, search files, create files, apply unified patches, delete files, and run shell commands.

Rules:
- Prefer inspecting existing files before proposing changes.
- Use tools when you need current workspace facts.
- Keep edits small and coherent.
- Prefer apply_patch for edits to existing files. Use unified diff format.
- Explain important results briefly after tool work finishes.
- Never attempt to access files outside the workspace.`;

export class Agent {
  private readonly messages: ChatMessage[] = [{role: 'system', content: systemPrompt}];
  private readonly toolsByName: Map<string, ToolDefinition>;

  constructor(private readonly deps: AgentDependencies) {
    this.toolsByName = new Map(deps.tools.map((tool) => [tool.name, tool]));
  }

  async send(userMessage: string, callbacks: AgentCallbacks): Promise<void> {
    this.messages.push({role: 'user', content: userMessage});

    for (let turn = 0; turn < maxToolTurns; turn += 1) {
      let response: ChatMessage;
      let streamedResponse = false;
      try {
        const providerInput = {
          model: this.deps.config.model,
          messages: this.messages,
          tools: this.deps.tools
        };
        if (this.deps.provider.stream) {
          response = await this.collectStreamingResponse(providerInput, callbacks);
          streamedResponse = true;
        } else {
          const providerResponse = await this.deps.provider.complete(providerInput);
          response = providerResponse.message;
          if (providerResponse.usage) {
            callbacks.onTokenUsage?.(providerResponse.usage);
          }
        }
      } catch (error) {
        callbacks.onError(toError(error));
        return;
      }

      // Keep the assistant message before tool results. Chat-completion APIs expect
      // tool result messages to answer a specific preceding assistant tool call.
      this.messages.push(response);
      if (response.content && !streamedResponse) {
        callbacks.onAssistantMessage(response.content);
      }

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) {
        return;
      }

      for (const toolCall of toolCalls) {
        await this.handleToolCall(toolCall, callbacks);
      }
    }

    callbacks.onError(new Error('Stopped after too many consecutive tool calls.'));
  }

  private async collectStreamingResponse(
    providerInput: {
      model: string;
      messages: ChatMessage[];
      tools: ToolDefinition[];
    },
    callbacks: AgentCallbacks
  ): Promise<ChatMessage> {
    let response: ChatMessage | undefined;
    for await (const event of this.deps.provider.stream?.(providerInput) ?? []) {
      if (event.type === 'content_delta') {
        callbacks.onAssistantMessageDelta?.(event.delta);
      }

      if (event.type === 'usage') {
        callbacks.onTokenUsage?.(event.usage);
      }

      if (event.type === 'message') {
        response = event.message;
      }
    }

    if (!response) {
      throw new Error(`${this.deps.provider.name} stream ended without a final message.`);
    }

    return response;
  }

  private async handleToolCall(toolCall: ToolCall, callbacks: AgentCallbacks): Promise<void> {
    const tool = this.toolsByName.get(toolCall.name);
    if (!tool) {
      this.pushToolResult(toolCall.id, {
        success: false,
        summary: `Unknown tool: ${toolCall.name}`
      });
      return;
    }

    let args: unknown;
    try {
      args = parseToolArguments(toolCall.argumentsJson);
    } catch (error) {
      const result = {success: false, summary: toError(error).message};
      callbacks.onToolResult(tool.name, result);
      this.pushToolResult(toolCall.id, result);
      return;
    }

    callbacks.onToolStart(tool.name, args);

    try {
      if (tool.requiresApproval) {
        const request = await this.createApprovalRequest(tool, args, toolCall.id);
        const decision = await callbacks.requestApproval(request);
        if (!decision.approved) {
          const result = {
            success: false,
            summary: decision.reason ?? 'User rejected the requested action.'
          };
          callbacks.onToolResult(tool.name, result);
          this.pushToolResult(toolCall.id, result);
          return;
        }
      }

      const result = await tool.execute(args, {config: this.deps.config});
      callbacks.onToolResult(tool.name, result);
      this.pushToolResult(toolCall.id, result);
    } catch (error) {
      const result = {success: false, summary: toError(error).message};
      callbacks.onToolResult(tool.name, result);
      this.pushToolResult(toolCall.id, result);
    }
  }

  private async createApprovalRequest(
    tool: ToolDefinition,
    args: unknown,
    toolCallId: string
  ): Promise<ApprovalRequest> {
    const preview = tool.makePreview
      ? await tool.makePreview(args, {config: this.deps.config})
      : JSON.stringify(args, null, 2);

    return {
      id: toolCallId,
      toolName: tool.name,
      args,
      risk: tool.risk ?? 'write',
      preview
    };
  }

  private pushToolResult(toolCallId: string, result: ToolResult): void {
    this.messages.push({
      role: 'tool',
      toolCallId,
      content: JSON.stringify(result)
    });
  }
}

function parseToolArguments(argumentsJson: string): unknown {
  try {
    return argumentsJson ? JSON.parse(argumentsJson) : {};
  } catch {
    throw new Error(`Tool arguments were not valid JSON: ${argumentsJson}`);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
