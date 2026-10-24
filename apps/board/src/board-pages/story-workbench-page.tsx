'use client';

import { Textarea } from '@moonwitness/ui/components/textarea';
import { SelectField } from '@moonwitness/ui/components/select-field';
import { Input } from '@moonwitness/ui/components/input';
import Image from 'next/image';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KnowledgeIcon } from '@moonwitness/ui/icons/knowledge';
import { SaveIcon } from '@moonwitness/ui/icons/save';
import { WarningIcon } from '@moonwitness/ui/icons/warning';
import {
  NotFoundError,
  type StoryPageDocument,
  type StoryVersionDocument,
} from '@moonwitness/client';
import { useAuth } from '@/hooks/use-auth-context';
import { client } from '@/lib/client';
import { Button } from '@moonwitness/ui/components/button';
import { Panel } from '@moonwitness/ui/components/panel';
import { SectionRibbon } from '@moonwitness/ui/components/section-ribbon';

const storyId = 'mw:story:editorial-sample';
const initialPage: StoryPageDocument = {
  page_id: 'mw:story-page:editorial-sample-1',
  page_order: 1,
  original_text: '',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not save this story revision.';
}

export function StoryWorkbenchPage() {
  const { user } = useAuth();
  const [draft, setDraft] = useState<string | null>(null);
  const [pagesDraft, setPagesDraft] = useState<StoryPageDocument[] | null>(null);
  const [selectedPageId, setSelectedPageId] = useState(initialPage.page_id);
  const [revisionInput, setRevisionInput] = useState('');
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const storyQuery = useQuery({
    queryKey: ['story-workbench', client.getCompanyId(), storyId],
    queryFn: () => client.getStoryVersion(storyId),
    enabled:
      (user?.role === 'user' || user?.role === 'superadmin') && Boolean(client.getCompanyId()),
    retry: false,
  });
  const current = storyQuery.data;
  const storyIsMissing = storyQuery.error instanceof NotFoundError;
  const historyQuery = useQuery({
    queryKey: ['story-workbench-version', client.getCompanyId(), storyId, selectedVersion],
    queryFn: () => client.getStoryVersion(storyId, selectedVersion!),
    enabled: selectedVersion !== null && selectedVersion < (current?.version ?? 0),
    retry: false,
  });

  if (user?.role !== 'user' && user?.role !== 'superadmin') {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="font-display text-3xl">Story workbench</h1>
        <p className="mt-4">A tenant user or superadmin role is required.</p>
      </main>
    );
  }

  const viewingHistory = selectedVersion !== null;
  const displayed = viewingHistory ? historyQuery.data : current;
  const pages = viewingHistory
    ? (displayed?.story.pages ?? [])
    : (pagesDraft ?? current?.story.pages ?? [initialPage]);
  const selectedPage =
    pages.find((page) => page.page_id === selectedPageId) ?? pages[0] ?? initialPage;
  const value = viewingHistory ? selectedPage.original_text : (draft ?? selectedPage.original_text);
  const nextVersion = (current?.version ?? 0) + 1;
  const canEdit = !viewingHistory && !saving && !storyQuery.isLoading;
  const canSave = canEdit && (!storyQuery.isError || storyIsMissing);

  function loadRevision() {
    const version = Number(revisionInput);
    if (!Number.isSafeInteger(version) || version < 1 || version >= (current?.version ?? 0)) return;
    setSelectedVersion(version);
  }

  function viewLatestRevision() {
    setSelectedVersion(null);
    setSelectedPageId(current?.story.pages[0]?.page_id ?? initialPage.page_id);
  }

  async function saveRevision() {
    setSaving(true);
    setError('');
    setNotice('');
    const story: StoryVersionDocument = {
      schema_version: 1,
      story_id: storyId,
      version: nextVersion,
      title: current?.story.title ?? 'Editorial sample',
      visibility: 'INTERNAL',
      pages: pages.map((page, index) => ({
        ...page,
        page_order: index + 1,
        original_text: page.page_id === selectedPage.page_id ? value : page.original_text,
      })),
    };
    try {
      const saved = await client.storeStoryVersion(story);
      setDraft(null);
      setPagesDraft(null);
      setSelectedPageId(saved.story.pages[0]?.page_id ?? initialPage.page_id);
      setNotice(`Saved immutable revision ${saved.version} (${saved.digest.slice(0, 12)}…).`);
      await storyQuery.refetch();
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  function addPage() {
    const pageId = `mw:story-page:${crypto.randomUUID()}`;
    const nextPages = [
      ...pages,
      { page_id: pageId, page_order: pages.length + 1, original_text: '' },
    ];
    setPagesDraft(nextPages);
    setSelectedPageId(pageId);
    setDraft(null);
  }

  function removeSelectedPage() {
    if (pages.length <= 1) return;
    const nextPages = pages
      .filter((page) => page.page_id !== selectedPage.page_id)
      .map((page, index) => ({ ...page, page_order: index + 1 }));
    setPagesDraft(nextPages);
    setSelectedPageId(nextPages[0]!.page_id);
    setDraft(null);
  }

  function moveSelectedPage(direction: -1 | 1) {
    const index = pages.findIndex((page) => page.page_id === selectedPage.page_id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= pages.length) return;
    const nextPages = [...pages];
    [nextPages[index], nextPages[nextIndex]] = [nextPages[nextIndex]!, nextPages[index]!];
    setPagesDraft(nextPages.map((page, pageIndex) => ({ ...page, page_order: pageIndex + 1 })));
  }

  return (
    <main className="mx-auto w-full max-w-[100rem] space-y-6 p-4 sm:p-6 xl:p-8">
      <header className="dashboard-masthead">
        <Image
          src="/illustrations/story-workbench-masthead.webp"
          alt=""
          fill
          priority
          sizes="(max-width: 1024px) 100vw, calc(100vw - 16rem)"
          className="dashboard-masthead-art"
        />
        <div className="dashboard-masthead-shade" aria-hidden="true" />
        <div className="dashboard-masthead-copy">
          <div className="dashboard-masthead-kicker">
            <KnowledgeIcon aria-hidden="true" className="size-4" />
            MoonWitness / Internal editorial
          </div>
          <h1 className="dashboard-masthead-title">Story workbench</h1>
          <p className="dashboard-masthead-subtitle">
            Edit and arrange the pages of an internal story. Saving appends an immutable revision;
            previous text remains available by version. This workbench does not publish content or
            upload media.
          </p>
        </div>
      </header>
      <div className="story-workbench-grid">
        <aside className="story-workbench-aside" aria-label="Page navigator">
          <Panel
            title="Page navigator"
            description={`${pages.length} page${pages.length === 1 ? '' : 's'} in this story`}
            surface="paper"
            frame="torn"
            density="compact"
          >
            <div className="space-y-3">
              <label className="block font-mono text-xs uppercase tracking-wider text-ink-faint">
                <span className="mb-1 block">Select page</span>
                <SelectField
                  aria-label="Story page"
                  value={selectedPage.page_id}
                  onChange={(event) => {
                    setSelectedPageId(event.currentTarget.value);
                    if (!viewingHistory) setDraft(null);
                  }}
                  className="w-full border-2 border-ink/30 bg-paper p-2 text-sm text-ink"
                >
                  {pages.map((page, index) => (
                    <option key={page.page_id} value={page.page_id}>
                      Page {index + 1}
                    </option>
                  ))}
                </SelectField>
              </label>
              <p role="status" className="font-mono text-xs uppercase text-ink-faint">
                Page {selectedPage.page_order} of {pages.length}
              </p>
              <Button
                type="button"
                className="w-full"
                onClick={addPage}
                disabled={!canEdit || pages.length >= 100}
              >
                Add page
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => moveSelectedPage(-1)}
                  disabled={!canEdit || pages[0]?.page_id === selectedPage.page_id}
                >
                  Move up
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => moveSelectedPage(1)}
                  disabled={!canEdit || pages.at(-1)?.page_id === selectedPage.page_id}
                >
                  Move down
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={removeSelectedPage}
                disabled={!canEdit || pages.length <= 1}
              >
                Remove page
              </Button>
              <p className="text-xs text-ink-faint">A story can contain up to 100 pages.</p>
            </div>
          </Panel>
        </aside>

        <div className="story-workbench-center">
          <section className="ink-panel space-y-4 bg-card p-5 sm:p-6">
            <SectionRibbon
              id="story-editor-title"
              title="Story editor"
              number="01"
              accent="magenta"
              surface="paper"
            />
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-xl uppercase">Editorial sample</h2>
                <p className="mt-1 break-all font-mono text-xs text-ink-faint">{storyId}</p>
              </div>
              <p className="font-mono text-xs uppercase text-ink-faint">
                {current ? `Current v${current.version}` : 'New story'} · next v{nextVersion}
              </p>
            </div>
            <div
              role="note"
              className="flex gap-3 border-2 border-amber-700/50 bg-amber-100/50 p-3 text-sm text-ink dark:bg-amber-950/20"
            >
              <WarningIcon aria-hidden="true" className="size-5 shrink-0" />
              <p>
                INTERNAL only. Keep this example synthetic. Public rendering, story publishing, and
                media uploads are unavailable. If a no-face style is requested, record it as
                editorial guidance, not as epistemic data.
              </p>
            </div>
            {storyQuery.isLoading && <p role="status">Loading latest revision…</p>}
            {storyQuery.isError && (
              <div
                role="status"
                className="flex flex-wrap items-center gap-3 text-sm text-ink-soft"
              >
                <p>
                  {storyIsMissing
                    ? 'No saved sample is available in this company yet. Saving creates its first revision.'
                    : 'Could not confirm the saved story state. Your draft is kept; retry before saving.'}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void storyQuery.refetch()}
                  disabled={storyQuery.isFetching}
                >
                  {storyQuery.isFetching ? 'Retrying…' : 'Retry loading story'}
                </Button>
              </div>
            )}
            {viewingHistory && historyQuery.isLoading && <p role="status">Loading revision…</p>}
            {viewingHistory && historyQuery.isError && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 text-sm text-destructive"
              >
                <p>Could not load that revision. The latest revision remains unchanged.</p>
                <Button type="button" variant="outline" onClick={() => void historyQuery.refetch()}>
                  Retry loading revision
                </Button>
              </div>
            )}
            <label
              htmlFor="story-page-text"
              className="block font-mono text-xs uppercase tracking-wider text-ink-faint"
            >
              Page text · exact whitespace is preserved
            </label>
            <Textarea
              id="story-page-text"
              value={value}
              onChange={(event) => {
                const nextText = event.currentTarget.value;
                setDraft(nextText);
                setPagesDraft(
                  pages.map((page) =>
                    page.page_id === selectedPage.page_id
                      ? { ...page, original_text: nextText }
                      : page
                  )
                );
              }}
              rows={12}
              maxLength={1000000}
              spellCheck={false}
              readOnly={!canEdit || historyQuery.isLoading || pages.length === 0}
              className="min-h-64 w-full resize-y border-2 border-ink/30 bg-paper p-4 font-mono text-sm leading-relaxed text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime"
              aria-describedby="story-page-help"
            />
            <p id="story-page-help" className="text-xs text-ink-faint">
              The API stores the editor value without trimming. Browsers normalize textarea line
              endings to LF; other whitespace is preserved.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={() => void saveRevision()} disabled={!canSave}>
                <SaveIcon aria-hidden="true" className="mr-2 size-4" />
                {saving ? 'Saving…' : `Save revision ${nextVersion}`}
              </Button>
              {notice && (
                <p role="status" className="text-sm">
                  {notice}
                </p>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          </section>

          <section className="space-y-3" aria-labelledby="story-page-preview-title">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-ink-faint">
                Private draft · not published
              </p>
              <SectionRibbon
                id="story-page-preview-title"
                title="Page composition preview"
                number="02"
                accent="cyan"
                surface="paper"
              />
            </div>
            <article
              aria-label={`Private preview of page ${selectedPage.page_order}`}
              className="mx-auto flex aspect-[3/4] min-h-[28rem] w-full max-w-[32rem] scroll-mt-16 flex-col border-4 border-ink bg-paper p-6 text-ink shadow-[8px_8px_0_var(--color-ink)] sm:p-10"
            >
              <header className="flex items-start justify-between gap-4 border-b-2 border-ink/25 pb-4">
                <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-ink-faint">
                  Editorial sample
                </p>
                <p className="font-mono text-xs uppercase text-ink-faint">
                  {selectedPage.page_order} / {pages.length}
                </p>
              </header>
              <div className="flex flex-1 flex-col justify-center py-8">
                <h3 className="font-display text-3xl uppercase leading-tight sm:text-5xl">
                  {current?.story.title ?? 'Editorial sample'}
                </h3>
                <p className="mt-6 whitespace-pre-wrap break-words text-base leading-relaxed sm:text-lg">
                  {value || 'Add synthetic page text to preview this composition.'}
                </p>
              </div>
              <footer className="border-t-2 border-ink/25 pt-3 font-mono text-[0.65rem] uppercase tracking-[0.16em] text-ink-faint">
                Internal review only · no public or media export
              </footer>
            </article>
          </section>
        </div>

        <aside
          className="story-workbench-aside story-workbench-inspector"
          aria-label="Revision inspector"
        >
          <Panel
            title="Revision inspector"
            description="Version history and integrity"
            surface="paper"
            frame="torn"
            density="compact"
          >
            {current ? (
              <div className="space-y-3">
                <label className="block font-mono text-xs uppercase tracking-wider text-ink-faint">
                  <span className="mb-1 block">Inspect previous revision</span>
                  <Input
                    aria-label="Previous revision number"
                    type="number"
                    min={1}
                    max={current.version - 1}
                    value={revisionInput}
                    onChange={(event) => setRevisionInput(event.currentTarget.value)}
                    disabled={current.version <= 1}
                    className="w-full border-2 border-ink/30 bg-paper p-2 text-sm text-ink"
                  />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={loadRevision}
                  disabled={!revisionInput || current.version <= 1}
                >
                  Load revision
                </Button>
                {viewingHistory && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={viewLatestRevision}
                  >
                    Return to latest revision
                  </Button>
                )}
                <p role="status" className="text-sm text-ink-soft">
                  {viewingHistory
                    ? `Viewing immutable revision ${selectedVersion}; editing is disabled.`
                    : `Latest revision ${current.version} is open for editing.`}
                </p>
              </div>
            ) : (
              <p role="status" className="text-sm text-ink-soft">
                The first saved revision will appear here.
              </p>
            )}
            {viewingHistory && displayed && (
              <p
                role="note"
                className="mt-4 border-l-4 border-amber-700/50 bg-amber-100/50 p-3 text-sm text-ink dark:bg-amber-950/20"
              >
                Historical revisions are immutable. Return to the latest revision to make and save
                edits.
              </p>
            )}
            {displayed && (
              <section
                className="mt-5 border-t-2 border-ink/20 pt-4"
                aria-labelledby="story-integrity-title"
              >
                <SectionRibbon
                  id="story-integrity-title"
                  title="Revision integrity"
                  number="03"
                  accent="yellow"
                  surface="paper"
                  headingLevel={3}
                />
                <dl className="mt-3 grid gap-2 font-mono text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
                  <dt className="text-ink-faint">Version</dt>
                  <dd>{displayed.version}</dd>
                  <dt className="text-ink-faint">SHA-256</dt>
                  <dd className="break-all">{displayed.digest}</dd>
                  <dt className="text-ink-faint">Visibility</dt>
                  <dd>{displayed.visibility}</dd>
                </dl>
              </section>
            )}
            <p role="note" className="mt-5 border-t-2 border-ink/20 pt-4 text-sm text-ink-soft">
              Internal only. This workspace does not publish stories or upload media.
            </p>
          </Panel>
        </aside>
      </div>
    </main>
  );
}
