'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AttachmentIcon } from '@moonwitness/ui/icons';
import { Button } from '@moonwitness/ui/components/button';
import { Checkbox } from '@moonwitness/ui/components/checkbox';
import { Input } from '@moonwitness/ui/components/input';
import { Textarea } from '@moonwitness/ui/components/textarea';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { client } from '@/lib/client';
import { scopedQueryKey } from '@/lib/query-scope';
import { MAX_ATTACHMENT_BYTES } from '@moonwitness/types';

type StatusAccount = {
  status: string;
  permissions?: { send: boolean };
};

type WhatsAppStatusItem = {
  id: number;
  status_type: 'text' | 'image' | 'video';
  content: string | null;
  media_file_name: string | null;
  allow_reshare: boolean;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'unknown';
  attempt_count: number;
  last_error: string | null;
  published_at: string | null;
  create_date: string;
};

const statusLabel: Record<WhatsAppStatusItem['status'], string> = {
  queued: 'Queued',
  sending: 'Publishing',
  sent: 'Published',
  failed: 'Failed',
  unknown: 'Needs verification',
};

function StatusMediaPreview({ file }: { file: File | null }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      url =
        file && (file.type.startsWith('image/') || file.type.startsWith('video/'))
          ? URL.createObjectURL(file)
          : null;
      setPreviewUrl(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);

  if (!file || !previewUrl) return null;
  return file.type.startsWith('image/') ? (
    <img
      src={previewUrl}
      alt="WhatsApp Status image preview"
      className="mt-3 max-h-80 max-w-full"
    />
  ) : (
    <video src={previewUrl} controls className="mt-3 max-h-80 max-w-full" />
  );
}

export function WhatsAppStatusPage() {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [allowReshare, setAllowReshare] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const accountQuery = useQuery({
    queryKey: scopedQueryKey(['whatsapp', 'account']),
    queryFn: async () => (await client.request<{ data: StatusAccount }>('/whatsapp/account')).data,
    refetchInterval: 5_000,
  });
  const statusesQuery = useQuery({
    queryKey: scopedQueryKey(['whatsapp', 'statuses']),
    queryFn: async () =>
      (await client.request<{ data: WhatsAppStatusItem[] }>('/whatsapp/statuses')).data,
    refetchInterval: 3_000,
  });
  const account = accountQuery.data;
  const canSend = account?.permissions?.send === true;
  const connected = account?.status === 'connected';
  const codepoints = [...content].length;

  const publish = async (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    const text = content.trim();
    if (!text && !file) {
      setLocalError('Add text or choose an image or video.');
      return;
    }
    if (codepoints > 700) {
      setLocalError('Status text must be 700 characters or fewer.');
      return;
    }
    if (file && file.size > MAX_ATTACHMENT_BYTES) {
      setLocalError('Media must be 10 MiB or smaller.');
      return;
    }
    if (
      file &&
      ![
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'video/mp4',
        'video/quicktime',
        'video/webm',
      ].includes(file.type)
    ) {
      setLocalError('Choose a supported image or video file.');
      return;
    }
    const confirmed = window.confirm('Publish this WhatsApp Status now?');
    if (!confirmed) return;

    setPublishing(true);
    try {
      const selectedFile = file;
      const body = selectedFile ? new FormData() : { content: text, allow_reshare: allowReshare };
      if (body instanceof FormData && selectedFile) {
        body.set('content', text);
        body.set('allow_reshare', String(allowReshare));
        body.set('media', selectedFile, selectedFile.name);
      }
      await client.request('/whatsapp/statuses', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body,
      });
      setContent('');
      setFile(null);
      setAllowReshare(false);
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp', 'statuses']) });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Status could not be queued.');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <main className="space-y-5 p-4 md:p-6">
      <Breadcrumbs items={[{ label: 'WhatsApp', to: '/board/whatsapp' }, { label: 'Status' }]} />
      <header className="flex flex-wrap items-center justify-between gap-3 border-2 border-ink bg-paper p-5 shadow-[4px_4px_0_0_var(--ink)]">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">WhatsApp</p>
          <h1 className="font-display text-3xl uppercase">Publish a Status</h1>
          <p className="mt-1 text-sm">
            Create a text, image, or video Status for your connected account.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/board/whatsapp">Back to inbox</Link>
        </Button>
      </header>

      {!connected && (
        <section role="status" className="border-2 border-ink bg-paper p-4">
          Connect the company WhatsApp account from the inbox before publishing a Status.
        </section>
      )}
      {accountQuery.isError && (
        <section role="alert" className="border-2 border-red-700 bg-paper p-4 text-red-800">
          WhatsApp account status could not be loaded. Refresh this page and try again.
        </section>
      )}

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
        <form
          onSubmit={(event) => void publish(event)}
          className="space-y-4 border-2 border-ink bg-paper p-5 shadow-[4px_4px_0_0_var(--ink)]"
        >
          <label className="block font-display text-sm uppercase" htmlFor="whatsapp-status-text">
            Text or caption
          </label>
          <Textarea
            id="whatsapp-status-text"
            aria-label="Status text or caption"
            maxLength={1400}
            rows={5}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Write a Status or add a caption…"
          />
          <p className="text-right text-xs text-ink-faint" aria-live="polite">
            {codepoints}/700 characters
          </p>
          <label className="block font-display text-sm uppercase" htmlFor="whatsapp-status-media">
            Image or video
          </label>
          <Input
            id="whatsapp-status-media"
            aria-label="Choose Status image or video"
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-ink-faint">
            One image or video, up to 10 MiB. Media is scanned before it is queued.
          </p>
          {file && (
            <div className="border border-ink p-3 text-sm">
              <div className="flex items-center gap-2">
                <AttachmentIcon className="size-4" />
                <span>{file.name}</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => setFile(null)}>
                  Remove
                </Button>
              </div>
              <StatusMediaPreview file={file} />
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allowReshare}
              onChange={(event) => setAllowReshare(event.target.checked)}
            />
            Allow resharing this Status
          </label>
          {localError && (
            <p role="alert" className="text-sm text-red-800">
              {localError}
            </p>
          )}
          {!canSend && account && (
            <p role="status" className="text-sm text-ink-faint">
              You do not have permission to publish a Status.
            </p>
          )}
          <Button type="submit" disabled={!canSend || !connected || publishing}>
            {publishing ? 'Queueing…' : 'Publish Status'}
          </Button>
        </form>

        <section
          aria-labelledby="whatsapp-status-history"
          className="border-2 border-ink bg-paper p-5 shadow-[4px_4px_0_0_var(--ink)]"
        >
          <h2 id="whatsapp-status-history" className="font-display text-xl uppercase">
            Recent Statuses
          </h2>
          {statusesQuery.isLoading ? <p className="mt-3 text-sm">Loading Status history…</p> : null}
          {statusesQuery.isError ? (
            <p role="alert" className="mt-3 text-sm text-red-800">
              Status history could not be loaded.
            </p>
          ) : null}
          {statusesQuery.data?.length === 0 ? (
            <p className="mt-3 text-sm text-ink-faint">No Statuses have been queued yet.</p>
          ) : null}
          <ul className="mt-3 divide-y divide-ink/20">
            {(statusesQuery.data ?? []).map((item) => (
              <li key={item.id} className="space-y-1 py-3">
                <div className="flex items-center justify-between gap-3">
                  <strong className="capitalize">
                    {item.status_type} · {statusLabel[item.status]}
                  </strong>
                  <time
                    className="text-xs text-ink-faint"
                    dateTime={item.published_at ?? item.create_date}
                  >
                    {new Date(item.published_at ?? item.create_date).toLocaleString()}
                  </time>
                </div>
                {item.content && <p className="whitespace-pre-wrap text-sm">{item.content}</p>}
                {item.media_file_name && (
                  <p className="text-sm text-ink-faint">{item.media_file_name}</p>
                )}
                {item.status === 'failed' && item.last_error && (
                  <p className="text-sm text-red-800">{item.last_error}</p>
                )}
                {item.status === 'unknown' && (
                  <p className="text-sm text-amber-800">
                    Check WhatsApp before trying again to avoid duplicate publication.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      </section>
    </main>
  );
}
