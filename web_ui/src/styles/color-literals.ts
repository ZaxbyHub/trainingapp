/**
 * Lumen: shared color-literal matchers for the design-token guardrails (PRR-151-053).
 *
 * Imported only by tests (styles/token-ratchet.test.ts and the per-surface *-hygiene.test.ts
 * files). Not part of the app bundle. Keeping ONE definition stops the per-surface hygiene
 * tests from drifting behind the repo-wide ratchet (they used to match only hex / rgb / hsl,
 * so an `oklch(...)` literal passed them while failing the repo-wide scan).
 *
 * Color literals belong in styles/lumen-tokens.css only; everywhere else a color is a
 * `var(--token)` reference, a CSS system color (Highlight, CanvasText, ...), `transparent` or
 * `currentColor`. `color-mix(in srgb, var(--x) 70%, transparent)` is legal: it contains no
 * literal. `color-mix(in srgb, #fff 50%, red)` is not: its literals are matched individually.
 */

/** Hex, or any CSS color function. Non-global (safe for `.test` / `.exec`); wrap in `new RegExp(src, 'g')` to scan. */
export const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/;

/** CSS named colors (not system colors, `transparent` or `currentColor`, which stay legal). */
export const NAMED_COLORS: readonly string[] = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue',
  'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk',
  'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki',
  'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue',
  'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite',
  'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory',
  'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen',
  'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen',
  'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen',
  'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid',
  'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum',
  'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown',
  'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen',
];

const NAMED_COLOR_RE = new RegExp(`(?<![\\w-])(?:${NAMED_COLORS.join('|')})(?![\\w-])`, 'gi');

/** Properties whose value is (or may contain) a color. A named color elsewhere (font names, keywords) is not a color. */
const COLOR_PROPERTY =
  /^(?:color|background|background-color|background-image|border|border-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?(?:-color)?|border-color|outline|outline-color|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration|text-decoration-color|column-rule|column-rule-color|scrollbar-color|-webkit-text-fill-color)$/i;

/**
 * Named-color literals in the values of color-bearing declarations of one comment-stripped CSS
 * text. `var(--name` heads, `url(...)` and quoted strings are removed first, so `var(--red-ish)`
 * and `content: "red"` never match, while a `var(--x, red)` fallback still does. Custom-property
 * definitions are checked too: `--x: red` outside lumen-tokens.css is a literal in disguise.
 */
export function findNamedColors(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/(?:^|[;{}\s])(--[\w-]+|[\w-]+)\s*:\s*([^;{}]+)/g)) {
    if (!m[1].startsWith('--') && !COLOR_PROPERTY.test(m[1])) continue;
    const value = m[2]
      .replace(/url\([^)]*\)/gi, '')
      .replace(/var\(\s*--[\w-]+/gi, '')
      .replace(/"[^"]*"|'[^']*'/g, '');
    for (const hit of value.matchAll(NAMED_COLOR_RE)) out.push(hit[0]);
  }
  return out;
}
