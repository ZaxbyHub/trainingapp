import type { ButtonHTMLAttributes, MouseEvent } from 'react';
import { Icon, type IconName } from './icons';
import { cx } from './cx';
import { Tooltip } from './Overlays';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy, and blocks activation. */
  loading?: boolean;
}

/**
 * Native <button>. "Disabled" is conveyed with aria-disabled (the control stays
 * focusable and announced) and activation is suppressed; `disabled` itself is
 * left to callers that truly want the native behavior.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  children,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  const inert = loading || rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (inert) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <button
      type={type}
      {...rest}
      className={cx('ui-button', `ui-button--${variant}`, `ui-button--${size}`, 'ui-focusable', className)}
      aria-busy={loading || undefined}
      aria-disabled={inert || undefined}
      onClick={handleClick}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps
  extends Omit<ButtonProps, 'children' | 'aria-label'> {
  /** Required accessible name; also shown as a Tooltip on hover and keyboard focus. */
  'aria-label': string;
  icon: IconName;
}

export function IconButton({ icon, className, size = 'md', variant = 'ghost', ...rest }: IconButtonProps) {
  return (
    <Tooltip content={rest.title ?? rest['aria-label']}>
      <Button {...rest} size={size} variant={variant} className={cx('ui-icon-button', className)}>
        <Icon name={icon} />
      </Button>
    </Tooltip>
  );
}
