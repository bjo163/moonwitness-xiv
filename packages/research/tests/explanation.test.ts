import { describe, expect, it } from 'vitest';
import { explainResearchRelation } from '../src/index.js';
import type { ResearchEvidenceReference, ResolvablePassage } from '../src/index.js';
import type {
  ResearchGraphInput,
  ResearchGraphNode,
  ResearchRelation,
  ResearchVisibility,
} from '../src/relation.js';

const quranText =
  'وَبَيْنَهُمَا حِجَابٌۭ ۚ وَعَلَى ٱلْأَعْرَافِ رِجَالٌۭ يَعْرِفُونَ كُلًّۢا بِسِيمَىٰهُمْ ۚ وَنَادَوْا۟ أَصْحَـٰبَ ٱلْجَنَّةِ أَن سَلَـٰمٌ عَلَيْكُمْ ۚ لَمْ يَدْخُلُوهَا وَهُمْ يَطْمَعُونَ';
const quranPassage: ResolvablePassage = {
  source_id: 'mw:source:tanzil-quran-text',
  edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
  locator: 'Q7:46',
  text: quranText,
  content_sha256: '6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760',
  citation:
    'Tanzil Quran Text v1.1 Uthmani, Q7:46, reproduced verbatim under CC BY 3.0; see the local corpus manifest and notice.',
};
const genesisPassage: ResolvablePassage = {
  source_id: 'mw:source:ebible-webp-protestant',
  expression_id: 'mw:expression:webp-protestant',
  edition_id: 'mw:edition:webp-protestant-2020-stable',
  locator: 'Genesis 1:1',
  text: 'In the beginning, God created the heavens and the earth.',
  content_sha256: 'ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1',
  citation: 'World English Bible Protestant, 2020 stable, Genesis 1:1; eBible.org, public domain.',
};

function relation(overrides: Partial<ResearchRelation> = {}): ResearchRelation {
  return {
    id: 'mw:relation:tanzil-edition-witness',
    kind: 'ResearchRelation',
    schema_version: 1,
    lifecycle: 'active',
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-16T00:00:00Z',
    origin_ref: 'synthetic:test:explanation',
    content_revision: 1,
    visibility: 'PUBLIC_APPROVED',
    predicate: 'edition_of',
    subject_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
    object_id: 'mw:expression:tanzil-quran-text-v1.1-uthmani',
    scope: { kind: 'work', reference_id: 'mw:work:quran' },
    supporting_evidence_ids: ['mw:evidence:tanzil-q7-46'],
    counterevidence_ids: [],
    alternative_relation_ids: [],
    epistemic_status: 'supported',
    review_status: 'accepted',
    review_decision_id: 'mw:review-decision:fixture-accepted',
    reviewer_id: 'mw:agent:fixture-reviewer',
    reviewed_at: '2026-10-16T00:00:00Z',
    reviewed_revision: 1,
    ...overrides,
  };
}

function unreviewedRelation(overrides: Partial<ResearchRelation> = {}): ResearchRelation {
  const {
    review_decision_id: _decision,
    reviewer_id: _reviewer,
    reviewed_at: _at,
    reviewed_revision: _revision,
    ...value
  } = relation({
    lifecycle: 'candidate',
    review_status: 'unreviewed',
    ...overrides,
  });
  return value;
}

function quranEvidence(
  direction: 'supporting' | 'counterevidence' = 'supporting'
): ResearchEvidenceReference {
  return {
    id: 'mw:evidence:tanzil-q7-46',
    assertion_id: 'mw:assertion:tanzil-source-metadata',
    direction,
    selector: {
      source_id: 'mw:source:tanzil-quran-text',
      edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locator: 'Q7:46',
      content_sha256: quranPassage.content_sha256,
    },
  };
}

function options(
  evidenceReferences: ResearchEvidenceReference[],
  evidenceVisibility: Map<string, ResearchVisibility> = new Map(
    evidenceReferences.map((entry) => [entry.id, 'PUBLIC_APPROVED'])
  ),
  canRead: (
    record: ResearchRelation | { id: string; visibility: ResearchVisibility }
  ) => boolean = (record) => record.visibility === 'PUBLIC_APPROVED'
) {
  return {
    evidenceReferences,
    evidenceVisibility,
    lookupPassage: async (editionId: string, locator: string) =>
      [quranPassage, genesisPassage].find(
        (passage) => passage.edition_id === editionId && passage.locator === locator
      ) ?? null,
    canRead,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function graph(
  relations: ResearchRelation[],
  evidenceReferences: ResearchEvidenceReference[],
  visibility: Map<string, ResearchVisibility> = new Map()
): ResearchGraphInput {
  const nodeMap = new Map<string, ResearchGraphNode>();
  const add = (
    id: string,
    kind: ResearchGraphNode['kind'],
    identity_class?: ResearchGraphNode['identity_class']
  ) => {
    nodeMap.set(id, {
      id,
      kind,
      visibility: visibility.get(id) ?? 'PUBLIC_APPROVED',
      ...(identity_class === undefined ? {} : { identity_class }),
    });
  };
  add(endpointIds[0]!, 'Edition');
  add(endpointIds[1]!, 'Expression', 'TextualWitness');
  add(endpointIds[2]!, 'Work');
  for (const reference of evidenceReferences) add(reference.assertion_id, 'Assertion');
  for (const candidate of relations) {
    if (candidate.predicate === 'possibly_corresponds_to') {
      add(candidate.subject_id, 'Entity', 'Entity');
      add(candidate.object_id, 'Entity', 'Entity');
    }
    for (const evidenceId of [
      ...candidate.supporting_evidence_ids,
      ...candidate.counterevidence_ids,
    ])
      add(evidenceId, 'Evidence');
    if (candidate.review_decision_id) add(candidate.review_decision_id, 'ReviewDecision');
    if (candidate.reviewer_id) add(candidate.reviewer_id, 'Agent');
  }
  return { nodes: [...nodeMap.values()], relations };
}

const endpointIds = [
  'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
  'mw:expression:tanzil-quran-text-v1.1-uthmani',
  'mw:work:quran',
];

describe('provenance-linked relation explanations', () => {
  it('explains the pinned Q7:46 source relation with exact local provenance', async () => {
    const root = relation();
    const refs = [quranEvidence()];
    const result = await explainResearchRelation(graph([root], refs), root.id, options(refs));
    expect(result).toMatchObject({
      status: 'explained',
      explanation: {
        predicate: 'edition_of',
        supporting_evidence: [
          {
            direction: 'supporting',
            source_id: quranPassage.source_id,
            edition_id: quranPassage.edition_id,
            locator: 'Q7:46',
            content_sha256: quranPassage.content_sha256,
            excerpt: quranText,
          },
        ],
        counterevidence: [],
        alternatives: [],
        interpretation_boundary: 'linked_evidence_only',
      },
    });
    if (result.status === 'explained') {
      expect(result.explanation.supporting_evidence[0]?.citation).toContain('CC BY 3.0');
      expect(result.explanation).not.toHaveProperty('causal_order');
      expect(result.explanation).not.toHaveProperty('narrative');
    }
  });

  it('retains synthetic disputed status, both evidence directions, and alternative hypotheses', async () => {
    const support = quranEvidence();
    const counter = {
      id: 'mw:evidence:synthetic-q7-46-counter',
      assertion_id: 'mw:assertion:synthetic-contested-fixture',
      direction: 'counterevidence',
      selector: { ...support.selector },
    } satisfies ResearchEvidenceReference;
    const contested = unreviewedRelation({
      id: 'mw:relation:synthetic-disputed-fixture',
      predicate: 'possibly_corresponds_to',
      lifecycle: 'candidate',
      epistemic_status: 'disputed',
      review_status: 'disputed',
      supporting_evidence_ids: [support.id],
      counterevidence_ids: [counter.id],
      alternative_relation_ids: [
        'mw:relation:synthetic-alternative-a',
        'mw:relation:synthetic-alternative-b',
      ],
    });
    const alternativeA = unreviewedRelation({
      id: 'mw:relation:synthetic-alternative-a',
      predicate: 'related_to',
      lifecycle: 'candidate',
      review_status: 'unreviewed',
      supporting_evidence_ids: [support.id],
      counterevidence_ids: [],
    });
    const alternativeB = unreviewedRelation({
      ...alternativeA,
      id: 'mw:relation:synthetic-alternative-b',
      epistemic_status: 'insufficient_evidence',
      supporting_evidence_ids: [],
      counterevidence_ids: [counter.id],
    });
    const refs = [support, counter];
    const result = await explainResearchRelation(
      graph([contested, alternativeA, alternativeB], refs),
      contested.id,
      options(refs)
    );
    expect(result).toMatchObject({
      status: 'explained',
      explanation: {
        review_status: 'disputed',
        epistemic_status: 'disputed',
        supporting_evidence: [{ direction: 'supporting', locator: 'Q7:46' }],
        counterevidence: [{ direction: 'counterevidence', locator: 'Q7:46' }],
        alternatives: [
          { relation: { id: alternativeA.id } },
          { relation: { id: alternativeB.id, epistemic_status: 'insufficient_evidence' } },
        ],
      },
    });
  });

  it('fails closed on missing evidence, hash mismatch, hidden endpoints, and hidden alternatives', async () => {
    const base = relation();
    await expect(explainResearchRelation(graph([base], []), base.id, options([]))).resolves.toEqual(
      {
        status: 'not_found',
      }
    );
    const wrongHash = quranEvidence();
    wrongHash.selector.content_sha256 = '0'.repeat(64);
    await expect(
      explainResearchRelation(graph([base], [wrongHash]), base.id, options([wrongHash]))
    ).resolves.toEqual({ status: 'evidence_unavailable' });
    await expect(
      explainResearchRelation(
        graph([base], [quranEvidence()], new Map([[endpointIds[0]!, 'CHILD_SENSITIVE']])),
        base.id,
        options([quranEvidence()], new Map([['mw:evidence:tanzil-q7-46', 'RESTRICTED']]))
      )
    ).resolves.toEqual({ status: 'not_found' });
    await expect(
      explainResearchRelation(
        graph(
          [base],
          [quranEvidence()],
          new Map([['mw:assertion:tanzil-source-metadata', 'RESTRICTED']])
        ),
        base.id,
        options([quranEvidence()])
      )
    ).resolves.toEqual({ status: 'not_found' });
    await expect(
      explainResearchRelation(
        graph(
          [base],
          [quranEvidence()],
          new Map([['mw:assertion:tanzil-source-metadata', 'RESTRICTED']])
        ),
        base.id,
        options(
          [quranEvidence()],
          new Map([['mw:evidence:tanzil-q7-46', 'PUBLIC_APPROVED']]),
          () => true
        )
      )
    ).resolves.toEqual({ status: 'not_found' });
    await expect(
      explainResearchRelation(
        graph([base], [quranEvidence()], new Map([['mw:evidence:tanzil-q7-46', 'RESTRICTED']])),
        base.id,
        options([quranEvidence()])
      )
    ).resolves.toEqual({ status: 'not_found' });
    const withAlternative = relation({
      alternative_relation_ids: ['mw:relation:private-alt'],
      visibility: 'RESTRICTED',
    });
    const privateAlternative = relation({
      id: 'mw:relation:private-alt',
      visibility: 'RESTRICTED',
    });
    await expect(
      explainResearchRelation(
        graph([withAlternative, privateAlternative], [quranEvidence()]),
        withAlternative.id,
        options([quranEvidence()])
      )
    ).resolves.toEqual({ status: 'not_found' });
  });

  it('produces stable evidence ordering for equivalent relation inputs', async () => {
    const evidenceA = quranEvidence();
    const evidenceB = {
      id: 'mw:evidence:tanzil-q7-46-secondary',
      assertion_id: 'mw:assertion:synthetic-fixture',
      direction: 'supporting',
      selector: { ...evidenceA.selector },
    } satisfies ResearchEvidenceReference;
    const value = relation({ supporting_evidence_ids: [evidenceB.id, evidenceA.id] });
    const configured = options([evidenceB, evidenceA]);
    const valueGraph = graph([value], [evidenceB, evidenceA]);
    const first = await explainResearchRelation(valueGraph, value.id, configured);
    const second = await explainResearchRelation(valueGraph, value.id, {
      ...configured,
      evidenceReferences: [evidenceA, evidenceB],
    });
    expect(first).toEqual(second);
    if (first.status === 'explained') {
      expect(first.explanation.supporting_evidence.map(({ evidence }) => evidence.id)).toEqual([
        'mw:evidence:tanzil-q7-46',
        'mw:evidence:tanzil-q7-46-secondary',
      ]);
    }
  });

  it('uses detached relation and evidence snapshots while passage lookup is pending', async () => {
    const root = relation();
    const refs = [quranEvidence()];
    const inputGraph = graph([root], refs);
    const passage = deferred<ResolvablePassage | null>();
    const lookupStarted = deferred<void>();
    const configured = options(refs);
    configured.lookupPassage = async () => {
      lookupStarted.resolve();
      return passage.promise;
    };

    const pending = explainResearchRelation(inputGraph, root.id, configured);
    await lookupStarted.promise;

    root.predicate = 'related_to';
    root.content_revision = 2;
    root.supporting_evidence_ids[0] = 'mw:evidence:injected';
    refs[0]!.id = 'mw:evidence:injected';
    refs[0]!.direction = 'counterevidence';
    refs[0]!.selector.content_sha256 = '0'.repeat(64);

    passage.resolve(quranPassage);
    const result = await pending;
    expect(result).toMatchObject({
      status: 'explained',
      explanation: {
        predicate: 'edition_of',
        content_revision: 1,
        supporting_evidence: [
          {
            direction: 'supporting',
            evidence: {
              id: 'mw:evidence:tanzil-q7-46',
              direction: 'supporting',
              selector: {
                locator: 'Q7:46',
                content_sha256: quranPassage.content_sha256,
              },
            },
          },
        ],
      },
    });
  });

  it('keeps alternative and visibility decisions bound to the pre-await snapshot', async () => {
    const evidence = quranEvidence();
    const counterevidence: ResearchEvidenceReference = {
      ...quranEvidence('counterevidence'),
      id: 'mw:evidence:synthetic-counter-snapshot',
    };
    const alternative = unreviewedRelation({
      id: 'mw:relation:synthetic-alternative-snapshot',
      predicate: 'related_to',
      supporting_evidence_ids: [],
      counterevidence_ids: [counterevidence.id],
    });
    const root = relation({
      alternative_relation_ids: [alternative.id],
      counterevidence_ids: [counterevidence.id],
    });
    const inputGraph = graph([root, alternative], [evidence, counterevidence]);
    const visibility = new Map<string, ResearchVisibility>([
      [evidence.id, 'PUBLIC_APPROVED'],
      [counterevidence.id, 'PUBLIC_APPROVED'],
    ]);
    const passage = deferred<ResolvablePassage | null>();
    const lookupStarted = deferred<void>();
    let lookupCount = 0;
    const configured = options([evidence, counterevidence], visibility);
    configured.lookupPassage = async () => {
      lookupCount += 1;
      if (lookupCount === 1) {
        lookupStarted.resolve();
        return passage.promise;
      }
      return quranPassage;
    };

    const pending = explainResearchRelation(inputGraph, root.id, configured);
    await lookupStarted.promise;

    root.alternative_relation_ids = [];
    root.visibility = 'RESTRICTED';
    alternative.epistemic_status = 'withdrawn';
    alternative.counterevidence_ids = [];
    const evidenceNode = inputGraph.nodes.find((node) => node.id === counterevidence.id)!;
    evidenceNode.visibility = 'CHILD_SENSITIVE';
    visibility.set(counterevidence.id, 'CHILD_SENSITIVE');

    passage.resolve(quranPassage);
    const result = await pending;
    expect(result).toMatchObject({
      status: 'explained',
      explanation: {
        predicate: 'edition_of',
        counterevidence: [{ evidence: { id: counterevidence.id } }],
        alternatives: [
          {
            relation: {
              id: alternative.id,
              epistemic_status: 'supported',
              predicate: 'related_to',
            },
            counterevidence: [{ evidence: { id: counterevidence.id } }],
          },
        ],
      },
    });
  });
});
