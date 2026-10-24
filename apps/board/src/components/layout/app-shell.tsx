'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import type { ModelInfo } from '@moonwitness/client';
import { ToastHost } from '@moonwitness/ui/components/toast';
import {
  CalendarIcon,
  CheckIcon,
  CodeIcon,
  CompanyIcon,
  GlobeIcon,
  KeyboardIcon,
  LogoutIcon,
  MenuIcon,
  MoonIcon,
  KnowledgeIcon,
  SearchIcon,
  StoryIcon,
  SunIcon,
  SettingsIcon,
  UserIcon,
  MessageIcon,
  PartnerIcon,
} from '@moonwitness/ui/icons';
import { useQuery } from '@tanstack/react-query';
import { client } from '@/lib/client';
import { scopedQueryKey } from '@/lib/query-scope';
import { canReadResearch } from '@/lib/research-access';
import { useAuth } from '@/hooks/use-auth-context';
import { useModels } from '@/hooks/use-model';
import { useTheme } from '@/hooks/use-theme';
import { DashboardIcon, modelIcon, modelLabel } from '@/lib/models';
import { readDevelopmentMode, updateDevelopmentMode } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { Button } from '@moonwitness/ui/components/button';
import { Skeleton } from '@moonwitness/ui/components/skeleton';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@moonwitness/ui/components/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@moonwitness/ui/components/dropdown-menu';
import { Logo } from '@/components/manga/logo';
import { Doodle } from '@moonwitness/ui/components/effects';
import { ShortcutsDialog } from '@/components/manga/shortcuts-dialog';
import { ActivityBell } from './activity-bell';
import { NotificationBell } from './notification-bell';
import { Sheet, SheetContent, SheetTrigger } from '@moonwitness/ui/components/sheet';
import { SoundToggle } from '@moonwitness/ui/components/audio';

function NavItem({
  to,
  label,
  icon: Icon,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: typeof DashboardIcon;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = pathname === to || (to !== '/board' && pathname?.startsWith(`${to}/`));
  return (
    <Link
      href={to}
      onClick={onNavigate}
      title={label}
      className={cn(
        'group relative flex min-h-10 min-w-0 items-center gap-3 border-l-4 border-transparent px-2 py-2 font-display text-base uppercase tracking-wide text-ink/70 transition-[background-color,color,border-color] duration-[var(--mw-motion-fast)] ease-[var(--mw-motion-ease)] hover:bg-ink/10 hover:text-ink',
        active && 'border-l-pink bg-pink text-on-pink hover:bg-pink hover:text-on-pink'
      )}
      aria-current={active ? 'page' : undefined}
    >
      <>
        <Icon className="relative size-5" strokeWidth={2.4} />
        <span className="relative min-w-0 whitespace-normal leading-tight">{label}</span>
      </>
    </Link>
  );
}

function ModelNavigation({
  groups,
  isLoading,
  canReadResearch,
  canEditStories,
  onNavigate,
}: {
  groups: Array<[string, ModelInfo[]]>;
  isLoading: boolean;
  canReadResearch: boolean;
  canEditStories: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Models" className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
      <NavItem to="/board" label="Dashboard" icon={DashboardIcon} onNavigate={onNavigate} />
      {canReadResearch && (
        <NavItem
          to="/board/knowledge"
          label="Knowledge explorer"
          icon={KnowledgeIcon}
          onNavigate={onNavigate}
        />
      )}
      {canEditStories && (
        <NavItem
          to="/board/stories/workbench"
          label="Story workbench"
          icon={StoryIcon}
          onNavigate={onNavigate}
        />
      )}
      <NavItem to="/board/whatsapp" label="WhatsApp" icon={MessageIcon} onNavigate={onNavigate} />
      {isLoading &&
        Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-8 bg-ink/10" />)}
      {groups.map(([group, items]) => (
        <div key={group} className="space-y-1">
          <p className="px-3 pb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">
            {group}
          </p>
          {items.map((item) => (
            <NavItem
              key={item.model}
              to={`/board/m/${item.model}`}
              label={item.menu.label ?? modelLabel(item.model)}
              icon={modelIcon(item.model)}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { data: models, isLoading } = useModels();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const commandPaletteTriggerRef = useRef<HTMLButtonElement>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [activeCompanyId, setActiveCompanyId] = useState<number | undefined>(() =>
    client.getCompanyId()
  );
  const researchAccess = canReadResearch(user?.role, client.getCompanyId());
  const canEditStories =
    (user?.role === 'user' || user?.role === 'superadmin') && Boolean(client.getCompanyId());
  const [developmentMode, setDevelopmentMode] = useState(readDevelopmentMode);

  const toggleDevelopmentMode = useCallback(() => {
    setDevelopmentMode((enabled) => !enabled);
  }, []);

  useEffect(() => {
    updateDevelopmentMode(developmentMode);
  }, [developmentMode]);

  const router = useRouter();

  // Query accessible companies for the tenant switcher
  const { data: companiesData } = useQuery({
    queryKey: scopedQueryKey(['companies_selector']),
    queryFn: () =>
      client.model<{ id: number; name: string }>('base.company').searchRead({
        limit: 50,
        order: 'name asc',
      }),
  });

  const companies = companiesData?.records ?? [];
  const currentCompany = companies.find((c) => c.id === activeCompanyId);

  const handleSelectCompany = (companyId: number | undefined) => {
    client.setCompanyId(companyId);
    setActiveCompanyId(companyId);
    // Tenant-scoped query keys switch atomically; don't refetch old keys with the new header.
  };

  // Omnisearch cross-model query
  const { data: searchResults } = useQuery({
    queryKey: scopedQueryKey(['omnisearch', paletteQuery]),
    queryFn: async () => {
      const q = paletteQuery.trim();
      if (!q) return [];
      const [partners, users, comps, activities] = await Promise.all([
        client
          .model<{ id: number; name: string }>('base.partner')
          .searchRead({
            domain: [['name', 'ilike', `%${q}%`]],
            limit: 5,
          })
          .catch(() => ({ records: [] })),
        client
          .model<{ id: number; login: string }>('base.user')
          .searchRead({
            domain: [['login', 'ilike', `%${q}%`]],
            limit: 5,
          })
          .catch(() => ({ records: [] })),
        client
          .model<{ id: number; name: string }>('base.company')
          .searchRead({
            domain: [['name', 'ilike', `%${q}%`]],
            limit: 5,
          })
          .catch(() => ({ records: [] })),
        client
          .model<{
            id: number;
            summary: string;
            activity_type: string;
            resource_model: string;
            resource_id: number;
          }>('base.activity')
          .searchRead({
            domain: [['summary', 'ilike', `%${q}%`]],
            limit: 5,
          })
          .catch(() => ({ records: [] })),
      ]);

      const items: Array<{
        id: number;
        model: string;
        title: string;
        type: 'partner' | 'user' | 'company' | 'activity';
        targetUrl?: string;
      }> = [];

      for (const p of partners.records) {
        items.push({ id: p.id, model: 'base.partner', title: p.name, type: 'partner' });
      }
      for (const u of users.records) {
        items.push({ id: u.id, model: 'base.user', title: u.login, type: 'user' });
      }
      for (const c of comps.records) {
        items.push({ id: c.id, model: 'base.company', title: c.name, type: 'company' });
      }
      for (const a of activities.records) {
        items.push({
          id: a.id,
          model: 'base.activity',
          title: a.summary,
          type: 'activity',
          targetUrl: `/board/m/${a.resource_model}/${a.resource_id}`,
        });
      }
      return items;
    },
    enabled: paletteOpen && paletteQuery.trim().length >= 2,
  });

  const groups = useMemo(() => {
    const byGroup = new Map<string, ModelInfo[]>();
    for (const item of models ?? []) {
      const group = item.menu.group;
      byGroup.set(group, [...(byGroup.get(group) ?? []), item]);
    }
    return [...byGroup.entries()].map(
      ([group, items]) =>
        [group, items.sort((left, right) => left.menu.sequence - right.menu.sequence)] as [
          string,
          ModelInfo[],
        ]
    );
  }, [models]);

  const visibleGroups = useMemo(() => {
    if (developmentMode) return groups;
    return groups
      .map(
        ([group, items]) =>
          [group, items.filter((item) => !item.menu.developmentOnly)] as [string, ModelInfo[]]
      )
      .filter(([, items]) => items.length > 0);
  }, [developmentMode, groups]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditableTarget =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement);

      if (isEditableTarget) return;

      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === '/' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <ToastHost theme={theme} />
      {/* Sidebar: scoped .dark tokens keep it ink-black with light ink in BOTH themes. */}
      <aside className="dark sticky top-0 hidden h-dvh flex-col border-r-4 border-ink bg-night text-ink lg:flex">
        <div className="relative flex items-center gap-3 border-b-2 border-dashed border-ink/20 px-4 py-4">
          <Logo compact decorative surface="dark" className="size-9 shrink-0" />
          <span className="font-display text-sm uppercase tracking-[0.16em] text-ink">
            MoonWitness
          </span>
        </div>
        <ModelNavigation
          groups={visibleGroups}
          isLoading={isLoading}
          canReadResearch={researchAccess}
          canEditStories={canEditStories}
        />
        <div className="border-t-2 border-dashed border-ink/20 p-3">
          <Button
            type="button"
            onClick={toggleDevelopmentMode}
            aria-pressed={developmentMode}
            className={cn(
              'flex w-full items-center gap-3 border-2 px-3 py-2 text-left font-mono text-xs uppercase tracking-wider transition-colors',
              developmentMode
                ? 'border-lime bg-lime text-on-accent font-bold'
                : 'border-ink/30 bg-transparent text-ink-soft hover:border-ink hover:text-ink'
            )}
          >
            <CodeIcon className="size-4" />
            {developmentMode ? 'Development Mode: On' : 'Development Mode'}
          </Button>
        </div>
        <div className="flex items-center gap-2 border-t-2 border-dashed border-ink/20 px-5 py-4 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          <Doodle kind="bolt" className="size-4" /> +1 every day
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex min-w-0 items-center gap-1 border-b-2 border-ink bg-paper/90 px-3 py-3 backdrop-blur sm:gap-3 sm:px-6">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0 lg:hidden"
                aria-label="Open model navigation"
              >
                <MenuIcon className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="dark w-[min(18rem,85vw)] gap-0 border-r-4 border-ink bg-night p-0 text-ink"
              aria-label="Model navigation"
            >
              <div className="flex items-center gap-3 border-b-2 border-dashed border-ink/20 px-4 py-4">
                <Logo compact decorative surface="dark" className="size-9 shrink-0" />
                <span className="font-display text-sm uppercase tracking-[0.16em] text-ink">
                  MoonWitness
                </span>
              </div>
              <ModelNavigation
                groups={visibleGroups}
                isLoading={isLoading}
                canReadResearch={researchAccess}
                canEditStories={canEditStories}
                onNavigate={() => setMobileNavOpen(false)}
              />
              <div className="border-t-2 border-dashed border-ink/20 p-3">
                <Button
                  type="button"
                  onClick={toggleDevelopmentMode}
                  aria-pressed={developmentMode}
                  className={cn(
                    'flex w-full items-center gap-3 border-2 px-3 py-2 text-left font-mono text-xs uppercase tracking-wider transition-colors',
                    developmentMode
                      ? 'border-lime bg-lime text-on-accent font-bold'
                      : 'border-ink/30 bg-transparent text-ink-soft hover:border-ink hover:text-ink'
                  )}
                >
                  <CodeIcon className="size-4" />
                  {developmentMode ? 'Development Mode: On' : 'Development Mode'}
                </Button>
              </div>
              <div className="flex items-center gap-2 border-t-2 border-dashed border-ink/20 px-5 py-4 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                <Doodle kind="bolt" className="size-4" /> +1 every day
              </div>
            </SheetContent>
          </Sheet>

          {/* Omnisearch trigger button */}
          <Button
            id="open-command-palette"
            ref={commandPaletteTriggerRef}
            onClick={() => setPaletteOpen(true)}
            className="press flex h-10 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-none border-2 border-ink bg-paper-raised px-2 text-left text-sm text-ink-faint shadow-ink-sm sm:max-w-md sm:px-3"
          >
            <SearchIcon className="size-4 shrink-0 text-ink" strokeWidth={2.6} />
            <span className="truncate">Search records, models, commands…</span>
            <kbd className="ml-auto hidden shrink-0 border border-ink px-1.5 font-mono text-[11px] text-ink sm:block">
              Ctrl K
            </kbd>
          </Button>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            {/* Tenant / Company Switcher */}
            {companies.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 border-2 border-ink px-2 font-mono text-xs shadow-ink-sm sm:gap-2 sm:px-3"
                    aria-label={`Switch company. Current scope: ${currentCompany?.name ?? 'Global Scope'}`}
                    title={`Company scope: ${currentCompany?.name ?? 'Global Scope'}`}
                  >
                    <CompanyIcon className="size-3.5 text-lime-600 dark:text-lime" />
                    <span className="hidden sm:inline">Tenant:</span>
                    <span className="hidden max-w-[120px] truncate font-bold md:inline">
                      {currentCompany ? currentCompany.name : 'Global Scope'}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 font-sans">
                  <DropdownMenuLabel className="font-display uppercase tracking-wider text-xs">
                    Multi-Tenant Scope
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => handleSelectCompany(undefined)}
                    className="flex items-center justify-between text-xs cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <GlobeIcon className="size-3.5 text-ink-faint" />
                      Global (All Companies)
                    </span>
                    {!activeCompanyId && <CheckIcon className="size-3.5 text-lime" />}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {companies.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      onClick={() => handleSelectCompany(c.id)}
                      className="flex items-center justify-between text-xs cursor-pointer"
                    >
                      <span className="flex items-center gap-2 truncate">
                        <CompanyIcon className="size-3.5 text-ink-faint" />
                        {c.name}
                      </span>
                      {activeCompanyId === c.id && <CheckIcon className="size-3.5 text-lime" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Activity Notification Center */}
            <ActivityBell />
            <NotificationBell />
            <SoundToggle />

            {/* Keyboard Shortcuts Trigger */}
            <Button
              id="shortcuts-btn"
              variant="outline"
              size="icon"
              className="hidden md:inline-flex"
              onClick={() => setShortcutsOpen(true)}
              aria-label="Keyboard Shortcuts"
              title="Keyboard Shortcuts (Ctrl + /)"
            >
              <KeyboardIcon className="size-4" />
            </Button>

            {/* Theme Toggle */}
            <Button
              id="toggle-theme"
              variant="outline"
              size="icon"
              className="hidden sm:inline-flex"
              onClick={toggle}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </Button>

            {/* User Dropdown */}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  id="user-menu"
                  variant="outline"
                  className="gap-1.5 px-2 normal-case sm:gap-2 sm:px-3"
                  aria-label={`User menu for ${user?.login ?? 'current user'}`}
                  title={`User menu for ${user?.login ?? 'current user'}`}
                >
                  <span className="grid size-6 place-items-center border-2 border-ink bg-lime font-display text-xs text-on-accent">
                    {user?.login.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="hidden sm:inline">{user?.login}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>
                  Signed in as <span className="font-bold">{user?.login}</span>
                  <span className="mt-1 block font-mono text-[11px] uppercase text-ink-faint">
                    {user?.role}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/board/profile" className="flex cursor-pointer items-center gap-2">
                    <UserIcon className="size-4" /> Profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/board/settings" className="flex cursor-pointer items-center gap-2">
                    <SettingsIcon className="size-4" /> Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem className="sm:hidden" onSelect={toggle}>
                  {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
                  Toggle theme
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem id="logout" onSelect={() => void logout()}>
                  <LogoutIcon /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 pb-24 sm:px-6 sm:py-8 sm:pb-8 lg:px-10">
          <div key={activeCompanyId ?? 'default-company'}>{children}</div>
        </main>
      </div>

      {/* Global Omnisearch Dialog */}
      <CommandDialog
        open={paletteOpen}
        onOpenChange={(open) => {
          setPaletteOpen(open);
          if (!open) requestAnimationFrame(() => commandPaletteTriggerRef.current?.focus());
        }}
      >
        <CommandInput
          placeholder="Search models or records (e.g. Acme, Alice, base.partner)…"
          value={paletteQuery}
          onValueChange={setPaletteQuery}
        />
        <CommandList>
          <CommandEmpty>No matching models or records found.</CommandEmpty>

          {/* Direct Matching Records Section */}
          {searchResults && searchResults.length > 0 && (
            <CommandGroup heading="Direct Records">
              {searchResults.map((item) => {
                const ItemIcon =
                  item.type === 'partner'
                    ? PartnerIcon
                    : item.type === 'user'
                      ? UserIcon
                      : item.type === 'activity'
                        ? CalendarIcon
                        : CompanyIcon;

                return (
                  <CommandItem
                    key={`${item.model}-${item.id}`}
                    value={`${item.title} ${item.model} ${paletteQuery}`}
                    onSelect={() => {
                      setPaletteOpen(false);
                      setPaletteQuery('');
                      router.push(item.targetUrl ?? `/board/m/${item.model}/${item.id}`);
                    }}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <ItemIcon className="size-4 text-lime-600 dark:text-lime" />
                    <span className="font-bold">{item.title}</span>
                    <span className="ml-auto inline-flex items-center border border-ink/20 bg-card px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-faint">
                      {item.type} #{item.id}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {/* System Modules Section */}
          {visibleGroups.map(([group, items]) => (
            <CommandGroup key={group} heading={group}>
              {items.map((item) => {
                const Icon = modelIcon(item.model);
                return (
                  <CommandItem
                    key={item.model}
                    value={`${item.menu.label ?? modelLabel(item.model)} ${item.model}`}
                    onSelect={() => {
                      setPaletteOpen(false);
                      setPaletteQuery('');
                      router.push(`/board/m/${item.model}`);
                    }}
                  >
                    <Icon /> {item.menu.label ?? modelLabel(item.model)}
                    <span
                      className="ml-auto max-w-[45%] truncate font-mono text-xs text-ink-faint"
                      title={item.model}
                    >
                      {item.model}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>

      {/* Keyboard Shortcuts Cheatsheet Modal */}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
