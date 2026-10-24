'use client';

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpenIcon, RelationIcon, SearchIcon } from '@moonwitness/ui/icons';
import type { CorpusPassage, ResearchGraphSearchResult, SourceCitation } from '@moonwitness/client';
import { useAuth } from '@/hooks/use-auth-context';
import { client } from '@/lib/client';
import { scopedQueryKey } from '@/lib/query-scope';
import { canReadResearch } from '@/lib/research-access';
import { cn } from '@/lib/utils';
import { Button } from '@moonwitness/ui/components/button';
import { Input } from '@moonwitness/ui/components/input';
import { Skeleton } from '@moonwitness/ui/components/skeleton';

const sources = [
  {
    id: 'mw:source:tanzil-quran-text',
    label: 'Qur’an · Tanzil',
  },
  {
    id: 'mw:source:ebible-webp-protestant',
    label: 'World English Bible · WEBP',
  },
] as const;

type SourceId = (typeof sources)[number]['id'];

function isPinnedSourceId(value: string): value is SourceId {
  return sources.some((source) => source.id === value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

function SourceCard({ citation, passage }: { citation: SourceCitation; passage: CorpusPassage }) {
  return (
    <article className="ink-panel min-w-0 space-y-4 bg-card p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <BookOpenIcon
          aria-hidden="true"
          className="mt-1 size-5 shrink-0 text-lime-700 dark:text-lime"
        />
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
            {passage.editionId}
          </p>
          <h2 className="mt-1 break-words font-display text-xl uppercase">{passage.locator}</h2>
        </div>
      </div>
      <blockquote className="border-l-4 border-lime-600 pl-4 text-lg leading-relaxed text-ink">
        {passage.text}
      </blockquote>
      <p className="text-sm leading-relaxed text-ink-soft">{citation.citation}</p>
      <dl className="grid gap-2 border-t border-ink/15 pt-3 font-mono text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-ink-faint">Source</dt>
        <dd className="break-all text-ink">{passage.sourceId}</dd>
        <dt className="text-ink-faint">SHA-256</dt>
        <dd className="break-all text-ink">{passage.sha256}</dd>
      </dl>
    </article>
  );
}

export function KnowledgePage() {
  const { user } = useAuth();
  const [sourceId, setSourceId] = useState<SourceId>(sources[0].id);
  const [requestedLocator, setRequestedLocator] = useState<string | null>(null);
  const [graphSearchInput, setGraphSearchInput] = useState('');
  const [graphSearchTerm, setGraphSearchTerm] = useState('');
  const [relationInput, setRelationInput] = useState('');
  const [relationId, setRelationId] = useState('');
  const activeCompanyId = client.getCompanyId();
  const hasResearchAccess = canReadResearch(user?.role, activeCompanyId);

  const citationQuery = useQuery({
    queryKey: scopedQueryKey(['knowledge-source', sourceId]),
    queryFn: () => client.getSourceCitation(sourceId),
    enabled: hasResearchAccess,
  });
  const citation = citationQuery.data;
  let locator: string | undefined;
  if (citation) {
    if (requestedLocator === null) locator = citation.availablePassages[0];
    else if (citation.availablePassages.includes(requestedLocator)) locator = requestedLocator;
  }
  const requestedPassageUnavailable = Boolean(
    citation && requestedLocator && !citation.availablePassages.includes(requestedLocator)
  );
  const passageQuery = useQuery({
    queryKey: scopedQueryKey(['knowledge-passage', sourceId, citation?.editionId, locator]),
    queryFn: () => {
      if (!citation || !locator) throw new Error('The selected source has no available passage.');
      return client.getCorpusPassage(citation.editionId, locator);
    },
    enabled: hasResearchAccess && Boolean(citation && locator),
  });
  const explanationQuery = useQuery({
    queryKey: scopedQueryKey(['knowledge-relation', relationId]),
    queryFn: () => client.getResearchRelationExplanation(relationId),
    enabled: hasResearchAccess && relationId.length > 0,
  });
  const graphSearchQuery = useQuery({
    queryKey: scopedQueryKey(['knowledge-graph-search', graphSearchTerm]),
    queryFn: () => client.searchResearchGraph(graphSearchTerm),
    enabled: hasResearchAccess && graphSearchTerm.length >= 2,
  });

  const submitRelation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRelationId(relationInput.trim());
  };

  const submitGraphSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setGraphSearchTerm(graphSearchInput.trim());
  };

  const selectSourcePassage = (id: SourceId, selectedLocator: string) => {
    setSourceId(id);
    setRequestedLocator(selectedLocator);
  };

  if (!hasResearchAccess) {
    return (
      <section className="ink-panel mx-auto max-w-2xl bg-card p-6 sm:p-10" role="alert">
        <h1 className="font-display text-2xl uppercase">Knowledge explorer unavailable</h1>
        <p className="mt-3 text-ink-soft">
          Your current role cannot access research records without an active company context. The
          API also verifies active company membership.
        </p>
      </section>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-7">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
          Read-only · verified local sources
        </p>
        <h1 className="font-display text-3xl uppercase sm:text-4xl">Knowledge explorer</h1>
        <p className="max-w-3xl text-ink-soft">
          Browse the pinned passage samples and inspect a relation from the active, verified
          research release. This view never edits canonical records or fetches source material from
          the web.
        </p>
      </header>

      <section aria-labelledby="source-heading" className="space-y-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-ink-faint">Sources</p>
          <h2 id="source-heading" className="mt-1 font-display text-2xl uppercase">
            Pinned passages
          </h2>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Choose source">
          {sources.map((source) => (
            <Button
              key={source.id}
              type="button"
              variant={sourceId === source.id ? 'default' : 'outline'}
              aria-pressed={sourceId === source.id}
              onClick={() => {
                setSourceId(source.id);
                setRequestedLocator(null);
              }}
            >
              {source.label}
            </Button>
          ))}
        </div>
        {citationQuery.isError && (
          <p className="text-sm text-destructive" role="alert">
            Source metadata is unavailable: {errorMessage(citationQuery.error)}
          </p>
        )}
        {passageQuery.isError && !requestedPassageUnavailable && (
          <p className="text-sm text-destructive" role="alert">
            The exact passage could not be verified: {errorMessage(passageQuery.error)}
          </p>
        )}
        {requestedPassageUnavailable && (
          <p className="text-sm text-destructive" role="alert">
            The selected evidence passage is not available in this pinned source edition.
          </p>
        )}
        {(citationQuery.isLoading || passageQuery.isLoading) && (
          <Skeleton className="h-64 w-full bg-ink/10" />
        )}
        {citation && passageQuery.data && (
          <SourceCard citation={citation} passage={passageQuery.data} />
        )}
      </section>

      <section aria-labelledby="graph-search-heading" className="space-y-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-ink-faint">
            Active internal release
          </p>
          <h2 id="graph-search-heading" className="mt-1 font-display text-2xl uppercase">
            Find graph records
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-ink-soft">
            Search readable assertions, evidence, and relations by text or ID. Restricted records,
            evidence whose assertion is hidden, and relations with hidden endpoints are omitted.
          </p>
        </div>
        <form className="flex flex-col gap-3 sm:flex-row" onSubmit={submitGraphSearch}>
          <label className="sr-only" htmlFor="research-graph-query">
            Search graph records
          </label>
          <Input
            id="research-graph-query"
            value={graphSearchInput}
            onChange={(event) => setGraphSearchInput(event.target.value)}
            maxLength={120}
            placeholder="Claim, assertion, relation or endpoint ID, predicate, source, or passage…"
            className="min-w-0 flex-1 border-2 border-ink bg-paper px-3 py-2 text-ink outline-none focus-visible:ring-2 focus-visible:ring-lime-700"
          />
          <Button type="submit" disabled={graphSearchInput.trim().length < 2}>
            <SearchIcon aria-hidden="true" className="size-4" />
            Search graph
          </Button>
        </form>
        {graphSearchQuery.isLoading && <Skeleton className="h-36 w-full bg-ink/10" />}
        {graphSearchQuery.isError && (
          <p className="text-sm text-destructive" role="alert">
            Graph search is unavailable: {errorMessage(graphSearchQuery.error)}
          </p>
        )}
        {graphSearchQuery.data && (
          <GraphSearchResults
            query={graphSearchTerm}
            results={graphSearchQuery.data.results}
            truncated={graphSearchQuery.data.truncated}
            releaseDigest={graphSearchQuery.data.releaseDigest}
            onOpenPassage={selectSourcePassage}
            onFindAssertion={(id) => {
              setGraphSearchInput(id);
              setGraphSearchTerm(id);
            }}
            onExplainRelation={(id) => {
              setRelationInput(id);
              setRelationId(id);
            }}
          />
        )}
      </section>

      <section aria-labelledby="relation-heading" className="space-y-4">
        <div className="flex items-start gap-3">
          <RelationIcon aria-hidden="true" className="mt-1 size-5 text-lime-700 dark:text-lime" />
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-ink-faint">
              Research graph
            </p>
            <h2 id="relation-heading" className="mt-1 font-display text-2xl uppercase">
              Explain a relation
            </h2>
          </div>
        </div>
        <form className="flex flex-col gap-3 sm:flex-row" onSubmit={submitRelation}>
          <label className="sr-only" htmlFor="relation-id">
            Research relation ID
          </label>
          <Input
            id="relation-id"
            value={relationInput}
            onChange={(event) => setRelationInput(event.target.value)}
            maxLength={255}
            placeholder="mw:relation:…"
            className="min-w-0 flex-1 border-2 border-ink bg-paper px-3 py-2 text-ink outline-none focus-visible:ring-2 focus-visible:ring-lime-700"
          />
          <Button type="submit" disabled={!relationInput.trim()}>
            <SearchIcon aria-hidden="true" className="size-4" />
            Explain
          </Button>
        </form>
        {explanationQuery.isLoading && <Skeleton className="h-48 w-full bg-ink/10" />}
        {explanationQuery.isError && (
          <p className="text-sm text-destructive" role="alert">
            Research relation is unavailable: {errorMessage(explanationQuery.error)}
          </p>
        )}
        {explanationQuery.data && (
          <RelationCard
            digest={explanationQuery.data.releaseDigest}
            explanation={explanationQuery.data.explanation}
            onSelectSource={selectSourcePassage}
            onSelectRelation={(id) => {
              setRelationInput(id);
              setRelationId(id);
            }}
          />
        )}
      </section>
    </div>
  );
}

function GraphSearchResults({
  query,
  results,
  truncated,
  releaseDigest,
  onOpenPassage,
  onFindAssertion,
  onExplainRelation,
}: {
  query: string;
  results: ResearchGraphSearchResult[];
  truncated: boolean;
  releaseDigest: string;
  onOpenPassage: (id: SourceId, locator: string) => void;
  onFindAssertion: (id: string) => void;
  onExplainRelation: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="break-all font-mono text-[11px] text-ink-faint">
        Active release SHA-256: {releaseDigest}
      </p>
      <p role="status" className="text-sm text-ink-faint">
        {results.length === 0
          ? `No readable graph records matched “${query}”.`
          : `Search for “${query}” found ${results.length} readable graph result${results.length === 1 ? '' : 's'}.${truncated ? ' Showing the first matches; refine your query to find a specific record.' : ''}`}
      </p>
      {results.length === 0 ? (
        <p className="text-sm text-ink-faint">
          Try another claim, relation ID, source, or passage.
        </p>
      ) : (
        <ul aria-label="Research graph search results" className="grid gap-3">
          {results.map((result) => (
            <li key={`${result.kind}:${result.id}`}>
              <article className="ink-panel min-w-0 space-y-2 bg-card p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-faint">
                    {result.kind}
                  </span>
                  <span className="break-all font-mono text-xs text-ink-faint">{result.id}</span>
                </div>
                <p className="break-words font-medium text-ink">{result.title}</p>
                <p className="break-words text-sm text-ink-soft">{result.summary}</p>
                {result.kind === 'evidence' ? (
                  <Button
                    type="button"
                    className="text-left text-sm font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-700"
                    onClick={() => onOpenPassage(result.sourceId, result.locator)}
                  >
                    Open pinned passage {result.locator}
                  </Button>
                ) : result.kind === 'relation' ? (
                  <Button
                    type="button"
                    className="text-left text-sm font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-700"
                    onClick={() => onExplainRelation(result.id)}
                  >
                    Explain relation
                  </Button>
                ) : (
                  <Button
                    type="button"
                    className="text-left text-sm font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-700"
                    onClick={() => onFindAssertion(result.id)}
                  >
                    Find linked evidence
                  </Button>
                )}
              </article>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RelationCard({
  digest,
  explanation,
  onSelectSource,
  onSelectRelation,
}: {
  digest: string;
  explanation: Awaited<ReturnType<typeof client.getResearchRelationExplanation>>['explanation'];
  onSelectSource: (id: SourceId, locator: string) => void;
  onSelectRelation: (id: string) => void;
}) {
  return (
    <article className="ink-panel space-y-5 bg-card p-5 sm:p-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            Predicate
          </p>
          <p className="mt-1 break-words font-display text-xl uppercase">{explanation.predicate}</p>
        </div>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            Review / epistemic
          </p>
          <p className="mt-1 break-words text-sm text-ink">
            {explanation.review_status} · {explanation.epistemic_status}
          </p>
        </div>
      </div>
      <dl className="grid gap-2 border-y border-ink/15 py-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-ink-faint">Subject</dt>
        <dd className="break-all">{explanation.subject_id}</dd>
        <dt className="text-ink-faint">Object</dt>
        <dd className="break-all">{explanation.object_id}</dd>
        <dt className="text-ink-faint">Scope</dt>
        <dd className="break-all">
          {explanation.scope.kind}: {explanation.scope.reference_id}
        </dd>
        <dt className="text-ink-faint">Active release SHA-256</dt>
        <dd className="break-all font-mono text-xs">{digest}</dd>
      </dl>
      <div className="grid gap-4 lg:grid-cols-2">
        <EvidenceList
          title="Supporting evidence"
          rows={explanation.supporting_evidence}
          onSelectSource={onSelectSource}
        />
        <EvidenceList
          title="Counterevidence"
          rows={explanation.counterevidence}
          onSelectSource={onSelectSource}
        />
      </div>
      <p className="font-mono text-xs text-ink-faint">
        Interpretation boundary: linked evidence only. This view does not infer causation.
      </p>
      {explanation.alternatives.length > 0 && (
        <div className="space-y-3 border-t border-ink/15 pt-4">
          <h3 className="font-display text-lg uppercase">Alternative hypotheses</h3>
          {explanation.alternatives.map((alternative) => (
            <div key={alternative.relation.id} className="border-l-4 border-ink/20 pl-4">
              <Button
                type="button"
                className="text-left font-medium underline decoration-ink/30 underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-700"
                onClick={() => onSelectRelation(alternative.relation.id)}
              >
                {alternative.relation.predicate}
              </Button>
              <p className="break-all text-sm text-ink-soft">
                {alternative.relation.subject_id} → {alternative.relation.object_id}
              </p>
              <p className="text-xs text-ink-faint">
                {alternative.supporting_evidence.length} supporting ·{' '}
                {alternative.counterevidence.length} counterevidence records
              </p>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function EvidenceList({
  title,
  rows,
  onSelectSource,
}: {
  title: string;
  rows: Awaited<
    ReturnType<typeof client.getResearchRelationExplanation>
  >['explanation']['supporting_evidence'];
  onSelectSource: (id: SourceId, locator: string) => void;
}) {
  return (
    <section className="min-w-0 space-y-2" aria-label={title}>
      <h3 className="font-display text-lg uppercase">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-faint">No linked evidence.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const sourceId = row.source_id;
            return (
              <li key={row.evidence.id} className={cn('border-l-4 border-ink/20 bg-paper p-3')}>
                <p className="text-sm leading-relaxed">{row.excerpt}</p>
                <p className="mt-2 break-words text-xs text-ink-soft">
                  {row.citation} · {row.locator}
                </p>
                <p className="mt-1 break-all font-mono text-[10px] text-ink-faint">
                  {sourceId} · {row.evidence.assertion_id}
                </p>
                {isPinnedSourceId(sourceId) && (
                  <Button
                    type="button"
                    className="mt-2 text-left text-xs font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-700"
                    onClick={() => onSelectSource(sourceId, row.locator)}
                  >
                    Open pinned source passage {row.locator}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
