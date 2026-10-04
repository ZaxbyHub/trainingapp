// Per-course training progress (Lumen phase 6, design-language.md section 5:
// course card "progress"): the furthest slide position the learner has reached,
// persisted in localStorage next to the last-opened course.
//
// Pure helpers over a plain map; TrainingPage owns the state and calls
// saveCourseProgress. Positions are the 1-based spine positions from
// slide-position.ts, so progress is only ever recorded when a position is KNOWN
// (never in the desktop renderer, never before the slide docs are ready).
import { TRAINING_PROGRESS_KEY, USER_SETTINGS_CLEARED_EVENT } from '../storage/persisted-keys';

/** courseId -> furthest 1-based slide position reached. */
export type CourseProgress = Readonly<Record<string, number>>;

/** Read the stored progress; anything malformed or unreadable is dropped. */
export function loadCourseProgress(): CourseProgress {
  try {
    const raw = window.localStorage.getItem(TRAINING_PROGRESS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [courseId, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) out[courseId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * True iff a progress map is stored at all. An ABSENT key means the progress was cleared
 * (Clear Cache in any tab): a clobbering write always writes a map, never removes the key.
 * Readable immediately, unlike the `storage` event, which arrives as a later task.
 */
export function hasStoredCourseProgress(): boolean {
  try {
    return window.localStorage.getItem(TRAINING_PROGRESS_KEY) !== null;
  } catch {
    return false;
  }
}

export function saveCourseProgress(progress: CourseProgress): void {
  try {
    window.localStorage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // storage may be unavailable (privacy mode); progress still shows this session
  }
}

/**
 * Record that `position` was reached in `courseId`. Progress only moves forward:
 * returns the SAME object when `position` is not beyond the stored furthest one.
 */
export function advanceCourseProgress(progress: CourseProgress, courseId: string, position: number): CourseProgress {
  if (!courseId || !Number.isInteger(position) || position < 1) return progress;
  if ((progress[courseId] ?? 0) >= position) return progress;
  return { ...progress, [courseId]: position };
}

/**
 * Per-course max of two progress maps (progress only moves forward, so the larger
 * value is always the truer one). Returns `current` itself when `incoming` adds
 * nothing, so a state update with it is a no-op. Used to fold in what another tab
 * wrote to storage before this tab records its own position.
 */
export function mergeCourseProgress(current: CourseProgress, incoming: CourseProgress): CourseProgress {
  let merged: Record<string, number> | null = null;
  for (const [courseId, position] of Object.entries(incoming)) {
    if ((current[courseId] ?? 0) >= position) continue;
    merged ??= { ...current };
    merged[courseId] = position;
  }
  return merged ?? current;
}

/**
 * Follow changes to the stored progress that this tab did not make itself (the
 * `storage` event only ever fires for OTHER tabs' writes), plus Clear Cache in this
 * tab. `onChange(map)` carries what another tab wrote; `onChange(null)` means the
 * stored progress was CLEARED (key removed, or the whole storage emptied), so the
 * listener must drop what it holds in memory rather than keep showing - or later
 * re-persisting - progress the user just cleared. Returns the unsubscribe.
 */
export function subscribeCourseProgress(onChange: (stored: CourseProgress | null) => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    // sessionStorage changes are not ours (the registry keeps this key in localStorage only).
    if (event.storageArea !== null && event.storageArea === window.sessionStorage) return;
    if (event.key === null) {
      onChange(null); // storage.clear()
      return;
    }
    if (event.key !== TRAINING_PROGRESS_KEY) return;
    onChange(event.newValue === null ? null : loadCourseProgress());
  };
  const onCleared = (): void => onChange(null);
  window.addEventListener('storage', onStorage);
  window.addEventListener(USER_SETTINGS_CLEARED_EVENT, onCleared);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(USER_SETTINGS_CLEARED_EVENT, onCleared);
  };
}

export interface CourseProgressView {
  /** Slides reached, clamped to [0, total] (a course can shrink in an update). */
  reached: number;
  total: number;
}

/** What a card shows; null when the slide count is unknown (nothing is guessed). */
export function courseProgressView(
  progress: CourseProgress,
  courseId: string,
  total: number | null
): CourseProgressView | null {
  if (total === null || total < 1) return null;
  return { reached: Math.min(progress[courseId] ?? 0, total), total };
}
