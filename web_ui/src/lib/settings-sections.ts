/**
 * Settings section ids that other pages can navigate to (settings-wiring-
 * honesty). App passes the requested id to SettingsPage, which scrolls to the
 * element with that id and focuses its heading.
 */

/**
 * The section that hosts the external-model (local server / cloud,
 * OpenAI-compatible) controls. Whichever section hosts those controls carries
 * this id; today that is the always-rendered Inference Mode section, whose
 * "Provider server (OpenAI-compatible)" option is the external-model path.
 */
export const MODEL_CONNECTION_SECTION_ID = 'model-connection';
