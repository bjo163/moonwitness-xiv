import type { ComponentProps, ReactNode } from 'react';

export type SectionRibbonProps = Omit<ComponentProps<'header'>, 'children'> & {
  title: ReactNode;
  number?: string | number;
  accent?: 'magenta' | 'cyan' | 'yellow';
  surface?: 'paper' | 'ink';
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
};

export function SectionRibbon({
  title,
  number,
  accent = 'magenta',
  surface = 'paper',
  action,
  headingLevel = 2,
  className,
  ...props
}: SectionRibbonProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <header
      className={['mw-ui-section-ribbon', className].filter(Boolean).join(' ')}
      data-accent={accent}
      data-surface={surface}
      {...props}
    >
      <div className="mw-ui-section-ribbon-title">
        <Heading className="mw-ui-section-ribbon-heading">
          {number !== undefined ? (
            <span className="mw-ui-section-ribbon-number">{number}</span>
          ) : null}
          <span className="mw-ui-section-ribbon-label">{title}</span>
        </Heading>
      </div>
      {action ? <div className="mw-ui-section-ribbon-action">{action}</div> : null}
    </header>
  );
}
