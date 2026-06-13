import type {AgentConfig} from '../config.js';
import {CerebrasProvider} from './cerebras.js';
import {OllamaProvider} from './ollama.js';
import type {ProviderClient} from './types.js';

export function createProvider(config: AgentConfig): ProviderClient {
  if (config.provider === 'cerebras') {
    return new CerebrasProvider(config.apiKey);
  }

  if (config.provider === 'ollama') {
    return new OllamaProvider(config.baseUrl);
  }

  const exhaustive: never = config.provider;
  throw new Error(`Unsupported provider: ${exhaustive}`);
}
