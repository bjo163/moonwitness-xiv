import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router';
import { Button } from '@moonwitness/ui/components/button';
import brandSymbol from '@moonwitness/assets/brand/moonwitness-symbol-light.svg';
import notFoundImage from '@moonwitness/assets/illustrations/not-found-light.svg';
import guideBundleSource from '../../../dist/docs/guide.bundle.json';
import roadmapProgressSource from '../../../dist/roadmap-progress.json';
import type { SearchPage } from './document-content.js';

const MarkdownContent = lazy(() =>
  import('./document-content.js').then((module) => ({ default: module.MarkdownContent }))
);

type GuideItem = {
  title: string;
  kind: string;
  path: string;
  markdown: string;
};
type GuideSection = { title: string; items: GuideItem[] };
type GuideBundle = {
  schemaVersion: number;
  title: string;
  sourceFingerprint: string;
  sections: GuideSection[];
};
type SearchPageData = GuideItem & { route: string; searchText: string };
type WorkStatus = 'todo' | 'running' | 'blocked' | 'complete';
type DeliveryStage = 'verified' | 'main' | 'released' | 'planned' | 'unknown';
type RoadmapProgress = {
  sourceSha: string;
  sourceDirty: boolean;
  generatedAt: string;
  deliveryEvidence: string;
  totals: {
    taskCount: number;
    work: Record<WorkStatus, number>;
    delivery: Record<DeliveryStage, number>;
  };
  milestones: Record<
    string,
    {
      taskCount: number;
      work: Record<WorkStatus, number>;
      delivery: Record<DeliveryStage, number>;
    }
  >;
};

const guideBundle: GuideBundle = guideBundleSource;
const roadmapProgress: RoadmapProgress = roadmapProgressSource;
const repository = 'https://github.com/bjo163/moonwitness-xiv';
const sourceRef = import.meta.env.MW_DOCS_SOURCE_REF ?? 'main';
const applicationVersion = import.meta.env.MW_DOCS_APPLICATION_VERSION;
const docsChannel = import.meta.env.MW_DOCS_CHANNEL ?? 'preview';
const uiCatalogPath = `${import.meta.env.BASE_URL}components/`;
const pages: SearchPageData[] = guideBundle.sections.flatMap((section) =>
  section.items.map((item) => ({
    ...item,
    route: routeFor(item.path),
    searchText: `${item.title} ${item.path} ${item.markdown}`
      .replace(/[`*_>#|()[\]{}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .toLocaleLowerCase('id'),
  }))
);
const pageByPath = new Map<string, SearchPage>(pages.map((page) => [page.path, page]));

function routeFor(sourcePath: string): string {
  return `/guide/${sourcePath.replace(/^docs\/guide\//u, '').replace(/\.md$/u, '')}`;
}

function sourceUrl(target: string): string {
  return `${repository}/blob/${encodeURIComponent(sourceRef)}/${target}`;
}

function markdownHref(page: SearchPage, href: string | undefined): string {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/iu.test(href)) return href ?? '#';
  const [targetPath = '', fragment = ''] = href.split('#', 2);
  const normalized = targetPath
    ? new URL(targetPath, `https://moonwitness.invalid/${page.path}`).pathname.slice(1)
    : page.path;
  const target = pageByPath.get(normalized);
  if (target) return `${target.route}${fragment ? `#${fragment}` : ''}`;
  const sourcePath = normalized.startsWith('docs/') ? normalized : `docs/${normalized}`;
  return `${sourceUrl(sourcePath)}${fragment ? `#${fragment}` : ''}`;
}

function Search({ onNavigate }: { onNavigate: () => void }) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('id');
    if (normalized.length < 2) return [];
    return pages.filter((page) => page.searchText.includes(normalized)).slice(0, 8);
  }, [query]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      const editing =
        target instanceof HTMLElement &&
        target.matches('input, textarea, select, [contenteditable="true"]');
      if (
        (event.key === '/' || event.code === 'Slash') &&
        !editing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        input.current?.focus();
      }
      if (event.key === 'Escape') {
        setQuery('');
        input.current?.blur();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  return (
    <div className="search-wrap">
      <label className="search-field">
        <span className="search-icon" aria-hidden="true">
          ⌕
        </span>
        <span className="visually-hidden">Cari dokumentasi</span>
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              document.querySelector<HTMLElement>('[role="option"]')?.focus();
            }
          }}
          placeholder="Cari panduan..."
          aria-label="Cari dokumentasi"
          aria-controls="docs-search-results"
          aria-expanded={results.length > 0}
        />
        <kbd>/</kbd>
      </label>
      {query.trim().length > 1 && (
        <div
          className="search-results"
          id="docs-search-results"
          role="listbox"
          aria-label="Hasil pencarian"
        >
          {results.length ? (
            results.map((page) => (
              <Link
                key={page.path}
                role="option"
                tabIndex={0}
                aria-selected="false"
                to={page.route}
                onClick={() => {
                  setQuery('');
                  onNavigate();
                }}
              >
                <span>{page.title}</span>
                <small>{page.path}</small>
              </Link>
            ))
          ) : (
            <p role="status">Tidak ada hasil untuk “{query}”.</p>
          )}
        </div>
      )}
    </div>
  );
}

function PortalLayout() {
  const location = useLocation();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const selectedPage = pages.find((page) => page.route === location.pathname);
  const roadmapPage = location.pathname === '/roadmap';
  const navigate = useNavigate();

  useEffect(() => setMobileNavigationOpen(false), [location.pathname]);

  if (!selectedPage && !roadmapPage) return <NotFound />;

  return (
    <div className="portal-shell">
      <a className="skip-link" href="#main-content">
        Lewati ke isi
      </a>
      <header className="topbar">
        <Link className="brand" to="/" aria-label="MoonWitness Docs home">
          <img src={brandSymbol} alt="" width="34" height="34" />
          <span>
            MoonWitness <b>Docs</b>
          </span>
        </Link>
        <Search onNavigate={() => setMobileNavigationOpen(false)} />
        <a
          className="source-link"
          href={`${repository}/tree/${sourceRef}`}
          target="_blank"
          rel="noreferrer"
        >
          Source <span aria-hidden="true">↗</span>
        </a>
        <Button
          className="mobile-nav-toggle"
          type="button"
          variant="outline"
          aria-expanded={mobileNavigationOpen}
          aria-controls="docs-navigation"
          onClick={() => setMobileNavigationOpen((open) => !open)}
        >
          {mobileNavigationOpen ? 'Tutup menu' : 'Menu'}
        </Button>
      </header>
      <div className="portal-frame">
        <aside
          className={`sidebar${mobileNavigationOpen ? ' sidebar-open' : ''}`}
          id="docs-navigation"
          aria-label="Navigasi dokumentasi"
        >
          <p className="sidebar-eyebrow">PLATFORM GUIDE</p>
          <p className="docs-version" aria-label="Versi dokumentasi">
            {docsChannel === 'stable' ? 'Stable' : docsChannel === 'next' ? 'Next' : 'Preview'}
            <span>{applicationVersion}</span>
          </p>
          {guideBundle.sections.map((section) => (
            <section className="nav-section" key={section.title}>
              <h2>{section.title}</h2>
              <nav aria-label={section.title}>
                {section.items.map((item) => {
                  const page = pageByPath.get(item.path);
                  if (!page) return null;
                  return (
                    <Link
                      key={item.path}
                      className={
                        page.path === selectedPage?.path ? 'nav-link nav-link-active' : 'nav-link'
                      }
                      aria-current={page.path === selectedPage?.path ? 'page' : undefined}
                      to={page.route}
                    >
                      <span>{item.title}</span>
                      <span className="nav-kind">{item.kind}</span>
                    </Link>
                  );
                })}
              </nav>
            </section>
          ))}
          <section className="nav-section">
            <h2>Project</h2>
            <nav aria-label="Project">
              <Link
                className={roadmapPage ? 'nav-link nav-link-active' : 'nav-link'}
                aria-current={roadmapPage ? 'page' : undefined}
                to="/roadmap"
              >
                <span>Roadmap progress</span>
                <span className="nav-kind">Status</span>
              </Link>
              <a className="nav-link" href={uiCatalogPath}>
                <span>UI component catalog</span>
                <span className="nav-kind">Design</span>
              </a>
            </nav>
          </section>
          <div className="sidebar-footnote">
            <span className="status-orbit" aria-hidden="true" />
            <span>
              Docs dari source
              <br />
              <code>{guideBundle.sourceFingerprint.slice(0, 10)}</code>
            </span>
          </div>
        </aside>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {roadmapPage ? (
            <RoadmapDashboard />
          ) : selectedPage ? (
            <>
              <div className="content-toolbar">
                <span>{selectedPage.kind.replaceAll('-', ' ')}</span>
                <a href={sourceUrl(selectedPage.path)} target="_blank" rel="noreferrer">
                  Edit this page ↗
                </a>
              </div>
              <Suspense
                fallback={
                  <p className="document-loading" role="status">
                    Memuat halaman...
                  </p>
                }
              >
                <MarkdownContent
                  page={selectedPage}
                  resolveHref={(href) => markdownHref(selectedPage, href)}
                />
              </Suspense>
            </>
          ) : null}
          <footer className="page-footer">
            <span>MoonWitness · dokumentasi untuk developer</span>
            <button
              type="button"
              onClick={() => navigate(roadmapPage ? '/roadmap' : (selectedPage?.route ?? '/'))}
            >
              Kembali ke atas ↑
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}

function RoadmapDashboard() {
  const date = new Date(roadmapProgress.generatedAt);
  const workLabels = [
    ['todo', 'Belum dimulai'],
    ['running', 'Berjalan'],
    ['blocked', 'Terhambat'],
    ['complete', 'Selesai'],
  ] as const;
  const deliveryLabels = [
    ['verified', 'Terverifikasi di dev'],
    ['main', 'Masuk main'],
    ['released', 'Dirilis'],
    ['planned', 'Direncanakan'],
    ['unknown', 'Belum diverifikasi'],
  ] as const;
  const formatDate = Number.isNaN(date.getTime())
    ? roadmapProgress.generatedAt
    : `${roadmapProgress.generatedAt.replace('T', ' ').replace(/\.\d{3}Z$/u, '')} UTC`;

  return (
    <>
      <div className="content-toolbar">
        <span>Status proyek · {roadmapProgress.totals.taskCount} task</span>
        <a
          href={`${repository}/blob/${roadmapProgress.sourceSha}/ROADMAP.md`}
          target="_blank"
          rel="noreferrer"
        >
          Buka roadmap ↗
        </a>
      </div>
      <article className="roadmap-dashboard" aria-labelledby="roadmap-title">
        <p className="roadmap-eyebrow">MOONWITNESS · DELIVERY OVERVIEW</p>
        <h1 id="roadmap-title">Roadmap progress</h1>
        <p className="roadmap-intro">
          Ringkasan checklist master per milestone. Penyelesaian pekerjaan dan bukti delivery
          ditampilkan terpisah agar rencana selesai tidak dianggap sudah dirilis.
        </p>
        <dl className="roadmap-provenance">
          <div>
            <dt>Sumber</dt>
            <dd>
              <a href={`${repository}/tree/${roadmapProgress.sourceSha}`}>
                {roadmapProgress.sourceSha.slice(0, 12)}
              </a>
              {roadmapProgress.sourceDirty ? ' · checkout berubah' : ' · bersih'}
            </dd>
          </div>
          <div>
            <dt>Dibuat</dt>
            <dd>
              <time dateTime={roadmapProgress.generatedAt}>{formatDate}</time>
            </dd>
          </div>
          <div>
            <dt>Bukti delivery</dt>
            <dd>
              {roadmapProgress.deliveryEvidence === 'validated-lifecycle-snapshot'
                ? 'Snapshot lifecycle tervalidasi'
                : 'Belum tersedia'}
            </dd>
          </div>
        </dl>
        <section className="roadmap-summary" aria-label="Ringkasan pekerjaan">
          {workLabels.map(([key, label]) => (
            <div className="roadmap-stat" key={key}>
              <span>{label}</span>
              <strong>{roadmapProgress.totals.work[key] ?? 0}</strong>
            </div>
          ))}
        </section>
        <div className="roadmap-table-wrap">
          <table className="roadmap-table">
            <caption>
              Status berdasarkan milestone; delivery tidak disimpulkan dari checklist.
            </caption>
            <thead>
              <tr>
                <th scope="col">Milestone</th>
                <th scope="col">Task</th>
                {workLabels.map(([key, label]) => (
                  <th scope="col" key={key}>
                    {label}
                  </th>
                ))}
                {deliveryLabels.map(([key, label]) => (
                  <th scope="col" key={key}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(roadmapProgress.milestones).map(([milestone, counts]) => (
                <tr key={milestone}>
                  <th scope="row">{milestone}</th>
                  <td>{counts.taskCount}</td>
                  {workLabels.map(([key]) => (
                    <td key={key}>{counts.work[key] ?? 0}</td>
                  ))}
                  {deliveryLabels.map(([key]) => (
                    <td key={key}>{counts.delivery[key] ?? 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="roadmap-note" role="note">
          Delivery berstatus “belum diverifikasi” karena artifact ini tidak menyertakan snapshot
          lifecycle tervalidasi. Checklist selesai mengukur pekerjaan; status verified, main, atau
          released hanya tampil dengan bukti lifecycle yang sesuai SHA sumber.
        </p>
        <p className="roadmap-source-link">
          <a
            href={`${repository}/blob/${roadmapProgress.sourceSha}/docs/roadmap/evidence/M11.09.md`}
          >
            Metode dan batasan dashboard di evidence M11.09 →
          </a>
        </p>
      </article>
    </>
  );
}

function NotFound() {
  return (
    <main className="not-found" id="main-content">
      <Link className="brand" to="/">
        <img src={brandSymbol} alt="" width="34" height="34" />
        <span>
          MoonWitness <b>Docs</b>
        </span>
      </Link>
      <img src={notFoundImage} alt="" width="240" height="220" />
      <p className="eyebrow">404 · PAGE NOT FOUND</p>
      <h1>Halaman ini tidak ditemukan.</h1>
      <p>Periksa alamatnya atau kembali ke halaman panduan.</p>
      <Link className="home-link" to={pages[0]?.route ?? '/'}>
        Buka panduan awal <span aria-hidden="true">→</span>
      </Link>
    </main>
  );
}

export function DocsApp() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Navigate to={pages[0]?.route ?? '/'} replace />} />
        <Route path="/roadmap" element={<PortalLayout />} />
        <Route path="/guide/*" element={<PortalLayout />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
