export type LocalAiMode = 'disabled' | 'local';
export {
  LocalRetrievalError,
  retrieveLocalPassageChunk,
  type CanonicalPassageReference,
  type LocalPassageChunk,
  type LocalPassageResolver,
  type ResolvedCanonicalPassage,
  type RetrievalVisibility,
  type RetrieveLocalPassageRequest,
} from './retrieval.js';
export {
  isLocalModelRegistry,
  verifyLocalModelArtifact,
  type LocalModelArtifact,
  type LocalModelRegistry,
  type ModelArtifactVerification,
} from './models.js';
export {
  generateLocalAiSuggestion,
  type LocalAiSuggestionKind,
  type LocalAiSuggestionRequest,
  type LocalAiSuggestionPassage,
  type LocalAiSuggestionResult,
  type SuggestionCandidateValidator,
} from './suggestion-generation.js';

export interface LocalAiConfig {
  mode: LocalAiMode;
  endpoint?: URL;
  timeoutMs: number;
}

export interface LocalAiRequest {
  prompt: string;
}

export interface LocalAiRuntime {
  generate(request: LocalAiRequest): Promise<LocalAiResult>;
}

export type LocalAiResult =
  | { status: 'disabled' }
  | { status: 'unavailable'; reason: 'timeout' | 'provider_unreachable' | 'invalid_response' }
  | { status: 'generated'; text: string };

export type LocalAiFetch = typeof fetch;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_RESPONSE_LENGTH = 100_000;

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/gu, '').toLowerCase());
}

function isAllowedEndpoint(endpoint: URL): boolean {
  return (
    endpoint.protocol === 'http:' &&
    isLoopbackHost(endpoint.hostname) &&
    endpoint.username.length === 0 &&
    endpoint.password.length === 0 &&
    endpoint.search.length === 0 &&
    endpoint.hash.length === 0
  );
}

export function readLocalAiConfig(
  environment: Readonly<Record<string, string | undefined>>
): LocalAiConfig {
  const modeValue = environment.AI_MODE ?? 'disabled';
  if (modeValue !== 'disabled' && modeValue !== 'local') {
    throw new TypeError('AI_MODE must be disabled or local');
  }
  const timeoutText = environment.LOCAL_AI_TIMEOUT_MS;
  const timeoutMs = timeoutText === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutText);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`LOCAL_AI_TIMEOUT_MS must be an integer from 100 to ${MAX_TIMEOUT_MS}`);
  }
  if (modeValue === 'disabled') return { mode: 'disabled', timeoutMs };

  const endpointText = environment.LOCAL_AI_ENDPOINT;
  if (!endpointText) throw new TypeError('LOCAL_AI_ENDPOINT is required when AI_MODE=local');
  let endpoint: URL;
  try {
    endpoint = new URL(endpointText);
  } catch (error) {
    throw new TypeError('LOCAL_AI_ENDPOINT must be a valid loopback URL', { cause: error });
  }
  if (!isAllowedEndpoint(endpoint)) {
    throw new TypeError('LOCAL_AI_ENDPOINT must use HTTP on localhost, 127.0.0.1, or ::1 only');
  }
  return { mode: 'local', endpoint, timeoutMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createLocalAiRuntime(
  config: LocalAiConfig,
  fetchProvider: LocalAiFetch = globalThis.fetch
): LocalAiRuntime {
  if (
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 100 ||
    config.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(`timeoutMs must be an integer from 100 to ${MAX_TIMEOUT_MS}`);
  }
  if (config.mode === 'local' && (!config.endpoint || !isAllowedEndpoint(config.endpoint))) {
    throw new TypeError('local AI runtime accepts loopback endpoints only');
  }
  if (config.mode !== 'disabled' && config.mode !== 'local') {
    throw new TypeError('local AI mode is invalid');
  }

  return {
    async generate(request) {
      if (config.mode === 'disabled') return { status: 'disabled' };
      if (
        typeof request.prompt !== 'string' ||
        request.prompt.trim().length === 0 ||
        request.prompt.length > MAX_PROMPT_LENGTH
      ) {
        throw new TypeError(`prompt must contain 1-${MAX_PROMPT_LENGTH} characters`);
      }
      try {
        const response = await fetchProvider(new URL('/v1/generate', config.endpoint), {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: request.prompt }),
          signal: AbortSignal.timeout(config.timeoutMs),
          redirect: 'error',
        });
        if (!response.ok) return { status: 'unavailable', reason: 'provider_unreachable' };
        const body: unknown = await response.json();
        if (
          !isRecord(body) ||
          typeof body.text !== 'string' ||
          body.text.length > MAX_RESPONSE_LENGTH
        ) {
          return { status: 'unavailable', reason: 'invalid_response' };
        }
        return { status: 'generated', text: body.text };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        ) {
          return { status: 'unavailable', reason: 'timeout' };
        }
        return { status: 'unavailable', reason: 'provider_unreachable' };
      }
    },
  };
}
