import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage, MoonWitnessClient } from '../src/client.js';
import {
  ApiError,
  AuthenticationError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../src/errors.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tokens = (access: string, refresh = `r-${access}`) => ({
  success: true,
  data: {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: 900,
    user: { id: 1, login: 'alice', role: 'user' },
  },
});

function makeClient(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  baseUrl = 'http://api.test/'
) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) =>
    handler(new URL(input), init)
  );
  const storage = new MemoryStorage();
  const client = new MoonWitnessClient({
    baseUrl,
    fetch: fetchMock as unknown as typeof fetch,
    storage,
  });
  return { client, fetchMock, storage };
}

describe('MoonWitnessClient', () => {
  it('uploads presigned POSTs directly to storage without API authentication headers', async () => {
    const requests: Array<{ method: string; url: string; headers: Record<string, string>; body: FormData }> = [];
    class FakeXMLHttpRequest extends EventTarget {
      upload = new EventTarget();
      status = 204;
      headers: Record<string, string> = {};
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      method = '';
      url = '';
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      send(body: FormData) {
        requests.push({ method: this.method, url: this.url, headers: this.headers, body });
        const progress = new Event('progress');
        Object.defineProperties(progress, {
          loaded: { value: 5 },
          total: { value: 10 },
          lengthComputable: { value: true },
        });
        this.upload.dispatchEvent(progress);
        this.onload?.();
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    try {
      const { client } = makeClient((url) =>
        url.pathname === '/auth/login' ? json(tokens('private-api-token')) : json({})
      );
      await client.login({ login: 'alice', password: 'pw' });
      const progress: number[] = [];
      await client.uploadPresignedPost(
        'https://s3.test/private-attachments',
        { key: 'ticket-key', Policy: 'short-lived-policy', 'X-Amz-Signature': 'signature' },
        new File(['image'], 'image.png', { type: 'image/png' }),
        { onUploadProgress: (event) => progress.push(event.percent ?? 0) }
      );
      expect(requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://s3.test/private-attachments',
        headers: {},
      });
      expect(requests[0]?.body.get('key')).toBe('ticket-key');
      expect(requests[0]?.body.get('file')).toBeInstanceOf(File);
      expect(progress).toEqual([50]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports authenticated multipart upload progress without overriding its boundary', async () => {
    const requests: Array<{ headers: Record<string, string>; body: FormData }> = [];
    class FakeXMLHttpRequest extends EventTarget {
      upload = new EventTarget();
      status = 201;
      statusText = 'Created';
      responseText = '{"success":true}';
      headers: Record<string, string> = {};
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(_method: string, _url: string) {}
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      send(body: FormData) {
        requests.push({ headers: this.headers, body });
        const progress = new Event('progress');
        Object.defineProperties(progress, {
          loaded: { value: 5 },
          total: { value: 10 },
          lengthComputable: { value: true },
        });
        this.upload.dispatchEvent(progress);
        this.onload?.();
        this.dispatchEvent(new Event('loadend'));
      }
      abort() {
        this.onabort?.();
        this.dispatchEvent(new Event('loadend'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    try {
      const { client } = makeClient((url) =>
        url.pathname === '/auth/login' ? json(tokens('upload-token')) : json({})
      );
      await client.login({ login: 'alice', password: 'pw' });
      const progress: Array<{
        loadedBytes: number;
        totalBytes: number | null;
        percent: number | null;
      }> = [];
      const body = new FormData();
      body.set('media', new Blob(['file']), 'file.txt');
      const result = await client.requestWithUploadProgress('/whatsapp/upload', {
        method: 'POST',
        body,
        onUploadProgress: (event) => progress.push(event),
      });
      expect(result).toEqual({ success: true });
      expect(requests[0]?.headers.Authorization).toBe('Bearer upload-token');
      expect(requests[0]?.headers['Content-Type']).toBeUndefined();
      expect(requests[0]?.body).toBe(body);
      expect(progress).toEqual([{ loadedBytes: 5, totalBytes: 10, percent: 50 }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancels an in-flight multipart upload with AbortError', async () => {
    let request: InstanceType<typeof XMLHttpRequest> | undefined;
    class FakeXMLHttpRequest extends EventTarget {
      upload = new EventTarget();
      status = 200;
      statusText = 'OK';
      responseText = '{}';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(_method: string, _url: string) {}
      setRequestHeader(_name: string, _value: string) {}
      send(_body: FormData) {
        request = this as unknown as XMLHttpRequest;
      }
      abort() {
        this.onabort?.();
        this.dispatchEvent(new Event('loadend'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    try {
      const { client } = makeClient((url) =>
        url.pathname === '/auth/login' ? json(tokens('upload-token')) : json({})
      );
      await client.login({ login: 'alice', password: 'pw' });
      const controller = new AbortController();
      const pending = client.requestWithUploadProgress('/whatsapp/upload', {
        method: 'POST',
        body: new FormData(),
        signal: controller.signal,
        onUploadProgress: () => {},
      });
      await vi.waitFor(() => expect(request).toBeDefined());
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports authenticated blob download progress and preserves the response MIME type', async () => {
    const requests: Array<{ headers: Record<string, string>; url: string }> = [];
    class FakeXMLHttpRequest extends EventTarget {
      upload = new EventTarget();
      status = 200;
      statusText = 'OK';
      responseType = '';
      response: Blob | null = new Blob(['image'], { type: 'image/png' });
      responseHeaders =
        'content-type: image/webp\r\nx-original-content-type: image/png\r\nx-original-content-length: 2048\r\n';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      headers: Record<string, string> = {};
      url = '';
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      getAllResponseHeaders() {
        return this.responseHeaders;
      }
      send() {
        requests.push({ headers: this.headers, url: this.url });
        const progress = new Event('progress');
        Object.defineProperties(progress, {
          loaded: { value: 8 },
          total: { value: 16 },
          lengthComputable: { value: true },
        });
        this.dispatchEvent(progress);
        this.onload?.();
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    try {
      const { client } = makeClient((url) =>
        url.pathname === '/auth/login' ? json(tokens('download-token')) : json({})
      );
      await client.login({ login: 'alice', password: 'pw' });
      const progress: Array<{
        loadedBytes: number;
        totalBytes: number | null;
        percent: number | null;
      }> = [];
      let responseHeaders: Readonly<Record<string, string>> = {};
      const blob = await client.requestBlobWithDownloadProgress('/whatsapp/media/7', {
        query: { variant: 'preview' },
        onDownloadProgress: (event) => progress.push(event),
        onDownloadResponse: (headers) => (responseHeaders = headers),
      });
      expect(await blob.text()).toBe('image');
      expect(blob.type).toBe('image/png');
      expect(requests[0]?.headers.Authorization).toBe('Bearer download-token');
      expect(requests[0]?.url).toContain('variant=preview');
      expect(progress).toEqual([{ loadedBytes: 8, totalBytes: 16, percent: 50 }]);
      expect(responseHeaders).toMatchObject({
        'x-original-content-type': 'image/png',
        'x-original-content-length': '2048',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancels an in-flight blob download with AbortError', async () => {
    let sent = false;
    class FakeXMLHttpRequest extends EventTarget {
      upload = new EventTarget();
      status = 200;
      statusText = 'OK';
      responseType = '';
      response: Blob | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(_method: string, _url: string) {}
      setRequestHeader(_name: string, _value: string) {}
      send() {
        sent = true;
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    try {
      const { client } = makeClient((url) =>
        url.pathname === '/auth/login' ? json(tokens('download-token')) : json({})
      );
      await client.login({ login: 'alice', password: 'pw' });
      const controller = new AbortController();
      const pending = client.requestBlobWithDownloadProgress('/whatsapp/media/7', {
        signal: controller.signal,
        onDownloadProgress: () => {},
      });
      await vi.waitFor(() => expect(sent).toBe(true));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('removes all trailing slashes from the configured API URL', () => {
    const { client } = makeClient(() => json({}), 'http://api.test////');
    expect(client.baseUrl).toBe('http://api.test');
  });

  it('uploads file bytes and downloads attachments as blobs', async () => {
    let uploadBody: BodyInit | null | undefined;
    let uploadHeaders: Record<string, string> = {};
    const { client } = makeClient((url, init) => {
      if (url.pathname === '/auth/login') return json(tokens('attachment-token'));
      if (url.pathname === '/api/base.attachment/upload') {
        uploadBody = init?.body;
        uploadHeaders = init?.headers as Record<string, string>;
        return json({ data: { id: 17 } }, 201);
      }
      if (url.pathname === '/api/base.attachment/17/download') {
        return new Response(new Blob(['real file bytes'], { type: 'text/plain' }), {
          headers: { 'content-type': 'text/plain' },
        });
      }
      return json({ error: 'unexpected request' }, 404);
    });
    await client.login({ login: 'alice', password: 'pw' });
    const repository = client.model<{ id: number }>('base.attachment');
    const attachment = await repository.uploadAttachment(
      'base.partner',
      42,
      new File(['real file bytes'], 'note.txt', { type: 'text/plain' })
    );
    expect(attachment).toEqual({ id: 17 });
    expect(uploadBody).toBeInstanceOf(Blob);
    expect(uploadHeaders['Content-Type']).toBe('application/octet-stream');
    expect(uploadHeaders['X-File-Mime']).toBe('text/plain');
    const downloaded = await repository.downloadAttachment(17);
    expect(await downloaded.text()).toBe('real file bytes');
  });

  it('sends the bearer token and builds list queries', async () => {
    let seen: { auth?: string; query?: string } = {};
    const { client } = makeClient((url, init) => {
      if (url.pathname === '/auth/login') return json(tokens('a1'));
      seen = { auth: (init?.headers as Record<string, string>).Authorization, query: url.search };
      return json({ success: true, data: [{ id: 1 }], count: 1, total: 7 });
    });

    await client.login({ login: 'alice', password: 'pw' });
    const page = await client.model('base.partner').searchRead({
      domain: [['active', '=', true]],
      limit: 10,
      count: true,
    });

    expect(page).toEqual({ records: [{ id: 1 }], total: 7 });
    expect(seen.auth).toBe('Bearer a1');
    const params = new URLSearchParams(seen.query);
    expect(params.get('domain')).toBe('[["active","=",true]]');
    expect(params.get('limit')).toBe('10');
    expect(params.get('count')).toBe('true');
  });

  it('builds a typed grouped-count request with encoded model path and scoped domain', async () => {
    let seenPath = '';
    let seenQuery = '';
    const { client } = makeClient((url) => {
      if (url.pathname === '/auth/login') return json(tokens('group-token'));
      seenPath = url.pathname;
      seenQuery = url.search;
      return json({
        success: true,
        model: 'base.partner',
        groupBy: ['company_id'],
        groups: [{ values: { company_id: 1 }, count: 4 }],
        limit: 25,
        offset: 2,
        hasMore: true,
      });
    });

    await client.login({ login: 'alice', password: 'pw' });
    const result = await client.model('base.partner').groupCount({
      domain: [['active', '=', true]],
      groupBy: ['company_id'],
      limit: 25,
      offset: 2,
    });

    expect(seenPath).toBe('/api/base.partner/group-count');
    const params = new URLSearchParams(seenQuery);
    expect(params.get('domain')).toBe('[["active","=",true]]');
    expect(params.get('group_by')).toBe('company_id');
    expect(params.get('limit')).toBe('25');
    expect(params.get('offset')).toBe('2');
    expect(result.groups).toEqual([{ values: { company_id: 1 }, count: 4 }]);
    expect(result.hasMore).toBe(true);
  });

  it('provides typed local source citation and passage lookup methods', async () => {
    const seen: string[] = [];
    const { client } = makeClient((url) => {
      seen.push(url.pathname);
      if (url.pathname === '/api/corpus/sources/mw%3Asource%3Atanzil-quran-text') {
        return json({
          success: true,
          data: {
            sourceId: 'mw:source:tanzil-quran-text',
            editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
            locale: 'ar',
            publication: 'source_bytes',
            citation: 'Tanzil CC BY 3.0',
            references: ['https://tanzil.net/'],
            availablePassages: ['Q7:46'],
          },
        });
      }
      if (url.pathname === '/api/corpus/sources/mw%3Asource%3Aebible-webp-protestant') {
        return json({
          success: true,
          data: {
            sourceId: 'mw:source:ebible-webp-protestant',
            expressionId: 'mw:expression:webp-protestant',
            editionId: 'mw:edition:webp-protestant-2020-stable',
            locale: 'en-US',
            publication: 'source_bytes',
            citation: 'WEBP Genesis 1:1; eBible.org, public domain',
            references: ['https://ebible.org/engwebp/GEN01.htm'],
            availablePassages: ['Genesis 1:1'],
          },
        });
      }
      if (url.pathname.endsWith('/Genesis%201%3A1')) {
        return json({
          success: true,
          data: {
            sourceId: 'mw:source:ebible-webp-protestant',
            expressionId: 'mw:expression:webp-protestant',
            editionId: 'mw:edition:webp-protestant-2020-stable',
            locator: 'Genesis 1:1',
            text: 'In the beginning ...',
            sha256: 'b'.repeat(64),
            citation: 'WEBP Genesis 1:1; eBible.org, public domain',
          },
        });
      }
      return json({
        success: true,
        data: {
          sourceId: 'mw:source:tanzil-quran-text',
          editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
          locator: 'Q7:46',
          text: 'local verse text',
          sha256: 'a'.repeat(64),
          citation: 'Tanzil CC BY 3.0',
        },
      });
    });

    const source = await client.getSourceCitation('mw:source:tanzil-quran-text');
    const passage = await client.getCorpusPassage(source.editionId, 'Q7:46');
    expect(source.availablePassages).toEqual(['Q7:46']);
    expect(passage).toMatchObject({ locator: 'Q7:46', text: 'local verse text' });
    expect(seen).toEqual([
      '/api/corpus/sources/mw%3Asource%3Atanzil-quran-text',
      '/api/corpus/passages/mw%3Aedition%3Atanzil-quran-text-v1.1-uthmani-txt2/Q7%3A46',
    ]);

    const webp = await client.getSourceCitation('mw:source:ebible-webp-protestant');
    expect(webp).toMatchObject({
      sourceId: 'mw:source:ebible-webp-protestant',
      expressionId: 'mw:expression:webp-protestant',
      editionId: 'mw:edition:webp-protestant-2020-stable',
      availablePassages: ['Genesis 1:1'],
    });
    expect(webp.expressionId).not.toBe(webp.editionId);
    const webpPassage = await client.getCorpusPassage(webp.editionId, 'Genesis 1:1');
    expect(webpPassage).toMatchObject({
      sourceId: webp.sourceId,
      expressionId: webp.expressionId,
      editionId: webp.editionId,
      locator: 'Genesis 1:1',
    });
  });

  it('shares one refresh across concurrent 401s and retries each request', async () => {
    let refreshes = 0;
    const { client } = makeClient((url, init) => {
      if (url.pathname === '/auth/login') return json(tokens('old'));
      if (url.pathname === '/auth/refresh') {
        refreshes++;
        return json(tokens('new'));
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new' ? json({ models: [] }) : json({ error: 'expired' }, 401);
    });

    await client.login({ login: 'alice', password: 'pw' });
    await Promise.all([client.getModels(), client.getModels(), client.getModels()]);
    expect(refreshes).toBe(1);
  });

  it('keeps the session when refresh fails for a non-auth reason', async () => {
    const { client } = makeClient((url) => {
      if (url.pathname === '/auth/login') return json(tokens('a1'));
      if (url.pathname === '/auth/refresh') return json({ error: 'boom' }, 503);
      return json({ error: 'expired' }, 401);
    });
    await client.login({ login: 'alice', password: 'pw' });
    await expect(client.getModels()).rejects.toBeInstanceOf(AuthenticationError);
    expect(client.isAuthenticated).toBe(true);
  });

  it('notifies session listeners on login and logout', async () => {
    const { client } = makeClient((url) =>
      url.pathname === '/auth/login' ? json(tokens('a1')) : json({ success: true })
    );
    const events: (string | null)[] = [];
    client.onSessionChange((user) => events.push(user?.login ?? null));
    await client.login({ login: 'alice', password: 'pw' });
    await client.logout();
    expect(events).toEqual(['alice', null]);
  });

  it('supports async storages via ready()', async () => {
    const backing = new MemoryStorage();
    backing.setItem('moonwitness_auth', JSON.stringify(tokens('stored').data));
    const client = new MoonWitnessClient({
      baseUrl: 'http://api.test',
      fetch: vi.fn() as unknown as typeof fetch,
      storage: {
        getItem: async (k) => backing.getItem(k),
        setItem: async (k, v) => backing.setItem(k, v),
        removeItem: async (k) => backing.removeItem(k),
      },
    });
    await client.ready();
    expect(client.currentUser?.login).toBe('alice');
  });

  it('maps HTTP status codes to typed errors', async () => {
    const { client } = makeClient((url) => json({ error: 'x' }, Number(url.pathname.slice(1))));
    await expect(client.request('/400')).rejects.toBeInstanceOf(ValidationError);
    await expect(client.request('/401')).rejects.toBeInstanceOf(AuthenticationError);
    await expect(client.request('/403')).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(client.request('/404')).rejects.toBeInstanceOf(NotFoundError);
    await expect(client.request('/409')).rejects.toBeInstanceOf(ConflictError);
    await expect(client.request('/500')).rejects.toBeInstanceOf(ApiError);
  });
});
