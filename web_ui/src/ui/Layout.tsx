import { useId, type ElementType, type HTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { cx } from './cx';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('ui-card', className)} />;
}

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Heading element; defaults to h2. */
  headingLevel?: 2 | 3 | 4;
  actions?: ReactNode;
}

/** `<section aria-labelledby>` + heading (design-language.md section 4). */
export function Section({
  title,
  description,
  headingLevel = 2,
  actions,
  className,
  children,
  ...rest
}: SectionProps) {
  const headingId = useId();
  const Heading = `h${headingLevel}` as ElementType;
  return (
    <section {...rest} aria-labelledby={headingId} className={cx('ui-section', className)}>
      <div className="ui-section__head">
        <div>
          <Heading id={headingId} className="ui-section__title">
            {title}
          </Heading>
          {description ? <p className="ui-section__desc">{description}</p> : null}
        </div>
        {actions ? <div className="ui-section__actions">{actions}</div> : null}
      </div>
      <div className="ui-section__body">{children}</div>
    </section>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="ui-page-header">
      <div className="ui-page-header__text">
        <h1 className="ui-page-header__title">{title}</h1>
        {description ? <p className="ui-page-header__desc">{description}</p> : null}
      </div>
      {actions ? <div className="ui-page-header__actions">{actions}</div> : null}
    </header>
  );
}

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="ui-empty">
      {icon ? <Icon name={icon} size={32} className="ui-empty__icon" /> : null}
      <h2 className="ui-empty__title">{title}</h2>
      {description ? <p className="ui-empty__desc">{description}</p> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
}

export function KeyValueList({ items, className }: { items: readonly KeyValueItem[]; className?: string }) {
  return (
    <dl className={cx('ui-kv', className)}>
      {items.map((item, i) => (
        <div className="ui-kv__row" key={i}>
          <dt className="ui-kv__key">{item.label}</dt>
          <dd className="ui-kv__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
