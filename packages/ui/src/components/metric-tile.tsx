import type { ComponentProps, ReactNode } from 'react';

export type MetricTileProps = Omit<ComponentProps<'article'>, 'children' | 'title'> & {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  accent?: 'magenta' | 'cyan' | 'yellow' | 'green';
};

/** Presentation only: callers own metric meaning, loading, and error states. */
export function MetricTile({
  label,
  value,
  detail,
  icon,
  accent = 'cyan',
  className,
  ...props
}: MetricTileProps) {
  return (
    <article
      className={['mw-ui-metric-tile', className].filter(Boolean).join(' ')}
      data-accent={accent}
      {...props}
    >
      <div className="mw-ui-metric-tile-heading">
        <p className="mw-ui-metric-tile-label">{label}</p>
        {icon ? (
          <span aria-hidden="true" className="mw-ui-metric-tile-icon">
            {icon}
          </span>
        ) : null}
      </div>
      <strong className="mw-ui-metric-tile-value">{value}</strong>
      {detail ? <p className="mw-ui-metric-tile-detail">{detail}</p> : null}
    </article>
  );
}
