import {
  useEffect,
  useId,
  useMemo,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cx } from './cx';

export interface ComboboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list' | 'role' | 'type'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Suggestions; free text is always allowed (an editable combobox). */
  options: readonly string[];
  /** Shown as the only (disabled) row when the list opens with nothing to suggest. */
  emptyText?: ReactNode;
  /** An option was picked (Enter on the highlighted option, or a click): commit it. */
  onPick?: (value: string) => void;
}

/**
 * Editable combobox with a list popup (WAI-ARIA 1.2 "combobox with listbox popup,
 * list autocomplete"). Focus stays on the input; the highlighted option is conveyed
 * with aria-activedescendant. Keys: ArrowDown/ArrowUp open and move, Enter picks the
 * highlighted option, Escape closes (a second Escape is left to the page), Alt+ArrowUp
 * closes. Typing filters the suggestions (case-insensitive substring); when the text
 * equals a suggestion, the whole list is offered.
 */
export function Combobox({
  value,
  onValueChange,
  options,
  emptyText,
  onPick,
  className,
  onKeyDown,
  onBlur,
  disabled,
  ...rest
}: ComboboxProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const shown = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (q === '' || options.some((o) => o.toLowerCase() === q)) return [...options];
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [value, options]);
  const expanded = open && !disabled && (shown.length > 0 || emptyText !== undefined);
  const optionId = (i: number) => `${listId}-opt-${i}`;
  // The suggestions changed (typing, a new list): a highlight past the end is dropped.
  useEffect(() => {
    setActive((a) => (a >= shown.length ? -1 : a));
  }, [shown]);

  /** Open; highlight `index` only when it names a real option (-1: nothing highlighted). */
  const openList = (index: number) => {
    setOpen(true);
    setActive(index >= 0 && index < shown.length ? index : -1);
  };
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const pick = (option: string) => {
    onValueChange(option);
    onPick?.(option);
    close();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Opening highlights the current value's option only; with no match, nothing is
      // highlighted until the next ArrowDown (never a silent option 0).
      if (e.altKey || !expanded) openList(shown.indexOf(value));
      else if (shown.length > 0) setActive((a) => (a + 1) % shown.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.altKey) close();
      else if (!expanded) openList(shown.indexOf(value));
      else if (shown.length > 0) setActive((a) => (a <= 0 ? shown.length - 1 : a - 1));
    } else if (e.key === 'Enter' && expanded && active >= 0 && active < shown.length) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape' && expanded) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <span className={cx('ui-combobox', className)}>
      <input
        {...rest}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onClick={() => (expanded ? close() : openList(shown.indexOf(value)))}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          close();
          onBlur?.(e);
        }}
        className="ui-input ui-combobox__input ui-focusable"
      />
      <ul id={listId} role="listbox" className="ui-combobox__list" hidden={!expanded}>
        {shown.length === 0 && emptyText !== undefined ? (
          <li role="option" aria-selected={false} aria-disabled="true" className="ui-combobox__empty">
            {emptyText}
          </li>
        ) : (
          shown.map((o, i) => (
            <li
              // Index keys: an endpoint may list the same name twice.
              key={i}
              id={optionId(i)}
              role="option"
              aria-selected={o === value}
              className={cx('ui-combobox__option', i === active && 'ui-combobox__option--active')}
              // mousedown, not click: keep focus in the input (no blur/commit mid-pick).
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              {o}
            </li>
          ))
        )}
      </ul>
    </span>
  );
}
