import Link from 'next/link';
import { ChevronRightIcon } from '@moonwitness/ui/icons';

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-ink-faint"
    >
      <Link href="/board" className="transition-colors hover:text-ink hover:underline">
        Dashboard
      </Link>
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <div key={idx} className="flex items-center gap-1.5">
            <ChevronRightIcon className="size-3.5 opacity-40 text-ink" />
            {isLast || !item.to ? (
              <span className="border-2 border-ink bg-paper-raised px-2 py-0.5 font-bold text-ink shadow-[2px_2px_0_0_var(--ink)]">
                {item.label}
              </span>
            ) : (
              <Link href={item.to} className="transition-colors hover:text-ink hover:underline">
                {item.label}
              </Link>
            )}
          </div>
        );
      })}
    </nav>
  );
}
