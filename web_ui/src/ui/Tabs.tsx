import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx';

export interface TabItem {
  id: string;
  label: ReactNode;
  panel: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  /** Accessible name for the tablist. */
  label: string;
  items: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

/** WAI-ARIA tabs: roving tabindex, arrow/Home/End keys, automatic activation. */
export function Tabs({ label, items, value, onChange, className }: TabsProps) {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabled = items.filter((i) => !i.disabled);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = enabled.findIndex((i) => i.id === value);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = enabled[next];
    onChange(target.id);
    refs.current.get(target.id)?.focus();
  };

  return (
    <div className={cx('ui-tabs', className)}>
      <div role="tablist" aria-label={label} className="ui-tabs__list" onKeyDown={onKeyDown}>
        {items.map((item) => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              ref={(el) => {
                if (el) refs.current.set(item.id, el);
                else refs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${item.id}`}
              aria-disabled={item.disabled || undefined}
              tabIndex={selected ? 0 : -1}
              className={cx('ui-tabs__tab', 'ui-focusable', selected && 'ui-selected')}
              onClick={() => {
                if (!item.disabled) onChange(item.id);
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`${base}-panel-${item.id}`}
          aria-labelledby={`${base}-tab-${item.id}`}
          hidden={item.id !== value}
          tabIndex={0}
          className="ui-tabs__panel ui-focusable"
        >
          {item.id === value ? item.panel : null}
        </div>
      ))}
    </div>
  );
}
