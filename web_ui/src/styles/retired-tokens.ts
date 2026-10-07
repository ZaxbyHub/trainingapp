/**
 * Lumen phase 8: the FROZEN list of retired (pre-Lumen) design tokens.
 *
 * These names were declared in styles/tokens.css and styles/theme.css until
 * phase 8 deleted them. They must never reappear in any definition or
 * `var()` reference. The list is data, frozen here (the exact names those files
 * declared at the moment of retirement) so the guardrail tests do not depend
 * on a stylesheet that no longer exists: deriving it from tokens.css would
 * yield an empty list, and an empty alternation matches everything.
 *
 * Imported only by tests (the hygiene tests and styles/token-ratchet.test.ts)
 * and by styles/token-remap.ts. Not part of the app bundle.
 *
 * Deliberately NOT retired (still legal): --font-mono (a Lumen token) and any
 * name that merely starts with a retired name, such as --font-family-mono, so
 * the matcher below ends in a (?![\w-]) guard.
 */
export const RETIRED_TOKENS: readonly string[] = [
  // color
  '--color-bg',
  '--color-bubble-assistant',
  '--color-bubble-system',
  '--color-bubble-user',
  '--color-danger',
  '--color-danger-hover',
  '--color-info',
  '--color-info-strong',
  '--color-primary',
  '--color-primary-hover',
  '--color-primary-rgb',
  '--color-raised',
  '--color-secondary',
  '--color-secondary-hover',
  '--color-source-pill-bg',
  '--color-success',
  '--color-success-strong',
  '--color-surface',
  '--color-surface-elevated',
  '--color-text-muted',
  '--color-text-on-bubble-assistant',
  '--color-text-on-bubble-system',
  '--color-text-on-bubble-user',
  '--color-text-on-primary',
  '--color-text-on-secondary',
  '--color-text-primary',
  '--color-warning',
  '--color-warning-strong',
  // type
  '--font-family',
  '--font-size-body',
  '--font-size-caption',
  '--font-size-display',
  '--font-size-h1',
  '--font-size-h2',
  '--font-size-h3',
  '--font-size-small',
  '--line-height-body',
  '--line-height-heading',
  '--line-height-tight',
  // radius
  '--radius-lg',
  '--radius-md',
  '--radius-sm',
  '--radius-xs',
  // shadow (Lumen is --shadow-1/2/3)
  '--shadow-lg',
  '--shadow-md',
  '--shadow-sm',
  // spacing
  '--spacing-bar-pad',
  '--spacing-card-pad',
  '--spacing-frame-pad',
  '--spacing-input-pad',
  '--spacing-lg',
  '--spacing-md',
  '--spacing-section',
  '--spacing-section-pad',
  '--spacing-sm',
  '--spacing-xl',
  '--spacing-xs',
  '--spacing-xxl',
  '--spacing-xxxl',
];

/** Matches any retired token; (?![\w-]) keeps longer, non-retired names (--font-family-mono) legal. */
export const RETIRED_TOKEN_RE = new RegExp(`(${RETIRED_TOKENS.join('|')})(?![\\w-])`);
