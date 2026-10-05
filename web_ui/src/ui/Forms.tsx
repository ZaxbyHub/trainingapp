import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { IconButton } from './Button';
import { cx, mergeIds } from './cx';

/* ------------------------------------------------------------------ Field */

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

export interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  /** Error message; presence sets aria-invalid on the control. */
  error?: ReactNode;
  /** Render prop receives the id / aria wiring to spread on the control. */
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
}

/** `<label for>`, help via aria-describedby, error via aria-invalid + message. */
export function Field({ label, help, error, children, className }: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className={cx('ui-field', className)}>
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {help ? (
        <p id={helpId} className="ui-field__help">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="ui-field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------- Text controls */

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export function TextInput({ className, type = 'text', ...rest }: TextInputProps) {
  return <input type={type} {...rest} className={cx('ui-input', 'ui-focusable', className)} />;
}

export interface PasswordInputProps extends Omit<TextInputProps, 'type'> {
  /** Accessible name of the reveal toggle (constant; state is aria-pressed). */
  revealLabel?: string;
}

export function PasswordInput({ className, revealLabel = 'Show password', ...rest }: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <span className="ui-password">
      <input
        {...rest}
        type={shown ? 'text' : 'password'}
        className={cx('ui-input', 'ui-password__input', 'ui-focusable', className)}
      />
      <IconButton
        icon={shown ? 'eye-off' : 'eye'}
        aria-label={revealLabel}
        aria-pressed={shown}
        size="sm"
        onClick={() => setShown((s) => !s)}
        className="ui-password__toggle"
      />
    </span>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx('ui-select', 'ui-focusable', className)}>
      {children}
    </select>
  );
}

/* --------------------------------------------------- Switch and Checkbox */

interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> {
  label: ReactNode;
  description?: ReactNode;
}

/** Native checkbox exposed with role="switch". */
export function Switch({ label, description, className, ...rest }: ToggleProps) {
  const descId = useId();
  const labelId = useId();
  return (
    <label className={cx('ui-toggle', 'ui-switch', rest.disabled && 'ui-disabled', className)}>
      <input
        {...rest}
        type="checkbox"
        role="switch"
        className="ui-toggle__input ui-focusable"
        aria-labelledby={mergeIds(labelId, rest['aria-labelledby'])}
        aria-describedby={mergeIds(description ? descId : undefined, rest['aria-describedby'])}
      />
      <span className="ui-switch__track" aria-hidden="true">
        <span className="ui-switch__thumb" />
      </span>
      <span className="ui-toggle__text">
        <span id={labelId} className="ui-toggle__label">{label}</span>
        {description ? (
          <span id={descId} className="ui-toggle__desc">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function Checkbox({ label, description, className, ...rest }: ToggleProps) {
  const descId = useId();
  const labelId = useId();
  return (
    <label className={cx('ui-toggle', 'ui-checkbox', rest.disabled && 'ui-disabled', className)}>
      <input
        {...rest}
        type="checkbox"
        className="ui-toggle__input ui-focusable"
        aria-labelledby={mergeIds(labelId, rest['aria-labelledby'])}
        aria-describedby={mergeIds(description ? descId : undefined, rest['aria-describedby'])}
      />
      <span className="ui-toggle__text">
        <span id={labelId} className="ui-toggle__label">{label}</span>
        {description ? (
          <span id={descId} className="ui-toggle__desc">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/* ------------------------------------------------ Radio-based selectors */

export interface ChoiceOption {
  value: string;
  /** Emitted as data-testid on the option's radio input (RadioCardGroup and SegmentedControl). */
  testId?: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

interface ChoiceGroupProps {
  legend: ReactNode;
  options: readonly ChoiceOption[];
  value: string;
  onChange: (value: string) => void;
  /** Hide the legend visually but keep it for assistive tech. */
  hideLegend?: boolean;
  className?: string;
}

/** `<fieldset>/<legend>` + native radios, so getByRole('radio', ...) keeps working. */
export function SegmentedControl({ legend, options, value, onChange, hideLegend, className }: ChoiceGroupProps) {
  const name = useId();
  return (
    <fieldset className={cx('ui-choice', 'ui-segmented', className)}>
      <legend className={hideLegend ? 'ui-visually-hidden' : 'ui-choice__legend'}>{legend}</legend>
      <div className="ui-segmented__track">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label key={o.value} className={cx('ui-segmented__item', on && 'ui-segmented-on', o.disabled && 'ui-disabled')}>
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={on}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
                data-testid={o.testId}
                className="ui-segmented__input ui-focusable"
              />
              <span>{o.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function RadioCardGroup({ legend, options, value, onChange, hideLegend, className }: ChoiceGroupProps) {
  const name = useId();
  const base = useId();
  return (
    <fieldset className={cx('ui-choice', 'ui-radio-cards', className)}>
      <legend className={hideLegend ? 'ui-visually-hidden' : 'ui-choice__legend'}>{legend}</legend>
      {options.map((o, i) => {
        const on = o.value === value;
        // Ids come from the index: option values may contain whitespace, which would split an IDREF.
        const labelId = `${base}-${i}-label`;
        const descId = `${base}-${i}-desc`;
        return (
          <label key={o.value} className={cx('ui-radio-card', on && 'ui-selected', o.disabled && 'ui-disabled')}>
            <input
              aria-labelledby={labelId}
              aria-describedby={o.description ? descId : undefined}
              type="radio"
              name={name}
              value={o.value}
              checked={on}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
              data-testid={o.testId}
              className="ui-radio-card__input ui-focusable"
            />
            <span className="ui-radio-card__text">
              <span id={labelId} className="ui-radio-card__label">{o.label}</span>
              {o.description ? <span id={descId} className="ui-radio-card__desc">{o.description}</span> : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
