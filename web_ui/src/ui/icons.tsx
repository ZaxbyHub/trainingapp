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
