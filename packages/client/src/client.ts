import {
  ApiError,
  AuthenticationError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from './errors.js';
import {
  ModelRepository,
  type HttpClient,
  type RequestOptions,
  type DownloadProgressOptions,
  type UploadProgressOptions,
  type UploadProgress,
} from './repository.js';
import type {
  AuthTokens,
  CorpusPassage,
  LoginParams,
  ModelInfo,
  MoonWitnessClientOptions,
  RegisterParams,
  ResearchGraphSearchResult,
  ResearchRelationExplanation,
  SourceCitation,
  StoredStoryVersion,
  StoryVersionDocument,
  TokenStorage,
  UserProfile,
} from './types.js';

/** Fallback when no Web Storage exists (Node, SSR, tests). */
export class MemoryStorage implements TokenStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

function defaultStorage(): TokenStorage {
  try {
    // Accessing localStorage can throw (privacy mode, Node without --localstorage-file).
    if (typeof globalThis.localStorage?.getItem === 'function') return globalThis.localStorage;
  } catch {
    /* fall through */
  }
  return new MemoryStorage();
}

interface InternalRequestOptions extends RequestOptions {
  skipAuth?: boolean;
  isRetry?: boolean;
}

function isBinaryBody(value: unknown): value is Blob | FormData | string {
  return (
    typeof value === 'string' ||
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof FormData !== 'undefined' && value instanceof FormData)
  );
}

interface ErrorBody {
  error?: string;
  message?: string;
  type?: string;
  data?: unknown;
}

type SessionListener = (user: UserProfile | null) => void;

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export class MoonWitnessClient implements HttpClient {
  readonly baseUrl: string;
  private readonly storage: TokenStorage;
  private readonly storageKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onSessionExpired?: () => void;
  private readonly listeners = new Set<SessionListener>();

  private tokens: AuthTokens | null = null;
  private currentCompanyId?: number;
  private refreshPromise: Promise<AuthTokens> | null = null;
  private static readonly refreshes = new WeakMap<TokenStorage, Map<string, Promise<AuthTokens>>>();
  private readonly hydrated: Promise<void>;

  constructor(options: MoonWitnessClientOptions) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.storage = options.storage ?? defaultStorage();
    this.storageKey = options.storageKey ?? 'moonwitness_auth';
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onSessionExpired = options.onSessionExpired;
    this.hydrated = this.hydrate();
  }

  setCompanyId(companyId?: number): void {
    this.currentCompanyId = companyId;
  }

  getCompanyId(): number | undefined {
    return this.currentCompanyId ?? this.tokens?.user.company_id;
  }

  /**
   * Loads the persisted session. Synchronous storages (localStorage) are read immediately so
   * `isAuthenticated` is correct right after construction; async storages resolve via `ready()`.
   */
  private hydrate(): Promise<void> {
    const apply = (raw: string | null) => {
      try {
        this.tokens = raw ? (JSON.parse(raw) as AuthTokens) : null;
      } catch {
        this.tokens = null;
      }
    };
    const raw = this.storage.getItem(this.storageKey);
    if (raw instanceof Promise) return raw.then(apply, () => apply(null));
    apply(raw);
    return Promise.resolve();
  }

  /** Resolves once the persisted session is loaded. Only needed for async storages. */
  ready(): Promise<void> {
    return this.hydrated;
  }

  /** Subscribe to login/logout/refresh changes. Returns an unsubscribe function. */
  onSessionChange(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async saveTokens(tokens: AuthTokens | null): Promise<void> {
    this.tokens = tokens;
    if (tokens) await this.storage.setItem(this.storageKey, JSON.stringify(tokens));
    else await this.storage.removeItem(this.storageKey);
    for (const listener of this.listeners) listener(tokens?.user ?? null);
  }

  get currentUser(): UserProfile | null {
    return this.tokens?.user ?? null;
  }

  get isAuthenticated(): boolean {
    return Boolean(this.tokens?.access_token);
  }

  model<TRecord = Record<string, unknown>>(modelName: string): ModelRepository<TRecord> {
    return new ModelRepository<TRecord>(modelName, this);
  }

  /** Models the current user may read. */
  async getModels(): Promise<ModelInfo[]> {
    const res = await this.request<{ models: ModelInfo[] }>('/api/models');
    return res.models;
  }

  async register(params: RegisterParams): Promise<AuthTokens> {
    return this.authenticate('/auth/register', params);
  }

  async login(params: LoginParams): Promise<AuthTokens> {
    return this.authenticate('/auth/login', params);
  }

  private async authenticate(path: string, body: unknown): Promise<AuthTokens> {
    const res = await this.request<{ data: AuthTokens }>(path, {
      method: 'POST',
      body,
      skipAuth: true,
    });
    await this.saveTokens(res.data);
    return res.data;
  }

  /** Rotates the refresh token. Concurrent callers share one in-flight request. */
  refresh(): Promise<AuthTokens> {
    // Must be assigned synchronously: any await before this line lets concurrent callers
    // each start a refresh, and the server revokes the session on refresh-token reuse.
    const key = this.storageKey;
    let shared = MoonWitnessClient.refreshes.get(this.storage);
    if (!shared) {
      shared = new Map();
      MoonWitnessClient.refreshes.set(this.storage, shared);
    }
    const existing = shared.get(key);
    if (existing)
      return existing.then(async (tokens) => {
        this.tokens = tokens;
        return tokens;
      });
    this.refreshPromise ??= (async () => {
      try {
        await this.hydrated;
        const refreshToken = this.tokens?.refresh_token;
        if (!refreshToken) {
          await this.expireSession();
          throw new AuthenticationError('No refresh token available');
        }
        const res = await this.request<{ data: AuthTokens }>('/auth/refresh', {
          method: 'POST',
          body: { refresh_token: refreshToken },
          skipAuth: true,
        });
        await this.saveTokens(res.data);
        return res.data;
      } catch (error) {
        // Only a rejected token ends the session; a network blip should not log the user out.
        if (error instanceof AuthenticationError) await this.expireSession();
        throw error;
      } finally {
        this.refreshPromise = null;
      }
    })();
    shared.set(key, this.refreshPromise);
    void this.refreshPromise
      .finally(() => {
        if (shared?.get(key) === this.refreshPromise) shared.delete(key);
      })
      .catch(() => undefined);
    return this.refreshPromise;
  }

  /** Reuse a token another tab has already rotated before attempting a second rotation. */
  private async refreshAfterUnauthorized(sentToken: string): Promise<void> {
    try {
      const persisted = await this.storage.getItem(this.storageKey);
      if (persisted) {
        const latest = JSON.parse(persisted) as AuthTokens;
        if (
          latest.access_token &&
          latest.access_token !== sentToken &&
          latest.user.id === this.tokens?.user.id
        ) {
          this.tokens = latest;
          return;
        }
      }
    } catch {
      // Storage may be unavailable; the server-side grace handles simultaneous rotations.
    }
    await this.refresh();
  }

  private async expireSession(): Promise<void> {
    const hadSession = this.tokens !== null;
    await this.saveTokens(null);
    if (hadSession) this.onSessionExpired?.();
  }

  async logout(): Promise<void> {
    const refreshToken = this.tokens?.refresh_token;
    await this.saveTokens(null);
    if (!refreshToken) return;
    try {
      await this.request('/auth/logout', {
        method: 'POST',
        body: { refresh_token: refreshToken },
        skipAuth: true,
      });
    } catch {
      // The local session is already gone; server-side revocation is best effort.
    }
  }

  async getMe(): Promise<UserProfile> {
    const res = await this.request<{ data: UserProfile }>('/auth/me');
    if (this.tokens) await this.saveTokens({ ...this.tokens, user: res.data });
    return res.data;
  }

  /** Look up citation metadata for a locally published, rights-cleared source. */
  async getSourceCitation(sourceId: string): Promise<SourceCitation> {
    const res = await this.request<{ success: true; data: SourceCitation }>(
      `/api/corpus/sources/${encodeURIComponent(sourceId)}`
    );
    return res.data;
  }

  /** Read one exact locally published passage; the API does not fetch external sources. */
  async getCorpusPassage(editionId: string, locator: string): Promise<CorpusPassage> {
    const res = await this.request<{ success: true; data: CorpusPassage }>(
      `/api/corpus/passages/${encodeURIComponent(editionId)}/${encodeURIComponent(locator)}`
    );
    return res.data;
  }

  /** Read the latest or one exact INTERNAL story version in the selected company. */
  async getStoryVersion(storyId: string, version?: number): Promise<StoredStoryVersion> {
    const suffix = version === undefined ? '' : `?version=${encodeURIComponent(String(version))}`;
    const res = await this.request<{ success: true; data: StoredStoryVersion }>(
      `/api/research/stories/${encodeURIComponent(storyId)}${suffix}`
    );
    return res.data;
  }

  /** Append a new immutable INTERNAL story version in the selected company. */
  async storeStoryVersion(story: StoryVersionDocument): Promise<StoredStoryVersion> {
    const res = await this.request<{ success: true; data: StoredStoryVersion }>(
      `/api/research/stories/${encodeURIComponent(story.story_id)}`,
      { method: 'POST', body: story }
    );
    return res.data;
  }

  /** Explain one relation from the verified active research release. */
  async getResearchRelationExplanation(relationId: string): Promise<{
    releaseDigest: string;
    explanation: ResearchRelationExplanation;
  }> {
    const res = await this.request<{
      success: true;
      data: { release_digest: string; explanation: ResearchRelationExplanation };
    }>(`/api/research/relations/${encodeURIComponent(relationId)}/explanation`);
    return { releaseDigest: res.data.release_digest, explanation: res.data.explanation };
  }

  /** Search only readable assertion, evidence, and relation summaries in the active release. */
  async searchResearchGraph(
    query: string,
    limit = 20
  ): Promise<{
    releaseDigest: string;
    results: ResearchGraphSearchResult[];
    truncated: boolean;
  }> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const res = await this.request<{
      success: true;
      data: {
        release_digest: string;
        truncated: boolean;
        results: Array<
          | { id: string; kind: 'assertion'; title: string; summary: string }
          | { id: string; kind: 'relation'; title: string; summary: string }
          | ({
              id: string;
              kind: 'evidence';
              title: string;
              summary: string;
              assertion_id: string;
            } & (
              | {
                  source_id: 'mw:source:tanzil-quran-text';
                  edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
                  locator: 'Q7:46';
                }
              | {
                  source_id: 'mw:source:ebible-webp-protestant';
                  edition_id: 'mw:edition:webp-protestant-2020-stable';
                  locator: 'Genesis 1:1';
                }
            ))
        >;
      };
    }>(`/api/research/graph/search?${params.toString()}`);
    return {
      releaseDigest: res.data.release_digest,
      truncated: res.data.truncated,
      results: res.data.results.map((result): ResearchGraphSearchResult => {
        if (result.kind === 'assertion' || result.kind === 'relation') return result;
        const common = {
          id: result.id,
          kind: result.kind,
          title: result.title,
          summary: result.summary,
          assertionId: result.assertion_id,
        } as const;
        return result.source_id === 'mw:source:tanzil-quran-text'
          ? {
              ...common,
              sourceId: result.source_id,
              editionId: result.edition_id,
              locator: result.locator,
            }
          : {
              ...common,
              sourceId: result.source_id,
              editionId: result.edition_id,
              locator: result.locator,
            };
      }),
    };
  }

  /** Odoo-style JSON-RPC call; exposes search_read, search, create, write and unlink. */
  async executeKw<T = unknown>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {}
  ): Promise<T> {
    const res = await this.request<{
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    }>('/jsonrpc', {
      method: 'POST',
      body: {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'call',
        params: { service: 'object', method: 'execute_kw', args: [model, method, args, kwargs] },
      },
    });
    if (res.error) {
      throw new ApiError(res.error.message, res.error.code, 'JsonRpcError', res.error.data);
    }
    return res.result as T;
  }

  /** Authenticated request; retries once after a silent refresh on 401. */
  async request<T>(path: string, options: InternalRequestOptions = {}): Promise<T> {
    if (!options.skipAuth) await this.hydrated;

    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.append(key, String(value));
    }

    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    let requestBody: Blob | FormData | string | undefined;
    if (options.body !== undefined) {
      if (isBinaryBody(options.body)) requestBody = options.body;
      else {
        headers['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(options.body);
      }
    }
    const sentToken = options.skipAuth ? undefined : this.tokens?.access_token;
    if (sentToken) headers.Authorization = `Bearer ${sentToken}`;
    const effectiveCompanyId = this.getCompanyId();
    if (effectiveCompanyId) headers['X-Company-Id'] = String(effectiveCompanyId);

    const res = await this.fetchImpl(url.toString(), {
      method: options.method?.toUpperCase() ?? 'GET',
      headers,
      body: requestBody,
    });

    if (res.status === 401 && !options.skipAuth && !options.isRetry && this.tokens?.refresh_token) {
      // Another request may already have rotated the tokens; replaying the old refresh token
      // would be treated as theft by the server and revoke the whole session.
      if (this.tokens.access_token === sentToken) {
        try {
          await this.refreshAfterUnauthorized(sentToken);
        } catch {
          throw new AuthenticationError('Session expired');
        }
      }
      return this.request<T>(path, { ...options, isRetry: true });
    }

    if (res.ok && options.responseType === 'blob') return (await res.blob()) as T;
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text };
      }
    }

    if (!res.ok) {
      const body = (json ?? {}) as ErrorBody;
      const message = body.error ?? body.message ?? `HTTP ${res.status} ${res.statusText}`;
      switch (res.status) {
        case 400:
          throw new ValidationError(message, body.data);
        case 401:
          throw new AuthenticationError(message, body.data);
        case 403:
          throw new PermissionDeniedError(message, body.data);
        case 404:
          throw new NotFoundError(message, body.data);
        case 409:
          throw new ConflictError(message, body.data);
        default:
          throw new ApiError(message, res.status, body.type, body.data);
      }
    }
    return json as T;
  }

  /** Authenticated multipart upload with browser progress and cancellation support. */
  async requestWithUploadProgress<T>(path: string, options: UploadProgressOptions): Promise<T> {
    await this.hydrated;
    return this.uploadWithProgress<T>(path, options, false);
  }

  /** Sends a browser FormData POST directly to a short-lived storage policy without API credentials. */
  async uploadPresignedPost(
    target: string,
    fields: Readonly<Record<string, string>>,
    file: File,
    options: { signal?: AbortSignal; onUploadProgress: (progress: UploadProgress) => void }
  ): Promise<void> {
    if (typeof XMLHttpRequest === 'undefined' || typeof FormData === 'undefined') {
      throw new ApiError('Direct upload is unavailable in this environment', 0, 'UploadError');
    }
    if (options.signal?.aborted) {
      throw Object.assign(new Error('Upload was cancelled'), { name: 'AbortError' });
    }
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new ApiError('Storage upload URL is invalid', 0, 'UploadError');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new ApiError('Storage upload URL is invalid', 0, 'UploadError');
    }
    const body = new FormData();
    for (const [name, value] of Object.entries(fields)) body.append(name, value);
    body.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url.toString());
    xhr.upload.addEventListener('progress', (event) => {
      options.onUploadProgress({
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : null,
        percent: event.lengthComputable
          ? Math.min(100, Math.round((event.loaded / Math.max(event.total, 1)) * 100))
          : null,
      });
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      const onAbort = () => xhr.abort();
      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new ApiError('Storage rejected the media upload', xhr.status, 'UploadError'));
      };
      xhr.onerror = () => {
        cleanup();
        reject(
          new ApiError('Storage upload failed. Check the storage CORS settings.', 0, 'NetworkError')
        );
      };
      xhr.onabort = () => {
        cleanup();
        reject(Object.assign(new Error('Upload was cancelled'), { name: 'AbortError' }));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      try {
        xhr.send(body);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  /** Authenticated blob download with browser progress and cancellation support. */
  async requestBlobWithDownloadProgress(
    path: string,
    options: DownloadProgressOptions
  ): Promise<Blob> {
    await this.hydrated;
    return this.downloadWithProgress(path, options, false);
  }

  private async downloadWithProgress(
    path: string,
    options: DownloadProgressOptions,
    isRetry: boolean
  ): Promise<Blob> {
    if (typeof XMLHttpRequest === 'undefined') {
      throw new ApiError(
        'Download progress is unavailable in this environment',
        0,
        'DownloadError'
      );
    }
    if (options.signal?.aborted) {
      throw Object.assign(new Error('Download was cancelled'), { name: 'AbortError' });
    }

    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.append(key, String(value));
    }
    const headers: Record<string, string> = { Accept: '*/*', ...options.headers };
    const sentToken = this.tokens?.access_token;
    if (sentToken) headers.Authorization = `Bearer ${sentToken}`;
    const effectiveCompanyId = this.getCompanyId();
    if (effectiveCompanyId) headers['X-Company-Id'] = String(effectiveCompanyId);

    const xhr = new XMLHttpRequest();
    xhr.open(options.method?.toUpperCase() ?? 'GET', url.toString());
    xhr.responseType = 'blob';
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.addEventListener('progress', (event) => {
      options.onDownloadProgress({
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : null,
        percent: event.lengthComputable
          ? Math.min(100, Math.round((event.loaded / Math.max(event.total, 1)) * 100))
          : null,
      });
    });

    const response = await new Promise<{ status: number; statusText: string; blob: Blob | null }>(
      (resolve, reject) => {
        const onAbort = () => xhr.abort();
        const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
        xhr.onload = () => {
          cleanup();
          const headers: Record<string, string> = {};
          const rawHeaders = xhr.getAllResponseHeaders?.() ?? '';
          for (const line of rawHeaders.trim().split(/[\r\n]+/u)) {
            const separator = line.indexOf(':');
            if (separator > 0)
              headers[line.slice(0, separator).trim().toLowerCase()] = line
                .slice(separator + 1)
                .trim();
          }
          options.onDownloadResponse?.(headers);
          resolve({ status: xhr.status, statusText: xhr.statusText, blob: xhr.response });
        };
        xhr.onerror = () => {
          cleanup();
          reject(new ApiError('Network request failed', 0, 'NetworkError'));
        };
        xhr.onabort = () => {
          cleanup();
          reject(Object.assign(new Error('Download was cancelled'), { name: 'AbortError' }));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        try {
          xhr.send();
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
    );

    if (response.status === 401 && !isRetry && this.tokens?.refresh_token) {
      if (this.tokens.access_token === sentToken) {
        try {
          await this.refreshAfterUnauthorized(sentToken);
        } catch {
          throw new AuthenticationError('Session expired');
        }
      }
      return this.downloadWithProgress(path, options, true);
    }

    if (response.status < 200 || response.status >= 300) {
      let json: unknown = null;
      const text = response.blob ? await response.blob.text() : '';
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = { error: text };
        }
      }
      const body = (json ?? {}) as ErrorBody;
      const message =
        body.error ?? body.message ?? `HTTP ${response.status} ${response.statusText}`;
      switch (response.status) {
        case 400:
          throw new ValidationError(message, body.data);
        case 401:
          throw new AuthenticationError(message, body.data);
        case 403:
          throw new PermissionDeniedError(message, body.data);
        case 404:
          throw new NotFoundError(message, body.data);
        case 409:
          throw new ConflictError(message, body.data);
        default:
          throw new ApiError(message, response.status, body.type, body.data);
      }
    }
    return response.blob ?? new Blob();
  }

  private async uploadWithProgress<T>(
    path: string,
    options: UploadProgressOptions,
    isRetry: boolean
  ): Promise<T> {
    if (typeof XMLHttpRequest === 'undefined') {
      throw new ApiError('Upload progress is unavailable in this environment', 0, 'UploadError');
    }
    if (options.signal?.aborted) {
      throw Object.assign(new Error('Upload was cancelled'), { name: 'AbortError' });
    }

    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.append(key, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      // The browser must generate the multipart boundary for FormData.
      if (name.toLowerCase() !== 'content-type') headers[name] = value;
    }
    const sentToken = this.tokens?.access_token;
    if (sentToken) headers.Authorization = `Bearer ${sentToken}`;
    const effectiveCompanyId = this.getCompanyId();
    if (effectiveCompanyId) headers['X-Company-Id'] = String(effectiveCompanyId);

    const xhr = new XMLHttpRequest();
    xhr.open(options.method?.toUpperCase() ?? 'POST', url.toString());
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener('progress', (event) => {
      options.onUploadProgress({
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : null,
        percent: event.lengthComputable
          ? Math.min(100, Math.round((event.loaded / Math.max(event.total, 1)) * 100))
          : null,
      });
    });

    const response = await new Promise<{ status: number; statusText: string; text: string }>(
      (resolve, reject) => {
        const onAbort = () => xhr.abort();
        const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
        xhr.onload = () => {
          cleanup();
          resolve({ status: xhr.status, statusText: xhr.statusText, text: xhr.responseText });
        };
        xhr.onerror = () => {
          cleanup();
          reject(new ApiError('Network request failed', 0, 'NetworkError'));
        };
        xhr.onabort = () => {
          cleanup();
          reject(Object.assign(new Error('Upload was cancelled'), { name: 'AbortError' }));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        try {
          xhr.send(options.body);
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
    );

    if (response.status === 401 && !isRetry && this.tokens?.refresh_token) {
      if (this.tokens.access_token === sentToken) {
        try {
          await this.refreshAfterUnauthorized(sentToken);
        } catch {
          throw new AuthenticationError('Session expired');
        }
      }
      return this.uploadWithProgress<T>(path, options, true);
    }

    let json: unknown = null;
    if (response.text) {
      try {
        json = JSON.parse(response.text);
      } catch {
        json = { error: response.text };
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const body = (json ?? {}) as ErrorBody;
      const message =
        body.error ?? body.message ?? `HTTP ${response.status} ${response.statusText}`;
      switch (response.status) {
        case 400:
          throw new ValidationError(message, body.data);
        case 401:
          throw new AuthenticationError(message, body.data);
        case 403:
          throw new PermissionDeniedError(message, body.data);
        case 404:
          throw new NotFoundError(message, body.data);
        case 409:
          throw new ConflictError(message, body.data);
        default:
          throw new ApiError(message, response.status, body.type, body.data);
      }
    }
    return json as T;
  }
}
