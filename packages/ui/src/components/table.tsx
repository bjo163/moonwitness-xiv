import type { ComponentProps } from 'react';

export type TableProps = ComponentProps<'table'> & { scrollLabel?: string };
export type TableCaptionProps = ComponentProps<'caption'>;
export type TableHeadProps = ComponentProps<'thead'>;
export type TableBodyProps = ComponentProps<'tbody'>;
export type TableRowProps = ComponentProps<'tr'>;
export type TableHeaderProps = ComponentProps<'th'>;
export type TableCellProps = ComponentProps<'td'>;

export function Table({ className, scrollLabel, ...props }: TableProps) {
  return (
    <div
      className="mw-ui-table-wrap"
      data-slot="table-wrap"
      role={scrollLabel ? 'region' : undefined}
      aria-label={scrollLabel}
      tabIndex={scrollLabel ? 0 : undefined}
      onKeyDown={
        scrollLabel
          ? (event) => {
              if (event.target !== event.currentTarget) return;

              const { currentTarget, key } = event;
              if (key === 'ArrowLeft' || key === 'ArrowRight') {
                event.preventDefault();
                currentTarget.scrollBy({
                  left:
                    (key === 'ArrowLeft' ? -1 : 1) * Math.max(48, currentTarget.clientWidth * 0.8),
                  behavior: 'auto',
                });
              } else if (key === 'Home' || key === 'End') {
                event.preventDefault();
                currentTarget.scrollTo({
                  left: key === 'Home' ? 0 : currentTarget.scrollWidth,
                  behavior: 'auto',
                });
              }
            }
          : undefined
      }
    >
      <table className={['mw-ui-table', className].filter(Boolean).join(' ')} {...props} />
    </div>
  );
}

export function TableCaption({ className, ...props }: TableCaptionProps) {
  return (
    <caption className={['mw-ui-table-caption', className].filter(Boolean).join(' ')} {...props} />
  );
}

export function TableHead({ className, ...props }: TableHeadProps) {
  return <thead className={['mw-ui-table-head', className].filter(Boolean).join(' ')} {...props} />;
}

export function TableBody({ className, ...props }: TableBodyProps) {
  return <tbody className={['mw-ui-table-body', className].filter(Boolean).join(' ')} {...props} />;
}

export function TableRow({ className, ...props }: TableRowProps) {
  return <tr className={['mw-ui-table-row', className].filter(Boolean).join(' ')} {...props} />;
}

export function TableHeader({ className, ...props }: TableHeaderProps) {
  return <th className={['mw-ui-table-header', className].filter(Boolean).join(' ')} {...props} />;
}

export function TableCell({ className, ...props }: TableCellProps) {
  return <td className={['mw-ui-table-cell', className].filter(Boolean).join(' ')} {...props} />;
}
