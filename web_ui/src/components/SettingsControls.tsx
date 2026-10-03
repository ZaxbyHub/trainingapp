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
import {
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Button } from '../ui';
import { cx } from '../ui/cx';
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
              // A checked option that is not selectable keeps aria-disabled instead of the native
              // attribute: a natively disabled checked radio is skipped by Tab, which then lands
              // on another option of the group instead of the checked one.
              disabled={o.disabled && !checked}
              aria-disabled={o.disabled && checked ? true : undefined}
              onChange={() => {
                // aria-disabled keeps the checked option focusable but not selectable.
                if (o.disabled) return;
                onChange(o.value);
              }}
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

/** A section is current once its top is within this distance of the scroller's top. */
const SECTION_LINE_PX = 120;
/** After a nav jump, scroll-driven updates pause this long (the jump's own scroll). */
const JUMP_LOCK_MS = 600;

export interface SettingsNavItem {
  id: string;
  label: string;
}

/** Bring a section into view without moving focus. */
function scrollToSection(id: string): boolean {
  const target = document.getElementById(id);
  if (target === null) return false;
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
  return true;
}

/**
 * Move to a section the way `initialSection` does: scroll it into view and focus its
 * h2 (tabIndex -1), so keyboard and screen-reader users land on the destination.
 */
export function goToSettingsSection(id: string): boolean {
  if (!scrollToSection(id)) return false;
  const target = document.getElementById(id) as HTMLElement;
  const heading = target.querySelector<HTMLElement>('h2');
  (heading ?? target).focus({ preventScroll: true });
  return true;
}

/**
 * In-page section nav (design-language.md sections 3.5 and 5): a sticky list of links
 * beside the form at > 1024px, a wrapped row at 769-1024px, and a "Jump to section"
 * select at <= 768px (CSS picks one; the other is display:none, so it leaves the
 * accessibility tree).
 *
 * - A link jumps and moves focus to the section heading (an explicit activation).
 * - The select only SCROLLS on change (WCAG 3.2.2: Windows Chrome fires `change` on
 *   every arrow key, so focus must stay on the select); Enter on the select or the
 *   adjacent "Go" button moves focus to the heading.
 * - The current section (aria-current on the link, the select's value) follows the
 *   scroll position of <main>, is synced on mount and again after a jump settles.
 * - The nav publishes its own height as --settings-nav-h on its parent, so content
 *   scrolled or focused into view clears the sticky bar even when its links wrap.
 */
export function SettingsNav({ items, label = 'Settings sections' }: { items: readonly SettingsNavItem[]; label?: string }) {
  const [current, setCurrent] = useState<string>(items[0]?.id ?? '');
  const selectId = useId();
  const navRef = useRef<HTMLElement>(null);
  // Set by a jump: the jump's own scroll must not override the chosen section.
  const lockUntilRef = useRef(0);
  // The section a jump targeted: kept current after the jump while it sits at the line.
  const jumpTargetRef = useRef<string | null>(null);
  const syncRef = useRef<() => void>(() => undefined);
  // Go / Enter act on the select's ACTUAL value (never a possibly stale `current`).
  const selectRef = useRef<HTMLSelectElement>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const first = document.getElementById(items[0]?.id ?? '');
    // The page scrolls inside <main> (AppShell).
    const scroller = first?.closest('main');
    if (!scroller) return undefined;
    let frame = 0;
    const sync = () => {
      frame = 0;
      if (performance.now() < lockUntilRef.current) return;
      const top = scroller.getBoundingClientRect().top;
      const offset = (id: string) => {
        const el = document.getElementById(id);
        return el ? el.getBoundingClientRect().top - top : Number.POSITIVE_INFINITY;
      };
      const atBottom =
        scroller.scrollHeight > scroller.clientHeight + 1 &&
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      // A jumped-to section stays current while it is visible: at the line, or (near the
      // end of the page, where a short section can never reach the line) anywhere in view.
      const jumped = jumpTargetRef.current;
      if (jumped !== null) {
        const at = offset(jumped);
        if (at >= -2 && (at <= SECTION_LINE_PX || (atBottom && at < scroller.clientHeight))) {
          setCurrent(jumped);
          return;
        }
      }
      let next = items[0].id;
      if (atBottom) {
        // At the bottom a short last section can never reach the line.
        next = items[items.length - 1].id;
      } else {
        // The last section whose top has passed a line just below the top of the scroller.
        for (const item of items) if (offset(item.id) <= SECTION_LINE_PX) next = item.id;
      }
      setCurrent(next);
    };
    syncRef.current = sync;
    const onScroll = () => {
      // A user scroll after the jump settles ends the jump's claim on "current".
      if (performance.now() >= lockUntilRef.current) jumpTargetRef.current = null;
      if (frame === 0) frame = requestAnimationFrame(sync);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    // Sync once on mount (the page may open scrolled, e.g. at an initialSection).
    frame = requestAnimationFrame(sync);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      syncRef.current = () => undefined;
    };
  }, [items]);

  // Publish the nav's height for scroll-margin (sticky bar at <= 1024px).
  useEffect(() => {
    const nav = navRef.current;
    const host = nav?.parentElement;
    if (!nav || !host) return undefined;
    const publish = () => host.style.setProperty('--settings-nav-h', `${Math.ceil(nav.getBoundingClientRect().height)}px`);
    publish();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(publish);
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);

  /** Shared jump bookkeeping; `focus` decides whether focus moves to the heading. */
  const jump = (id: string, focus: boolean) => {
    lockUntilRef.current = performance.now() + JUMP_LOCK_MS;
    jumpTargetRef.current = id;
    const ok = focus ? goToSettingsSection(id) : scrollToSection(id);
    if (!ok) return;
    setCurrent(id);
    // Re-sync once the jump's scroll has settled (L8).
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      syncRef.current();
    }, JUMP_LOCK_MS + 50);
  };

  return (
    <nav ref={navRef} aria-label={label} className="settings-nav">
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
                jump(item.id, true);
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
          ref={selectRef}
          id={selectId}
          className="ui-select ui-focusable"
          value={current}
          // Scroll only: focus stays on the select (arrow keys fire change on Windows).
          onChange={(e) => jump(e.target.value, false)}
          onKeyDown={(e: KeyboardEvent<HTMLSelectElement>) => {
            if (e.key !== 'Enter') return;
            // Not preventDefault: in Firefox, Enter on an OPEN dropdown commits the
            // highlighted option and fires `change` AFTER this keydown. Read the value one
            // frame later, once that change has settled, so focus goes to the section the
            // select now shows.
            requestAnimationFrame(() => {
              const value = selectRef.current?.value;
              if (value) jump(value, true);
            });
          }}
        >
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          aria-label="Go to section"
          onClick={() => jump(selectRef.current?.value ?? current, true)}
        >
          Go
        </Button>
      </div>
    </nav>
  );
}
