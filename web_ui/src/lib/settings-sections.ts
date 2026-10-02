/**
 * Settings section ids that other pages can navigate to (settings-wiring-
 * honesty). App passes the requested id to SettingsPage, which scrolls to the
 * element with that id and focuses its heading.
 */

/**
 * The section that hosts the external-model (OpenAI- or Anthropic-compatible
 * endpoint: local server, LAN or cloud) controls. Whichever section hosts
 * those controls carries this id; today that is the always-rendered External
 * model section (components/ExternalModelSection.tsx) in both apps.
 */
export const MODEL_CONNECTION_SECTION_ID = 'model-connection';
