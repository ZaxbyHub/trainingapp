/**
 * Settings building blocks (Lumen phase 4). They render the ui/ primitives' classes
 * (`ui-section*`, `ui-radio-card*`, `ui-choice`) with the markup contract the Settings
 * page already has, which the generic primitives do not expose:
 *
 *  - SettingsSection: an EXPLICIT heading id (other code and specs address sections by
 *    `aria-labelledby="<id>-heading"`) and an optionally focusable heading (tabIndex -1),
 *    the programmatic focus target of SettingsPage's `initialSection`.
 *  - SettingsRadioCards: a fixed input `name` (tests query `input[name="rag-preset"]`),
 *    fixed description ids (`rag-quality-desc`), an `onClick` on the native radio (the
 *    Response Quality preset re-applies itself when its already-checked radio is
 *    clicked; a checked radio fires no change event), and the description as a `<p>`
 *    next to the title `<span>` (desktop/e2e/settings-layout.spec.ts measures the two
 *    for overlap).
 *
 * The native `<input type="radio">` stays the only AT-facing radio (issue #24 F9): the
 * wrapping `<label>` has no role, and clicking the card checks the input natively.
 */
import { useEffect, useId, useState, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../ui/cx';
import '../ui';
import './settings.css';

export interface SettingsSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  /** Id of the h2; the section is labelled by it. */
  headingId: string;
  description?: ReactNode;
  /** tabIndex -1 on the heading so it can receive programmatic focus. */
  focusableHeading?: boolean;
}

export function SettingsSection({
  title,
  headingId,
  description,
  focusableHeading = false,
  className,
  children,
  ...rest
}: SettingsSectionProps) {
  return (
    <section {...rest} aria-labelledby={headingId} className={cx('ui-section', 'settings-section', className)}>
      <div className="ui-section__head">
        <div>
          <h2 id={headingId} className="ui-section__title" tabIndex={focusableHeading ? -1 : undefined}>
            {title}
          </h2>
          {description ? <p className="ui-section__desc">{description}</p> : null}
        </div>
      </div>
      <div className="ui-section__body">{children}</div>
    </section>
  );
}

export interface SettingsRadioOption<V extends string> {
  value: V;
  label: ReactNode;
  description?: ReactNode;
  /** Id of the description `<p>` (referenced by the radio's aria-describedby). */
  descriptionId?: string;
  /** Not selectable; the description should say why. */
  disabled?: boolean;
}

export interface SettingsRadioCardsProps<V extends string> {
  /** Group name for assistive tech (rendered as a visually hidden legend). */
  legend: ReactNode;
  name: string;
  options: readonly SettingsRadioOption<V>[];
  /** Whether an option is checked (null-safe: no option need be checked). */
  isChecked: (value: V) => boolean;
  onChange: (value: V) => void;
  /** Click on the native radio (fires for an already-checked radio too). */
  onOptionClick?: (value: V) => void;
}

export function SettingsRadioCards<V extends string>({
  legend,
  name,
  options,
  isChecked,
  onChange,
  onOptionClick,
}: SettingsRadioCardsProps<V>) {
  // The accessible name is the title only (description via aria-describedby), as in
  // ui/RadioCardGroup; ids come from the index because values may hold whitespace.
  const base = useId();
  return (
    <fieldset className="ui-choice ui-radio-cards settings-radio-cards">
      <legend className="ui-visually-hidden">{legend}</legend>
      {options.map((o, i) => {
        const checked = isChecked(o.value);
        const labelId = `${base}-${i}-label`;
        const descId = o.descriptionId ?? `${base}-${i}-desc`;
        return (
          <label key={o.value} className={cx('ui-radio-card', checked && 'ui-selected', o.disabled && 'ui-disabled')}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={checked}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
              onClick={onOptionClick ? () => onOptionClick(o.value) : undefined}
              aria-labelledby={labelId}
              aria-describedby={o.description !== undefined ? descId : undefined}
              className="ui-radio-card__input ui-focusable"
            />
            <div className="ui-radio-card__text">
              <span id={labelId} className="ui-radio-card__label">
                {o.label}
              </span>
              {o.description !== undefined ? (
                <p id={descId} className="ui-radio-card__desc">
                  {o.description}
                </p>
              ) : null}
            </div>
          </label>
        );
      })}
    </fieldset>
  );
}

/** A titled block inside a section (h3), exposed as a named group. */
export function SettingsSubsection({
  title,
  headingId,
  description,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & { title: ReactNode; headingId: string; description?: ReactNode }) {
  return (
    <div {...rest} role="group" aria-labelledby={headingId} className={cx('settings-subsection', className)}>
      <h3 id={headingId} className="settings-subsection__title">
        {title}
      </h3>
      {description ? <p className="settings-text">{description}</p> : null}
      {children}
    </div>
  );
}

export interface SettingsNavItem {
  id: string;
  label: string;
}

/**
 * Move to a section the way `initialSection` does: scroll it into view and focus its
 * h2 (tabIndex -1), so keyboard and screen-reader users land on the destination.
 */
export function goToSettingsSection(id: string): boolean {
  const target = document.getElementById(id);
  if (target === null) return false;
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
  const heading = target.querySelector<HTMLElement>('h2');
  (heading ?? target).focus({ preventScroll: true });
  return true;
}

/**
 * In-page section nav (design-language.md sections 3.5 and 5): a sticky list of links
 * beside the form at > 1024px, a wrapped row at 769-1024px, and a "Jump to section"
 * select at <= 768px (CSS picks one; the other is display:none, so it leaves the
 * accessibility tree). The current section carries aria-current="true" (link) and is
 * the select's value; it follows the scroll position when IntersectionObserver exists.
 */
export function SettingsNav({ items, label = 'Settings sections' }: { items: readonly SettingsNavItem[]; label?: string }) {
  const [current, setCurrent] = useState<string>(items[0]?.id ?? '');
  const selectId = useId();

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const targets = items.map((i) => document.getElementById(i.id)).filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return undefined;
    // The page scrolls inside <main> (AppShell), so that is the observer root.
    const root = targets[0].closest('main');
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        const first = items.find((i) => visible.get(i.id));
        if (first) setCurrent(first.id);
      },
      // A section counts once it reaches the top band of the scroller.
      { root, rootMargin: '0px 0px -65% 0px', threshold: 0 },
    );
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [items]);

  const go = (id: string) => {
    if (goToSettingsSection(id)) setCurrent(id);
  };

  return (
    <nav aria-label={label} className="settings-nav">
      <ul className="settings-nav__list">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={current === item.id ? 'true' : undefined}
              className={cx('settings-nav__link', 'ui-focusable', current === item.id && 'ui-selected')}
              onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                // In-page move without touching location.hash (the app does not route by hash).
                e.preventDefault();
                go(item.id);
              }}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
      <div className="settings-nav__jump">
        <label htmlFor={selectId} className="settings-nav__jump-label">
          Jump to section
        </label>
        <select
          id={selectId}
          className="ui-select ui-focusable"
          value={current}
          onChange={(e) => go(e.target.value)}
        >
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
    </nav>
  );
}
