/**
 * Lumen phase 8: the explicit pairwise remap table (docs/design/design-language.md
 * section 6, phase 8). DATA ONLY, imported by tests; not part of the app bundle.
 *
 * Every retired FILL token is listed with the FOREGROUND it was paired with and
 * the Lumen fill + foreground that replace the pair. styles/lumen-tokens.contrast.test.ts
 * asserts every Lumen pair here is >= 4.5:1 in BOTH themes, so a legacy pairing can
 * never be "remapped" onto a pair that fails AA. styles/token-remap.test.ts asserts
 * that every name in retired-tokens.ts appears in exactly this module.
 *
 * `legacyFg` is a literal for legacy pairings that hard-coded white instead of
 * using a token. `null` Lumen sides mean "deleted, no replacement".
 */
export interface PairRemap {
  legacyFill: string;
  legacyFg: string | null;
  lumenFill: string | null;
  lumenFg: string | null;
  note: string;
}

const WHITE = '#ffffff (hard-coded)';

/** Fill + foreground pairs. */
export const PAIR_REMAP: readonly PairRemap[] = [
  { legacyFill: '--color-primary', legacyFg: '--color-text-on-primary', lumenFill: '--accent', lumenFg: '--accent-fg', note: 'blue -> iris; dark foreground flips white -> near-black' },
  { legacyFill: '--color-primary-hover', legacyFg: '--color-text-on-primary', lumenFill: '--accent-hover', lumenFg: '--accent-fg', note: 'dark hover goes lighter (legacy stayed dark)' },
  { legacyFill: '--color-primary-rgb', legacyFg: null, lumenFill: null, lumenFg: null, note: 'no consumers anywhere (nothing used rgba(var(--color-primary-rgb), a)); deleted. An RGB triple cannot alias a hex token; if a tint is ever needed use color-mix(in srgb, var(--accent) N%, transparent), --bg-selected or --bubble-user' },
  { legacyFill: '--color-danger', legacyFg: WHITE, lumenFill: '--danger', lumenFg: '--danger-fg-on-fill', note: 'dark foreground becomes near-black on a light red' },
  { legacyFill: '--color-danger-hover', legacyFg: WHITE, lumenFill: '--danger', lumenFg: '--danger-fg-on-fill', note: 'Lumen has no --danger-hover; no consumers' },
  { legacyFill: '--color-success', legacyFg: WHITE, lumenFill: '--success', lumenFg: '--success-fg-on-fill', note: 'legacy raw color failed AA with white; Lumen fill is darker in light' },
  { legacyFill: '--color-info', legacyFg: WHITE, lumenFill: '--info', lumenFg: '--info-fg-on-fill', note: 'as --color-success' },
  { legacyFill: '--color-warning', legacyFg: WHITE, lumenFill: '--warning', lumenFg: '--warning-fg-on-fill', note: 'as --color-success' },
  { legacyFill: '--color-success-strong', legacyFg: WHITE, lumenFill: '--success', lumenFg: '--success-fg-on-fill', note: 'the AA-safe legacy variant; same Lumen pair' },
  { legacyFill: '--color-info-strong', legacyFg: WHITE, lumenFill: '--info', lumenFg: '--info-fg-on-fill', note: 'as --color-success-strong' },
  { legacyFill: '--color-warning-strong', legacyFg: WHITE, lumenFill: '--warning', lumenFg: '--warning-fg-on-fill', note: 'as --color-success-strong' },
  { legacyFill: '--color-secondary', legacyFg: '--color-text-on-secondary', lumenFill: '--bg-sunken', lumenFg: '--text-primary', note: 'neutral fill; no direct Lumen equivalent' },
  { legacyFill: '--color-secondary-hover', legacyFg: '--color-text-on-secondary', lumenFill: '--bg-hover', lumenFg: '--text-primary', note: 'neutral hover fill' },
  { legacyFill: '--color-bubble-user', legacyFg: '--color-text-on-bubble-user', lumenFill: '--bubble-user', lumenFg: '--text-primary', note: 'translucent in dark; contrast composited over the surface' },
  { legacyFill: '--color-bubble-assistant', legacyFg: '--color-text-on-bubble-assistant', lumenFill: '--bg-canvas', lumenFg: '--text-primary', note: 'the body rule (theme.css) now uses this pair' },
  { legacyFill: '--color-bubble-system', legacyFg: '--color-text-on-bubble-system', lumenFill: '--bg-sunken', lumenFg: '--text-secondary', note: '' },
  { legacyFill: '--color-source-pill-bg', legacyFg: null, lumenFill: '--bg-sunken', lumenFg: '--text-secondary', note: 'legacy pill text color was never a token' },
  { legacyFill: '--color-bg', legacyFg: '--color-text-primary', lumenFill: '--bg-canvas', lumenFg: '--text-primary', note: '' },
  { legacyFill: '--color-surface', legacyFg: '--color-text-primary', lumenFill: '--bg-surface', lumenFg: '--text-primary', note: 'also the training iframe background (now .app-player__frame)' },
  { legacyFill: '--color-raised', legacyFg: '--color-text-primary', lumenFill: '--bg-raised', lumenFg: '--text-primary', note: '' },
  { legacyFill: '--color-surface-elevated', legacyFg: '--color-text-primary', lumenFill: '--bg-raised', lumenFg: '--text-primary', note: '' },
  { legacyFill: '--color-surface', legacyFg: '--color-text-muted', lumenFill: '--bg-surface', lumenFg: '--text-secondary', note: 'legacy muted failed AA (4.18:1); Lumen secondary passes' },
];

/** Retired tokens that are not fill/foreground pairs: a 1:1 replacement or none. */
export interface ScalarRemap {
  legacy: string;
  lumen: string | null;
  note: string;
}

export const SCALAR_REMAP: readonly ScalarRemap[] = [
  { legacy: '--color-text-primary', lumen: '--text-primary', note: 'foreground of the pairs above' },
  { legacy: '--color-text-muted', lumen: '--text-secondary', note: 'foreground of the pairs above' },
  { legacy: '--color-text-on-primary', lumen: '--accent-fg', note: 'foreground of the pairs above' },
  { legacy: '--color-text-on-secondary', lumen: '--text-primary', note: 'foreground of the pairs above' },
  { legacy: '--color-text-on-bubble-user', lumen: '--text-primary', note: 'foreground of the pairs above' },
  { legacy: '--color-text-on-bubble-assistant', lumen: '--text-primary', note: 'foreground of the pairs above' },
  { legacy: '--color-text-on-bubble-system', lumen: '--text-secondary', note: 'foreground of the pairs above' },
  { legacy: '--font-family', lumen: '--font-sans', note: 'identical stack: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif' },
  { legacy: '--font-size-display', lumen: '--type-display-size', note: '32px -> 30px' },
  { legacy: '--font-size-h1', lumen: '--type-title-size', note: '24px -> 22px' },
  { legacy: '--font-size-h2', lumen: null, note: 'no Lumen equivalent; no consumers' },
  { legacy: '--font-size-h3', lumen: '--type-heading-size', note: '17px' },
  { legacy: '--font-size-body', lumen: '--type-body-size', note: '15px' },
  { legacy: '--font-size-caption', lumen: '--type-caption-size', note: '13px' },
  { legacy: '--font-size-small', lumen: '--type-micro-size', note: '11px -> 12px' },
  { legacy: '--line-height-body', lumen: null, note: 'Lumen --type-*-line are px values paired with each size' },
  { legacy: '--line-height-heading', lumen: null, note: 'as --line-height-body' },
  { legacy: '--line-height-tight', lumen: null, note: 'as --line-height-body' },
  { legacy: '--spacing-xs', lumen: '--space-1', note: '4px' },
  { legacy: '--spacing-sm', lumen: '--space-2', note: '8px' },
  { legacy: '--spacing-md', lumen: '--space-4', note: '16px' },
  { legacy: '--spacing-lg', lumen: '--space-6', note: '24px' },
  { legacy: '--spacing-xl', lumen: '--space-8', note: '32px' },
  { legacy: '--spacing-xxl', lumen: '--space-12', note: '48px' },
  { legacy: '--spacing-xxxl', lumen: '--space-16', note: '64px' },
  { legacy: '--spacing-section', lumen: '--space-12', note: '48px' },
  { legacy: '--spacing-input-pad', lumen: null, note: 'compound padding preset; no consumers' },
  { legacy: '--spacing-card-pad', lumen: null, note: 'compound padding preset; no consumers' },
  { legacy: '--spacing-section-pad', lumen: null, note: 'compound padding preset; no consumers' },
  { legacy: '--spacing-frame-pad', lumen: null, note: 'compound padding preset; no consumers' },
  { legacy: '--spacing-bar-pad', lumen: null, note: 'compound padding preset; no consumers' },
  { legacy: '--radius-xs', lumen: null, note: '4px; no Lumen radius token; no consumers' },
  { legacy: '--radius-sm', lumen: '--r-control', note: '6px; was the training iframe radius' },
  { legacy: '--radius-md', lumen: '--r-card', note: '12px -> 10px; no consumers' },
  { legacy: '--radius-lg', lumen: '--r-overlay', note: '20px -> 14px; no consumers' },
  { legacy: '--shadow-sm', lumen: '--shadow-1', note: 'no consumers' },
  { legacy: '--shadow-md', lumen: '--shadow-2', note: 'no consumers' },
  { legacy: '--shadow-lg', lumen: '--shadow-3', note: 'no consumers' },
];

/** Every retired name must be accounted for by this module (asserted by token-remap.test.ts). */
export function remappedLegacyNames(): Set<string> {
  const out = new Set<string>();
  for (const p of PAIR_REMAP) {
    for (const n of [p.legacyFill, p.legacyFg]) if (n && n.startsWith('--')) out.add(n);
  }
  for (const s of SCALAR_REMAP) out.add(s.legacy);
  return out;
}
