import type { SVGProps } from 'react';

/**
 * In-repo icon set: a curated, vendored subset of Lucide path data (see
 * NOTICE.md in this folder for the license text). No runtime dependency,
 * airgap-safe; strokes use currentColor so forced-colors / theming just work.
 * Each entry is the list of SVG child elements for a 24x24 viewBox.
 */
type Shape =
  | { d: string }
  | { circle: [number, number, number] };

const ICONS = {
  check: [{ d: 'M20 6 9 17l-5-5' }],
  x: [{ d: 'M18 6 6 18' }, { d: 'm6 6 12 12' }],
  'chevron-down': [{ d: 'm6 9 6 6 6-6' }],
  'chevron-right': [{ d: 'm9 18 6-6-6-6' }],
  plus: [{ d: 'M5 12h14' }, { d: 'M12 5v14' }],
  search: [{ circle: [11, 11, 8] }, { d: 'm21 21-4.3-4.3' }],
  upload: [
    { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' },
    { d: 'm17 8-5-5-5 5' },
    { d: 'M12 3v12' },
  ],
  eye: [
    {
      d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0',
    },
    { circle: [12, 12, 3] },
  ],
  'eye-off': [
    { d: 'M9.88 9.88a3 3 0 1 0 4.24 4.24' },
    { d: 'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68' },
    { d: 'M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61' },
    { d: 'm2 2 20 20' },
  ],
  info: [{ circle: [12, 12, 10] }, { d: 'M12 16v-4' }, { d: 'M12 8h.01' }],
  'triangle-alert': [
    { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' },
    { d: 'M12 9v4' },
    { d: 'M12 17h.01' },
  ],
  'circle-alert': [{ circle: [12, 12, 10] }, { d: 'M12 8v4' }, { d: 'M12 16h.01' }],
  'circle-check': [{ circle: [12, 12, 10] }, { d: 'm9 12 2 2 4-4' }],
  // Shell navigation (phase 3). The nav glyphs reuse the Feather shapes the old
  // hand-inlined sidebar SVGs drew, so each destination keeps its icon.
  'chevron-left': [{ d: 'm15 18-6-6 6-6' }],
  menu: [{ d: 'M4 12h16' }, { d: 'M4 6h16' }, { d: 'M4 18h16' }],
  ellipsis: [{ circle: [12, 12, 1] }, { circle: [19, 12, 1] }, { circle: [5, 12, 1] }],
  'message-square': [{ d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }],
  'file-text': [
    { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' },
    { d: 'M14 2v6h6' },
    { d: 'M16 13H8' },
    { d: 'M16 17H8' },
  ],
  layers: [{ d: 'M12 2 2 7l10 5 10-5-10-5z' }, { d: 'm2 17 10 5 10-5' }, { d: 'm2 12 10 5 10-5' }],
  settings: [
    { circle: [12, 12, 3] },
    {
      d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
    },
  ],
  // Product mark glyph (Feather book-open); index.html's favicon draws the same shape.
  'book-open': [
    { d: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z' },
    { d: 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z' },
  ],
  // Chat (phase 5): composer, message actions, header actions, model chip, grounding.
  // Lucide rect/line primitives are expressed as equivalent paths (Shape has no rect).
  'arrow-up': [{ d: 'm5 12 7-7 7 7' }, { d: 'M12 19V5' }],
  'arrow-down': [{ d: 'M12 5v14' }, { d: 'm19 12-7 7-7-7' }],
  square: [{ d: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }],
  paperclip: [
    { d: 'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' },
  ],
  copy: [
    { d: 'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z' },
    { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' },
  ],
  'rotate-ccw': [{ d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }, { d: 'M3 3v5h5' }],
  download: [
    { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' },
    { d: 'm7 10 5 5 5-5' },
    { d: 'M12 15V3' },
  ],
  trash: [
    { d: 'M3 6h18' },
    { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' },
    { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' },
  ],
  globe: [{ circle: [12, 12, 10] }, { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }, { d: 'M2 12h20' }],
  cpu: [
    { d: 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' },
    { d: 'M9 9h6v6H9z' },
    { d: 'M15 2v2' },
    { d: 'M15 20v2' },
    { d: 'M2 15h2' },
    { d: 'M2 9h2' },
    { d: 'M20 15h2' },
    { d: 'M20 9h2' },
    { d: 'M9 2v2' },
    { d: 'M9 20v2' },
  ],
  server: [
    { d: 'M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z' },
    { d: 'M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z' },
    { d: 'M6 6h.01' },
    { d: 'M6 18h.01' },
  ],
  // Documents (phase 6): per-type document icons (design-language section 5
  // "type icon"). Page outline shared with Lucide's file icons.
  file: [{ d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z' }, { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
  // PDF: a page with a "P" (Lucide has no PDF glyph).
  'file-pdf': [
    { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z' },
    { d: 'M14 2v4a2 2 0 0 0 2 2h4' },
    { d: 'M10 18v-6h2a2 2 0 0 1 0 4h-2' },
  ],
  // Word-processor document: a page with a "T".
  'file-type': [
    { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z' },
    { d: 'M14 2v4a2 2 0 0 0 2 2h4' },
    { d: 'M9 13v-1h6v1' },
    { d: 'M12 12v6' },
    { d: 'M11 18h2' },
  ],
  'file-spreadsheet': [
    { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z' },
    { d: 'M14 2v4a2 2 0 0 0 2 2h4' },
    { d: 'M8 13h2' },
    { d: 'M14 13h2' },
    { d: 'M8 17h2' },
    { d: 'M14 17h2' },
  ],
  presentation: [{ d: 'M2 3h20' }, { d: 'M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3' }, { d: 'm7 21 5-5 5 5' }],
} as const satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'name'> {
  name: IconName;
  size?: number;
}

/** Decorative by default (aria-hidden); give the parent control an accessible name. */
export function Icon({ name, size = 20, className, ...rest }: IconProps) {
  const shapes: readonly Shape[] = ICONS[name];
  return (
    <svg
      className={['ui-icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {shapes.map((s, i) =>
        'd' in s ? (
          <path key={i} d={s.d} />
        ) : (
          <circle key={i} cx={s.circle[0]} cy={s.circle[1]} r={s.circle[2]} />
        )
      )}
    </svg>
  );
}
