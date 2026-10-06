/**
 * spec-pattern.ts: the ONE definition of which files are Playwright specs for the desktop e2e
 * suite. playwright.config.ts uses it as `testMatch` and launch-helpers.spec.ts uses it for the
 * structural launch guard, so Playwright can never collect a spec the guard does not scan.
 */
export const SPEC_FILE_PATTERN = /\.spec\.[cm]?[jt]s$/;
