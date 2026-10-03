/**
 * Settings section ids that other pages can navigate to (settings-wiring-
 * honesty). App passes the requested id to SettingsPage, which scrolls to the
 * element with that id and focuses its heading.
 */

/**
 * The section that hosts the generator choice and the external-model (OpenAI-
 * or Anthropic-compatible endpoint: local server, LAN or cloud) controls:
 * "Model & connection" (docs/design/design-language.md section 5), rendered by
 * components/ExternalModelSection.tsx in both apps. It is the model-blocked
 * overlay's destination and the footer connection chip's target.
 */
export const MODEL_CONNECTION_SECTION_ID = 'model-connection';

/**
 * The six Settings sections, in page order (design-language.md section 5). Each id
 * is the section element's id (an `initialSection` / in-page nav target); its h2 is
 * `${id}-heading`.
 */
export const SETTINGS_SECTIONS = [
  { id: MODEL_CONNECTION_SECTION_ID, label: 'Model & connection' },
  { id: 'answers', label: 'Answers' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'storage-privacy', label: 'Storage & privacy' },
  { id: 'updates', label: 'Updates' },
  { id: 'about', label: 'About' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/**
 * Scroll a Settings section into view and focus its heading (tabIndex -1) so
 * keyboard and screen-reader users land on the destination. Returns false when
 * the section is not in the DOM (nothing was focused).
 */
export function focusSettingsSection(sectionId: string): boolean {
  const target = document.getElementById(sectionId);
  if (target === null) return false;
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
  const heading = target.querySelector<HTMLElement>('h2');
  (heading ?? target).focus();
  return true;
}
