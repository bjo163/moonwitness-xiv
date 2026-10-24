import type {
  FieldMeta,
  GroupCountOptions,
  GroupCountResult,
  ModelFields,
  ResolvedViews,
  SearchReadOptions,
  SearchReadResult,
} from './types.js';

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  responseType?: 'json' | 'blob';
  body?: unknown;
}

export interface UploadProgress {
  loadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export interface UploadProgressOptions extends RequestOptions {
  body: FormData;
  signal?: AbortSignal;
  onUploadProgress: (progress: UploadProgress) => void;
}

export interface DownloadProgressOptions extends Omit<RequestOptions, 'body' | 'responseType'> {
  signal?: AbortSignal;
  onDownloadProgress: (progress: UploadProgress) => void;
  onDownloadResponse?: (headers: Readonly<Record<string, string>>) => void;
}

export interface HttpClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
}

/** Typed access to one model's `/api/:model` endpoints. Response shapes mirror generic.routes.ts. */
export class ModelRepository<TRecord = Record<string, unknown>> {
  constructor(
    readonly model: string,
    private readonly http: HttpClient
  ) {}

  private path(...segments: (string | number)[]): string {
    return `/api/${[this.model, ...segments].map((s) => encodeURIComponent(String(s))).join('/')}`;
  }

  /** Field metadata plus the caller's permissions (fields are readonly when write is denied). */
  async getFields(): Promise<ModelFields> {
    const { model, permissions, fields } = await this.http.request<ModelFields>(
      this.path('fields')
    );
    return { model, permissions, fields };
  }

  /** List/form/search view definitions, merged with server-side defaults. */
  async getViews(): Promise<ResolvedViews> {
    const { success: _success, ...views } = await this.http.request<
      ResolvedViews & { success: boolean }
    >(this.path('views'));
    return views;
  }

  async searchRead(options: SearchReadOptions = {}): Promise<SearchReadResult<TRecord>> {
    const res = await this.http.request<{ data: TRecord[]; total?: number }>(this.path(), {
      query: {
        domain: options.domain?.length ? JSON.stringify(options.domain) : undefined,
        fields: options.fields?.length ? options.fields.join(',') : undefined,
        offset: options.offset,
        limit: options.limit,
        order: options.order,
        with: options.with,
        count: options.count ? 'true' : undefined,
      },
    });
    return { records: res.data, ...(res.total !== undefined ? { total: res.total } : {}) };
  }

  /** Returns bounded counts grouped by one to three public scalar model fields. */
  async groupCount(options: GroupCountOptions): Promise<GroupCountResult> {
    return this.http.request<GroupCountResult>(this.path('group-count'), {
      query: {
        domain: options.domain?.length ? JSON.stringify(options.domain) : undefined,
        group_by: options.groupBy.join(','),
        limit: options.limit,
        offset: options.offset,
      },
    });
  }

  async read(id: number, options: { with?: string } = {}): Promise<TRecord> {
    const res = await this.http.request<{ data: TRecord }>(this.path(id), {
      query: { with: options.with },
    });
    return res.data;
  }

  async create(values: Partial<TRecord>): Promise<TRecord> {
    const res = await this.http.request<{ data: TRecord }>(this.path(), {
      method: 'POST',
      body: values,
    });
    return res.data;
  }

  async write(id: number, values: Partial<TRecord>): Promise<TRecord> {
    const res = await this.http.request<{ data: TRecord }>(this.path(id), {
      method: 'PATCH',
      body: values,
    });
    return res.data;
  }

  /** Archives (active=false) by default; `hard: true` deletes permanently. */
  async unlink(id: number, options: { hard?: boolean } = {}): Promise<void> {
    await this.http.request(this.path(id), {
      method: 'DELETE',
      query: { hard: options.hard ? 'true' : undefined },
    });
  }

  /** Runs an exposed `action_*` method on a record. */
  async executeAction<TResult = unknown>(id: number, method: string): Promise<TResult> {
    const res = await this.http.request<{ result: TResult }>(this.path(id, 'action', method), {
      method: 'POST',
      body: {},
    });
    return res.result;
  }

  /** Uploads actual file bytes to the authenticated attachment content endpoint. */
  async uploadAttachment(resourceModel: string, resourceId: number, file: File): Promise<TRecord> {
    const response = await this.http.request<{ data: TRecord }>('/api/base.attachment/upload', {
      method: 'POST',
      query: { resource_model: resourceModel, resource_id: resourceId, name: file.name },
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Mime': file.type || 'application/octet-stream',
      },
      body: file,
    });
    return response.data;
  }

  /** Downloads one attachment as a Blob; the server checks its parent record scope. */
  async downloadAttachment(id: number): Promise<Blob> {
    return this.http.request<Blob>(
      `/api/base.attachment/${encodeURIComponent(String(id))}/download`,
      {
        responseType: 'blob',
      }
    );
  }
}

export type { FieldMeta };
