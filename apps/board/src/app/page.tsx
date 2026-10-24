import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Button } from '@moonwitness/ui/components/button';
import { PaperNote } from '@moonwitness/ui/components/paper-note';
import { SectionRibbon } from '@moonwitness/ui/components/section-ribbon';
import { SignalOrbit } from '@moonwitness/ui/components/effects';
import { ArrowRightIcon, GlobeIcon, MoonIcon } from '@moonwitness/ui/icons';
import { HomeHeader } from '../components/home/home-header';
import { HomeHeroArt } from '../components/home/home-hero-art';
import { HorizontalFilmstrip } from '../components/home/horizontal-filmstrip';

// Next.js route metadata must be exported from the route file alongside its component.
// oxlint-disable-next-line react/only-export-components
export const metadata: Metadata = {
  title: 'Real people. Unfiltered worlds.',
  description: 'A shared workspace for people, stories, knowledge, and the signals between them.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'MoonWitness',
    title: 'Real people. Unfiltered worlds.',
    description: 'A shared workspace for people, stories, knowledge, and the signals between them.',
    images: [
      {
        url: '/brand/social-card.png',
        width: 1200,
        height: 630,
        alt: 'MoonWitness — real people and connected stories',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Real people. Unfiltered worlds.',
    description: 'A shared workspace for people, stories, knowledge, and the signals between them.',
    images: ['/brand/social-card.png'],
  },
};

const editorialCards = [
  {
    id: 'people',
    number: '01',
    label: 'PEOPLE & RECORDS',
    title: 'Different people. Shared context.',
    body: 'Keep partners, organizations, and their records connected in one workspace, with access shaped by your role.',
    crop: 'people',
    artwork: '/illustrations/editorial-people.webp',
  },
  {
    id: 'knowledge',
    number: '02',
    label: 'KNOWLEDGE',
    title: 'Look further than the record.',
    body: 'Bring research and working knowledge into view alongside the people and context your team already uses.',
    crop: 'knowledge',
    artwork: '/illustrations/editorial-knowledge.webp',
  },
  {
    id: 'stories',
    number: '03',
    label: 'STORY WORKBENCH',
    title: 'Make the signal legible.',
    body: 'Organize narrative work while keeping its underlying information connected to the workspace.',
    crop: 'stories',
    artwork: '/illustrations/editorial-stories.webp',
  },
] as const;

const processSteps = [
  {
    number: '01',
    label: 'CONNECT',
    title: 'People and records',
    body: 'Keep partner and organization context connected.',
    artwork: '/illustrations/editorial-people.webp',
    crop: 'people',
  },
  {
    number: '02',
    label: 'UNDERSTAND',
    title: 'Knowledge in context',
    body: 'Bring working knowledge alongside the record.',
    artwork: '/illustrations/editorial-knowledge.webp',
    crop: 'knowledge',
  },
  {
    number: '03',
    label: 'SHAPE',
    title: 'Story workbench',
    body: 'Organize narrative work around connected information.',
    artwork: '/illustrations/editorial-stories.webp',
    crop: 'stories',
  },
  {
    number: '04',
    label: 'REVIEW',
    title: 'Share with care',
    body: 'Keep visibility and actions shaped by team access.',
    artwork: '/illustrations/story-workbench-masthead.webp',
    crop: 'review',
  },
] as const;

export default function HomePage() {
  return (
    <main className="home-page">
      <HomeHeader />

      <section className="home-hero" id="home" aria-labelledby="home-title">
        <HomeHeroArt />
        <div className="home-hero-shade" aria-hidden="true" />
        <div className="home-hero-copy">
          <span className="home-kicker">People. Places. Stories. Another side of reality.</span>
          <h1 id="home-title" className="home-title" aria-label="MoonWitness">
            MOON<span>WITNESS</span>
          </h1>
          <p className="home-hero-ribbon">Follow the signal</p>
          <p className="home-lede">
            Different people. Shared context. A clearer view of the stories, knowledge, and records
            that connect our work.
          </p>
          <div className="home-actions">
            <Button asChild treatment="brush" size="lg">
              <Link href="/register">
                Explore MoonWitness <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
            <Link className="home-text-link" href="/login">
              Sign in to your workspace <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
        <PaperNote className="home-hero-note" accent="yellow">
          Same moon.
          <br />
          Different people.
        </PaperNote>
        <div className="home-hero-caption" aria-hidden="true">
          A workspace for real human stories
        </div>
      </section>

      <div className="home-band">
        <SignalOrbit className="home-band-orbit" aria-hidden="true">
          <span className="home-band-node home-band-node-one" />
          <span className="home-band-node home-band-node-two" />
          <span className="home-band-node home-band-node-three" />
          <span className="home-band-node home-band-node-four" />
        </SignalOrbit>
        <div className="home-band-copy">
          <span>Real people.</span> <strong>Connected knowledge.</strong>{' '}
          <span>A wider perspective.</span>
        </div>
      </div>

      <section className="home-editorial" aria-label="Explore MoonWitness">
        <div className="home-editorial-grid">
          {editorialCards.map((card) => (
            <article
              className={`home-editorial-card mw-ui-interactive-surface crop-${card.crop}`}
              id={card.id}
              key={card.id}
            >
              <SectionRibbon
                title={card.label}
                number={card.number}
                surface="ink"
                accent={card.number === '02' ? 'cyan' : 'magenta'}
              />
              <div className="home-card-art" aria-hidden="true">
                <Image src={card.artwork} alt="" fill sizes="(max-width: 800px) 100vw, 33vw" />
                <span className="home-card-mark mw-ui-interactive-marker">
                  {card.number === '01' ? (
                    <GlobeIcon />
                  ) : card.number === '02' ? (
                    <MoonIcon />
                  ) : (
                    <ArrowRightIcon />
                  )}
                </span>
              </div>
              <div className="home-card-copy">
                <h2 className="mw-ui-interactive-title">{card.title}</h2>
                <p>{card.body}</p>
                <Link
                  href={card.id === 'stories' ? '/login' : '/register'}
                  className="home-card-link"
                >
                  Explore <ArrowRightIcon aria-hidden="true" />
                </Link>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="home-connection" id="about" aria-labelledby="connection-title">
        <div className="home-connection-art" aria-hidden="true">
          <Image
            src="/illustrations/home-hero-desktop.webp"
            alt=""
            fill
            sizes="(max-width: 800px) 100vw, 60vw"
          />
        </div>
        <div className="home-connection-copy">
          <span className="home-kicker">One workspace, many perspectives</span>
          <h2 id="connection-title">Stories keep orbiting.</h2>
          <p>
            MoonWitness brings people, knowledge, and narrative work into a shared view. Your team
            controls what is visible and who can act.
          </p>
          <Button asChild treatment="brush" variant="secondary">
            <Link href="/register">
              Join the workspace <ArrowRightIcon aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <div className="home-orbit-note">
          <MoonIcon aria-hidden="true" /> Different witnesses.
          <br />
          Shared context.
        </div>
      </section>

      <section className="home-steps" aria-label="How the workspace connects">
        <SectionRibbon title="Follow the signal" number="04" surface="ink" accent="yellow" />
        <HorizontalFilmstrip
          className="home-step-strip"
          aria-label="How MoonWitness connects people, knowledge, and story work"
        >
          <div className="home-step-grid">
            {processSteps.map((step, index) => (
              <article className={`home-step-card crop-${step.crop}`} key={step.number}>
                <div className="home-step-art" aria-hidden="true">
                  <Image src={step.artwork} alt="" fill sizes="(max-width: 600px) 78vw, 25vw" />
                </div>
                <div className="home-step-copy">
                  <span>
                    {step.number} / {step.label}
                  </span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
                {index < processSteps.length - 1 ? (
                  <ArrowRightIcon className="home-step-arrow" aria-hidden="true" />
                ) : null}
              </article>
            ))}
          </div>
        </HorizontalFilmstrip>
      </section>

      <section className="home-join-band" aria-label="Join MoonWitness">
        <div>
          <span>More perspectives.</span>
          <strong> More connected work.</strong>
        </div>
        <Button asChild treatment="brush" variant="outline" size="lg">
          <Link href="/register">
            Join MoonWitness <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
      </section>

      <footer className="home-footer">
        <div className="home-footer-brand">
          <Image src="/brand/moonwitness-symbol-mono-light.svg" alt="" width={42} height={42} />
          <span>
            MOONWITNESS
            <br />
            <small>DIFFERENT PEOPLE. SHARED CONTEXT.</small>
          </span>
        </div>
        <div className="home-footer-actions">
          <Link href="/login">Sign in</Link>
          <Link href="/register">Create an account</Link>
        </div>
      </footer>
    </main>
  );
}
