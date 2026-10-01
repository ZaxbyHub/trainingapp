/** Space-joined IDREF list; caller-provided ids are kept, not overridden. */
export function mergeIds(...ids: Array<string | undefined>): string | undefined {
  const merged = ids.filter(Boolean).join(' ');
  return merged || undefined;
}

/** Join truthy class names. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
