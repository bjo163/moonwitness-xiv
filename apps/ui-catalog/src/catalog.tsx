import { useState, type ComponentType, type ReactNode, type SVGProps } from 'react';
import {
  ActivityIcon,
  AddIcon,
  ArrowRightIcon,
  AttachmentIcon,
  CalendarIcon,
  CompanyIcon,
  DeleteIcon,
  EditIcon,
  FilterIcon,
  ModelIcon,
  SearchIcon,
  SecurityIcon,
  SettingsIcon,
  UserIcon,
} from '@moonwitness/ui/icons';
import { Avatar } from '@moonwitness/ui/components/avatar';
import { Badge } from '@moonwitness/ui/components/badge';
import { BarChart, LineChart } from '@moonwitness/ui/components/chart';
import { Checkbox } from '@moonwitness/ui/components/checkbox';
import { Button } from '@moonwitness/ui/components/button';
import { ArtworkFrame } from '@moonwitness/ui/components/artwork-frame';
import homeHeroDesktop from '@moonwitness/assets/illustrations/home-hero-desktop.webp';
import homeHeroMobile from '@moonwitness/assets/illustrations/home-hero-mobile.webp';
import boardMasthead from '@moonwitness/assets/illustrations/board-masthead.webp';
import lockupDark from '@moonwitness/assets/brand/moonwitness-lockup-dark.svg';
import lockupLight from '@moonwitness/assets/brand/moonwitness-lockup-light.svg';
import symbolDark from '@moonwitness/assets/brand/moonwitness-symbol-dark.svg';
import { MetricTile } from '@moonwitness/ui/components/metric-tile';
import { PaperNote } from '@moonwitness/ui/components/paper-note';
import { SectionRibbon } from '@moonwitness/ui/components/section-ribbon';
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@moonwitness/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@moonwitness/ui/components/dropdown-menu';
import { EmptyState } from '@moonwitness/ui/components/empty-state';
import { Field } from '@moonwitness/ui/components/field';
import { Input } from '@moonwitness/ui/components/input';
import { PageHeader } from '@moonwitness/ui/components/page-header';
import { Pagination } from '@moonwitness/ui/components/pagination';
import { Panel } from '@moonwitness/ui/components/panel';
import { SelectField } from '@moonwitness/ui/components/select-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@moonwitness/ui/components/select';
import { Skeleton } from '@moonwitness/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@moonwitness/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@moonwitness/ui/components/tabs';
import { toast, ToastHost } from '@moonwitness/ui/components/toast';
import { SoundProvider, SoundToggle, useSfx } from '@moonwitness/ui/components/audio';
import {
  InkUnderline,
  LoadingProgress,
  LoadingSpinner,
  SignalOrbit,
  SpeechBubble,
  SpeedLines,
} from '@moonwitness/ui/components/effects';
import { Toolbar } from '@moonwitness/ui/components/toolbar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@moonwitness/ui/components/tooltip';

const sections = [
  { id: 'foundations', label: 'Foundations' },
  { id: 'board-proof', label: 'Board dashboard proof' },
  { id: 'brand', label: 'Brand' },
  { id: 'typography', label: 'Typography' },
  { id: 'materials', label: 'Materials' },
  { id: 'editorial-proof', label: 'Editorial proof' },
  { id: 'actions', label: 'Actions & feedback' },
  { id: 'forms', label: 'Forms' },
  { id: 'overlays', label: 'Overlays' },
  { id: 'data-display', label: 'Data display' },
  { id: 'charts', label: 'Charts' },
] as const;

const chartData = [
  { label: 'Base', value: 42 },
  { label: 'CRM', value: 28 },
  { label: 'Inventory', value: 19 },
];

const iconSamples: { Component: ComponentType<SVGProps<SVGSVGElement>>; label: string }[] = [
  { Component: ActivityIcon, label: 'Activity' },
  { Component: AddIcon, label: 'Add' },
  { Component: AttachmentIcon, label: 'Attachment' },
  { Component: CalendarIcon, label: 'Calendar' },
  { Component: CompanyIcon, label: 'Company' },
  { Component: DeleteIcon, label: 'Delete' },
  { Component: EditIcon, label: 'Edit' },
  { Component: FilterIcon, label: 'Filter' },
  { Component: ModelIcon, label: 'Model' },
  { Component: SearchIcon, label: 'Search' },
  { Component: SecurityIcon, label: 'Security' },
  { Component: SettingsIcon, label: 'Settings' },
  { Component: UserIcon, label: 'User' },
];

function Example({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <article className="catalog-example">
      <div className="catalog-example-copy">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="catalog-example-stage">{children}</div>
    </article>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="catalog-section" id={id} aria-labelledby={`${id}-heading`}>
      <header className="catalog-section-heading">
        <p className="catalog-kicker">COMPONENT SET</p>
        <h2 id={`${id}-heading`}>{title}</h2>
        <p>{description}</p>
      </header>
      <div className="catalog-examples">{children}</div>
    </section>
  );
}

function CatalogContent() {
  const [dark, setDark] = useState(false);
  const [page, setPage] = useState(1);
  const [checked, setChecked] = useState(true);
  const [query, setQuery] = useState('');
  const [addonSort, setAddonSort] = useState<'ascending' | 'descending' | null>(null);
  const [selectedAddons, setSelectedAddons] = useState<string[]>([]);
  const { play } = useSfx();

  const addons = [
    ['Base', 'Platform team', 'Active'],
    ['CRM', 'Operations', 'Review'],
    ['Inventory', 'Supply group', 'Active'],
    ['Analytics', 'Research team', 'Active'],
    ['Media', 'Editorial team', 'Review'],
    ['Timeline', 'Platform team', 'Active'],
  ];
  const filteredAddons = addons
    .filter(([name]) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((left, right) =>
      addonSort === null
        ? 0
        : left[0].localeCompare(right[0]) * (addonSort === 'ascending' ? 1 : -1)
    );
  const pageCount = Math.max(1, Math.ceil(filteredAddons.length / 3));
  const currentPage = Math.min(page, pageCount);
  const visibleAddons = filteredAddons.slice((currentPage - 1) * 3, currentPage * 3);
  const allVisibleAddonsSelected =
    visibleAddons.length > 0 && visibleAddons.every(([name]) => selectedAddons.includes(name));

  function toggleVisibleAddons() {
    setSelectedAddons((current) =>
      allVisibleAddonsSelected
        ? current.filter((name) => !visibleAddons.some(([visibleName]) => visibleName === name))
        : [...new Set([...current, ...visibleAddons.map(([name]) => name)])]
    );
  }

  function toggleTheme() {
    setDark((current) => {
      const next = !current;
      document.documentElement.classList.toggle('dark', next);
      return next;
    });
  }

  return (
    <TooltipProvider>
      <div className="catalog-shell">
        <a className="skip-link" href="#catalog-main">
          Skip to components
        </a>
        <aside className="catalog-sidebar" aria-label="Catalog navigation">
          <a className="catalog-brand" href="#top" aria-label="MoonWitness UI catalog home">
            <img className="catalog-brand-symbol" src={symbolDark} alt="" />
            <span>
              <strong>MOONWITNESS</strong>
              <small>UI CATALOG</small>
            </span>
          </a>
          <nav className="catalog-nav" aria-label="Component sections">
            <span className="catalog-nav-label">LIBRARY</span>
            {sections.map((section) => (
              <a key={section.id} href={`#${section.id}`}>
                {section.label}
              </a>
            ))}
          </nav>
          <div className="catalog-sidebar-footer">
            <span>Shared tokens · RC.1</span>
            <span>Keyboard friendly</span>
          </div>
        </aside>

        <main id="catalog-main" className="catalog-main">
          <header className="catalog-topbar" id="top">
            <div>
              <span className="catalog-breadcrumb">Design system / UI package</span>
              <span className="catalog-version">v1.0.0-rc.1</span>
            </div>
            <Button variant="outline" size="sm" onClick={toggleTheme} aria-pressed={dark}>
              {dark ? 'Use light theme' : 'Use dark theme'}
            </Button>
          </header>

          <div className="catalog-content">
            <PageHeader
              title={
                <>
                  One system. <span className="catalog-highlight">Every screen.</span>
                </>
              }
              description="A practical catalog of the shared MoonWitness UI package. Explore real components, keyboard behavior, themes, and responsive states."
              actions={<Badge variant="primary">50 typed icons</Badge>}
            />

            <Panel
              className="catalog-intro-panel"
              title="MoonWitness visual system"
              description="Shared assets, readable controls, and expressive editorial details are built from the public @moonwitness/ui package."
            >
              <div className="catalog-intro-meta">
                <span>
                  <strong>50</strong> typed icons
                </span>
                <span>
                  <strong>4</strong> new compositions
                </span>
                <span>
                  <strong>AA</strong> contrast checked
                </span>
              </div>
            </Panel>

            <Section
              id="foundations"
              title="Foundations"
              description="Semantic color, type, identity, and surface primitives. Switch themes to inspect both token maps."
            >
              <Example
                title="Semantic colors"
                description="Theme-aware surfaces and status colors keep meaning stable."
              >
                <div className="swatch-grid">
                  {[
                    ['Page', 'var(--mw-background)'],
                    ['Surface', 'var(--mw-surface)'],
                    ['Primary', 'var(--mw-primary)'],
                    ['Destructive', 'var(--mw-destructive)'],
                    ['Success', 'var(--mw-success)'],
                    ['Info', 'var(--mw-info)'],
                  ].map(([label, color]) => (
                    <div className="swatch" key={label}>
                      <span style={{ backgroundColor: color }} />
                      <small>{label}</small>
                    </div>
                  ))}
                </div>
              </Example>
              <Example
                title="Identity & status"
                description="Avatar initials stay accessible; badges retain text labels across themes."
              >
                <div className="catalog-inline">
                  <Avatar name="MoonWitness" />
                  <Avatar name="System Operator" />
                  <Badge>Draft</Badge>
                  <Badge variant="primary">Active</Badge>
                  <Badge variant="destructive">Blocked</Badge>
                </div>
              </Example>
              <Example
                title="Typed product icons"
                description="Canonical vector paths generate individually importable, tree-shakeable React icons."
              >
                <div className="icon-grid">
                  {iconSamples.map(({ Component, label }) => (
                    <span className="icon-sample" key={label}>
                      <Component aria-hidden="true" /> <small>{label}</small>
                    </span>
                  ))}
                </div>
              </Example>
              <Example
                title="Editorial composition"
                description="These reusable package components create the visual rhythm used by the homepage and Board."
              >
                <SectionRibbon title="Stories" number="01" accent="magenta" />
                <div className="catalog-inline">
                  <PaperNote accent="yellow">Same moon. Different people.</PaperNote>
                  <MetricTile label="Stories in progress" value="12" detail="Example design data" />
                  <ArtworkFrame shape="portrait" caption="Example artwork">
                    <img src={homeHeroMobile} alt="Illustrative night city artwork" />
                  </ArtworkFrame>
                </div>
              </Example>
            </Section>

            <Section
              id="board-proof"
              title="Board dashboard proof"
              description="A dashboard composition inspired by the command-center reference. Values and records below are illustrative design samples, not live MoonWitness data."
            >
              <Example
                title="Command center · sample layout"
                description="Review the masthead, dense navigation, KPI rhythm, operational panels, and responsive collapse using shared package components."
              >
                <div className="catalog-board-proof">
                  <aside className="catalog-board-rail" aria-label="Sample dashboard navigation">
                    <div className="catalog-board-identity">
                      <img src={symbolDark} alt="" />
                      <span>
                        MOONWITNESS<small>COMMAND CENTER</small>
                      </span>
                    </div>
                    <div className="catalog-board-rail-menu" aria-hidden="true">
                      <span className="is-active">
                        <ActivityIcon /> Overview
                      </span>
                      <span>
                        <ModelIcon /> Stories
                      </span>
                      <span>
                        <CompanyIcon /> Companies
                      </span>
                      <span>
                        <UserIcon /> People
                      </span>
                      <span>
                        <SettingsIcon /> Settings
                      </span>
                    </div>
                    <p className="catalog-board-rail-note">
                      DESIGN SAMPLE
                      <br />
                      NOT LIVE DATA
                    </p>
                  </aside>
                  <div className="catalog-board-main">
                    <header className="catalog-board-masthead">
                      <img src={boardMasthead} alt="" />
                      <div>
                        <p>MOONWITNESS NETWORK · SAMPLE VIEW</p>
                        <h3>
                          SHADOW <span>COMMAND CENTER</span>
                        </h3>
                        <strong>Stories observed. People amplified. Worlds connected.</strong>
                      </div>
                    </header>
                    <div className="catalog-board-sample-label">
                      <Badge variant="primary">Contoh desain</Badge>
                      <span>All values are illustrative and do not represent production data.</span>
                    </div>
                    <div className="catalog-board-metrics">
                      <MetricTile
                        label="Partners"
                        value="24"
                        detail="Sample records"
                        accent="magenta"
                        icon={<CompanyIcon />}
                      />
                      <MetricTile
                        label="Active users"
                        value="18"
                        detail="Sample accounts"
                        accent="cyan"
                        icon={<UserIcon />}
                      />
                      <MetricTile
                        label="Companies"
                        value="12"
                        detail="Sample records"
                        accent="yellow"
                        icon={<ModelIcon />}
                      />
                      <MetricTile
                        label="Planned activities"
                        value="07"
                        detail="Sample schedule"
                        accent="green"
                        icon={<CalendarIcon />}
                      />
                    </div>
                    <div className="catalog-board-panels">
                      <Panel
                        className="catalog-board-work-panel"
                        title="Planned activities"
                        description="Illustrative schedule entries"
                        surface="ink"
                        frame="torn"
                        density="compact"
                        headingLevel={4}
                        actions={
                          <Button variant="outline" size="xs">
                            View sample
                          </Button>
                        }
                      >
                        <ul className="catalog-board-activity-list">
                          <li>
                            <span className="catalog-board-dot" /> <span>Review field notes</span>
                            <Badge>Today</Badge>
                          </li>
                          <li>
                            <span className="catalog-board-dot" />{' '}
                            <span>Prepare story outline</span>
                            <Badge>Tomorrow</Badge>
                          </li>
                          <li>
                            <span className="catalog-board-dot" />{' '}
                            <span>Check source references</span>
                            <Badge>Friday</Badge>
                          </li>
                        </ul>
                      </Panel>
                      <Panel
                        className="catalog-board-work-panel"
                        title="Recent activity"
                        description="Illustrative system events"
                        surface="ink"
                        frame="torn"
                        density="compact"
                        headingLevel={4}
                      >
                        <ul className="catalog-board-event-list">
                          <li>
                            <ActivityIcon aria-hidden="true" />
                            <span>
                              <strong>Draft updated</strong>
                              <small>Sample story · 12 min ago</small>
                            </span>
                          </li>
                          <li>
                            <AttachmentIcon aria-hidden="true" />
                            <span>
                              <strong>Reference added</strong>
                              <small>Sample record · 38 min ago</small>
                            </span>
                          </li>
                          <li>
                            <SecurityIcon aria-hidden="true" />
                            <span>
                              <strong>Access reviewed</strong>
                              <small>Sample workspace · 1 hr ago</small>
                            </span>
                          </li>
                        </ul>
                      </Panel>
                    </div>
                  </div>
                </div>
              </Example>
            </Section>

            <Section
              id="brand"
              title="Brand system"
              description="These lockups come from the canonical vector master in @moonwitness/assets. Use the crown symbol for compact rails and keep the full MoonWitness wordmark wherever it fits."
            >
              <Example
                title="Canonical lockups"
                description="The same editable master produces contrast-safe light and dark variants. The wordmark remains a vector path, not an image of text."
              >
                <div className="brand-variant-grid">
                  <figure className="brand-variant brand-variant-paper">
                    <img
                      src={lockupLight}
                      alt="MoonWitness crown and wordmark, dark ink on paper"
                    />
                    <figcaption>Paper surface · full lockup</figcaption>
                  </figure>
                  <figure className="brand-variant brand-variant-ink">
                    <img src={lockupDark} alt="MoonWitness crown and wordmark, paper ink on dark" />
                    <figcaption>Ink surface · full lockup</figcaption>
                  </figure>
                  <figure className="brand-variant brand-variant-paper brand-variant-symbol">
                    <img src={symbolDark} alt="MoonWitness crown symbol" />
                    <figcaption>Compact rail · crown symbol</figcaption>
                  </figure>
                </div>
              </Example>
            </Section>

            <Section
              id="typography"
              title="Typography"
              description="Expressive brush lettering is reserved for short headlines. Condensed display, readable UI text, and mono metadata keep data and controls clear."
            >
              <Example
                title="Four type roles"
                description="The specimens use local package fonts and semantic typography tokens."
              >
                <div className="type-specimen-list">
                  <div className="type-specimen type-specimen-brush">
                    <span>Brush display · short headlines</span>
                    <strong>FOLLOW THE SIGNAL</strong>
                  </div>
                  <div className="type-specimen type-specimen-condensed">
                    <span>Condensed display · section titles and metrics</span>
                    <strong>02 STORIES IN PROGRESS</strong>
                  </div>
                  <div className="type-specimen type-specimen-body">
                    <span>Space Grotesk · product copy and controls</span>
                    <strong>Different people. Shared context.</strong>
                  </div>
                  <div className="type-specimen type-specimen-mono">
                    <span>JetBrains Mono · identifiers and metadata</span>
                    <strong>MW:STORY:EDITORIAL-001 · 14:32 UTC</strong>
                  </div>
                  <div
                    className="type-specimen type-specimen-body"
                    data-testid="typography-copy-stress"
                  >
                    <span>
                      Space Grotesk · Indonesian copy, punctuation, numbers, and long words
                    </span>
                    <p>
                      Kisah lintas generasi ini memuat pertanggungjawaban, angka Rp1.234.567,
                      tanggal 24/10/2026, tanda baca—termasuk “kutipan”, (kurung), dan tanda
                      tanya?—serta karakter naïve yang harus tetap terbaca.
                    </p>
                  </div>
                </div>
              </Example>
            </Section>

            <Section
              id="materials"
              title="Materials & effects"
              description="Paper, ink, torn frames, brush ribbons, and halftone texture are layered around content. They stay decorative and never replace labels, state, or focus."
            >
              <Example
                title="Editorial materials"
                description="Use stronger material in editorial moments and keep work surfaces calm and readable."
              >
                <SectionRibbon title="A signal worth keeping" number="01" accent="magenta" />
                <div className="material-specimen-grid">
                  <Panel
                    className="material-panel"
                    title="Paper dossier"
                    description="The torn frame is shared UI; content remains selectable HTML."
                    surface="paper"
                    frame="torn"
                    density="compact"
                    headingLevel={3}
                  >
                    <p>People. Places. Stories.</p>
                  </Panel>
                  <PaperNote accent="yellow">Same moon. Different people.</PaperNote>
                  <div className="material-halftone" aria-hidden="true" />
                </div>
              </Example>
              <Example
                title="Motion and reduced motion"
                description="Decorative motion is brief; reduced motion keeps the mark and status visible without animation."
              >
                <div className="catalog-motion-grid">
                  <div>
                    <span>Focus lines</span>
                    <div className="catalog-motion-lines">
                      <SpeedLines count={20} />
                    </div>
                  </div>
                  <div>
                    <span>Ink underline</span>
                    <InkUnderline />
                  </div>
                  <SignalOrbit className="catalog-motion-orbit">
                    <SpeechBubble>Story saved</SpeechBubble>
                  </SignalOrbit>
                  <div className="catalog-motion-progress">
                    <span>Loading preview…</span>
                    <LoadingProgress label="Loading preview" />
                  </div>
                  <div className="catalog-motion-progress">
                    <span>Submitting action</span>
                    <Button size="sm" disabled aria-busy="true">
                      <LoadingSpinner /> Signing in…
                    </Button>
                  </div>
                </div>
              </Example>
            </Section>

            <Section
              id="editorial-proof"
              title="Homepage hero proof"
              description="A responsive composition specimen built from the same shared button, paper note, headline typography, and canonical hero artwork used by the public homepage."
            >
              <Example
                title="Editorial hero · specimen"
                description="Review the left-side text safe area, visual focal point, readable overlay, and CTA placement before changing production composition."
              >
                <div className="catalog-hero-proof">
                  <picture>
                    <source media="(max-width: 600px)" srcSet={homeHeroMobile} />
                    <img src={homeHeroDesktop} alt="" />
                  </picture>
                  <div className="catalog-hero-proof-shade" aria-hidden="true" />
                  <div className="catalog-hero-proof-copy">
                    <p className="catalog-hero-proof-kicker">PEOPLE · PLACES · STORIES</p>
                    <h3>
                      MOON<span>WITNESS</span>
                    </h3>
                    <p className="catalog-hero-proof-ribbon">Follow the signal</p>
                    <p className="catalog-hero-proof-body">
                      Different people. Shared context. A clearer view of the work that connects us.
                    </p>
                    <Button treatment="brush" size="sm">
                      Explore stories <ArrowRightIcon aria-hidden="true" />
                    </Button>
                  </div>
                  <PaperNote className="catalog-hero-proof-note" accent="yellow">
                    Same moon.
                    <br />
                    Different people.
                  </PaperNote>
                </div>
              </Example>
            </Section>

            <Section
              id="actions"
              title="Actions & feedback"
              description="Show the full action range, disabled states, long labels, and clear feedback."
            >
              <Example
                title="Button variants and sizes"
                description="Native button semantics are preserved at every size."
              >
                <div className="catalog-button-grid">
                  <Button>Primary action</Button>
                  <Button treatment="brush">Brush action</Button>
                  <Button variant="secondary">Secondary</Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="destructive">Delete record</Button>
                  <Button variant="ghost">Quiet action</Button>
                  <Button variant="link">Documentation link</Button>
                  <Button size="xs">Extra small</Button>
                  <Button size="lg">Large action</Button>
                  <Button disabled>Disabled</Button>
                  <Button asChild variant="outline">
                    <a href="#brand">Enabled link action</a>
                  </Button>
                  <Button asChild disabled variant="outline">
                    <a
                      href="#brand"
                      data-testid="disabled-button-link"
                      onClick={() => {
                        window.location.hash = 'brand';
                      }}
                    >
                      Disabled link action
                    </a>
                  </Button>
                  <Button className="catalog-long-button">
                    Save these organization preferences and notify every workspace administrator
                  </Button>
                </div>
              </Example>
              <Example
                title="Tooltip & toast"
                description="Tooltip opens on focus or hover; toast reports results, and SFX stays muted until enabled."
              >
                <div className="catalog-inline">
                  <SoundToggle />
                  <Button variant="outline" onClick={() => play('success')}>
                    Play success cue
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline">
                        <SearchIcon aria-hidden="true" /> Search
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Search all installed models</TooltipContent>
                  </Tooltip>
                  <Button
                    onClick={() =>
                      toast.success('Settings saved', {
                        description: 'Your workspace preferences are up to date.',
                      })
                    }
                  >
                    Show success toast
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      toast.error('Could not save', {
                        description: 'Check the form and try again.',
                      })
                    }
                  >
                    Show error toast
                  </Button>
                </div>
                <ToastHost />
              </Example>
            </Section>

            <Section
              id="forms"
              title="Forms"
              description="Examples include required fields, descriptions, invalid states, controlled input, and native keyboard access."
            >
              <Example
                title="Field, input & validation"
                description="Labels, help text, and errors are connected through accessible descriptions."
              >
                <div className="catalog-form-grid">
                  <Field
                    htmlFor="catalog-name"
                    label="Display name"
                    required
                    description="Shown in activity and audit screens."
                  >
                    <Input placeholder="Ada Lovelace" />
                  </Field>
                  <Field
                    htmlFor="catalog-email"
                    label="Work email"
                    error="Enter a valid work email address."
                  >
                    <Input type="email" defaultValue="not-an-email" />
                  </Field>
                  <Field
                    htmlFor="catalog-search"
                    label="Filter records"
                    description="Type to filter the sample table below."
                  >
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.currentTarget.value)}
                      placeholder="Search partners"
                    />
                  </Field>
                  <Field htmlFor="catalog-role-native" label="Native select">
                    <SelectField id="catalog-role-native" defaultValue="member">
                      <option value="admin">Administrator</option>
                      <option value="member">Member</option>
                      <option value="viewer">Viewer</option>
                    </SelectField>
                  </Field>
                  <div className="catalog-field">
                    <label id="catalog-role-label" htmlFor="catalog-role-trigger">
                      Accessible select
                    </label>
                    <Select defaultValue="member">
                      <SelectTrigger id="catalog-role-trigger" aria-labelledby="catalog-role-label">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">Administrator</SelectItem>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="viewer">Viewer</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="catalog-check-row" htmlFor="catalog-consent">
                    <Checkbox
                      id="catalog-consent"
                      checked={checked}
                      onChange={(event) => setChecked(event.currentTarget.checked)}
                    />
                    <span>Include archived records</span>
                  </label>
                </div>
              </Example>
            </Section>

            <Section
              id="overlays"
              title="Overlays & composition"
              description="Dialog, dropdown, tabs, toolbars, and page framing support keyboard-first workflows."
            >
              <Example
                title="Dialog & dropdown"
                description="Open with Enter or Space, move with arrow keys, close with Escape."
              >
                <div className="catalog-inline">
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button>Open dialog</Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Confirm workspace change</DialogTitle>
                        <DialogDescription>
                          This sample dialog traps focus, supports Escape, and returns focus to its
                          trigger.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <DialogClose asChild>
                          <Button variant="outline">Cancel</Button>
                        </DialogClose>
                        <DialogClose asChild>
                          <Button onClick={() => toast.success('Workspace updated')}>
                            Confirm change
                          </Button>
                        </DialogClose>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline">
                        More actions <span aria-hidden="true">⌄</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel>Sample actions</DropdownMenuLabel>
                      <DropdownMenuItem>
                        <EditIcon aria-hidden="true" /> Edit record
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <AddIcon aria-hidden="true" /> Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive">
                        <DeleteIcon aria-hidden="true" /> Delete record
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </Example>
              <Example
                title="Tabs, toolbar & page header"
                description="Composed patterns keep related actions and content grouped."
              >
                <Tabs defaultValue="overview" className="catalog-tabs">
                  <TabsList aria-label="Sample content views">
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="activity">Activity</TabsTrigger>
                    <TabsTrigger value="access">Access</TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview">
                    <Toolbar
                      aria-label="Sample list actions"
                      filters={<Input aria-label="Search items" placeholder="Search items" />}
                      actions={<Button size="sm">Add item</Button>}
                    />
                    <p className="catalog-tab-copy">
                      Overview content with a useful empty border and focus state.
                    </p>
                  </TabsContent>
                  <TabsContent value="activity">
                    <p className="catalog-tab-copy">Recent events are grouped by date and actor.</p>
                  </TabsContent>
                  <TabsContent value="access">
                    <p className="catalog-tab-copy">
                      Role assignments and access rules belong here.
                    </p>
                  </TabsContent>
                </Tabs>
              </Example>
            </Section>

            <Section
              id="data-display"
              title="Data display"
              description="Tables, pagination, loading placeholders, and empty states cover common data conditions."
            >
              <Example
                title="Table & pagination"
                description="Contoh desain: native table semantics, row selection, sorting, and bounded page navigation."
              >
                <Table
                  className="min-w-[36rem]"
                  scrollLabel="Installed add-ons table horizontal scroll"
                  aria-label="Installed add-ons"
                >
                  <caption className="sr-only">Sample design: installed add-ons</caption>
                  <TableHead>
                    <TableRow>
                      <TableHeader scope="col" aria-sort={addonSort ?? 'none'}>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            aria-label="Select all add-ons on this page"
                            checked={allVisibleAddonsSelected}
                            onChange={toggleVisibleAddons}
                          />
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label="Sort by addon"
                            onClick={() => {
                              setAddonSort((current) =>
                                current === 'ascending' ? 'descending' : 'ascending'
                              );
                              setPage(1);
                            }}
                          >
                            Addon{' '}
                            {addonSort === 'ascending'
                              ? '↑'
                              : addonSort === 'descending'
                                ? '↓'
                                : '↕'}
                          </Button>
                        </div>
                      </TableHeader>
                      <TableHeader scope="col">Owner</TableHeader>
                      <TableHeader scope="col">Status</TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {visibleAddons.map(([name, owner, status]) => (
                      <TableRow key={name}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Checkbox
                              aria-label={`Select ${name}`}
                              checked={selectedAddons.includes(name)}
                              onChange={() =>
                                setSelectedAddons((current) =>
                                  current.includes(name)
                                    ? current.filter((selected) => selected !== name)
                                    : [...current, name]
                                )
                              }
                            />
                            {name}
                          </div>
                        </TableCell>
                        <TableCell>{owner}</TableCell>
                        <TableCell>
                          <Badge variant={status === 'Active' ? 'primary' : 'default'}>
                            {status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pagination
                  className="catalog-pagination"
                  page={currentPage}
                  pageCount={pageCount}
                  onPageChange={setPage}
                />
              </Example>
              <Example
                title="Loading & empty states"
                description="Loading state is announced; empty state supplies context and a clear next action."
              >
                <div className="catalog-state-stack">
                  <Skeleton label="Loading a partner record" className="catalog-skeleton" />
                  <EmptyState
                    title="No matching records"
                    description="Change your filters or create a partner to get started."
                    icon={<SearchIcon />}
                    action={
                      <Button size="sm" onClick={() => setQuery('')}>
                        Clear filters
                      </Button>
                    }
                  />
                </div>
              </Example>
            </Section>

            <Section
              id="charts"
              title="Charts"
              description="Data visualizations include loading/error/empty states, locale formatting, and accessible alternatives."
            >
              <Example
                title="Bar & line charts"
                description="Each chart has a labeled table alternative and values formatted with the requested locale."
              >
                <div className="catalog-chart-grid">
                  <BarChart
                    title="Installed addons"
                    data={chartData}
                    locale="en-US"
                    valueLabel="Addons"
                  />
                  <LineChart
                    title="Weekly activity"
                    labels={['Mon', 'Tue', 'Wed', 'Thu', 'Fri']}
                    series={[
                      { label: 'Jobs', values: [12, 18, 16, 24, 31] },
                      { label: 'Users', values: [7, 9, 14, 12, 22] },
                    ]}
                    locale="en-US"
                  />
                  <BarChart title="Loading example" data={[]} loading />
                  <BarChart title="Error example" data={[]} error="Activity could not be loaded." />
                  <BarChart title="Empty example" data={[]} emptyMessage="No events yet." />
                </div>
              </Example>
            </Section>

            <footer className="catalog-footer">
              <span>MoonWitness UI · built from public package exports</span>
              <a href="https://github.com/bjo163/moonwitness-xi/tree/dev/packages/ui">
                Browse package source
              </a>
            </footer>
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}

export function Catalog() {
  return (
    <SoundProvider>
      <CatalogContent />
    </SoundProvider>
  );
}
