/**
 * Horizontal collision handling for Tooltip. The tooltip is centred under its
 * trigger with CSS; this returns the px shift (applied as --ui-tooltip-shift)
 * that pulls it back inside the viewport, so showing it never creates
 * horizontal overflow (design-language.md section 3.5 no-horizontal-scroll).
 * `rect` must be measured with no shift applied.
 */
export function computeTooltipShift(
  rect: { left: number; right: number },
  viewportWidth: number,
  margin = 8
): number {
  const width = rect.right - rect.left;
  if (width > viewportWidth - 2 * margin) return margin - rect.left; // cannot fit: pin to the left edge
  if (rect.left < margin) return margin - rect.left;
  if (rect.right > viewportWidth - margin) return viewportWidth - margin - rect.right;
  return 0;
}
