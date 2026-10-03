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
import { useId, type HTMLAttributes, type ReactNode } from 'react';
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
        return (
          <label key={o.value} className={cx('ui-radio-card', checked && 'ui-selected')}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={checked}
              onChange={() => onChange(o.value)}
              onClick={onOptionClick ? () => onOptionClick(o.value) : undefined}
              aria-labelledby={labelId}
              aria-describedby={o.description !== undefined ? o.descriptionId : undefined}
              className="ui-radio-card__input ui-focusable"
            />
            <div className="ui-radio-card__text">
              <span id={labelId} className="ui-radio-card__label">
                {o.label}
              </span>
              {o.description !== undefined ? (
                <p id={o.descriptionId} className="ui-radio-card__desc">
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
