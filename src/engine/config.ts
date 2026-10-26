export const SENTENCE_GAP_MS = 250;
export const PARAGRAPH_GAP_MS = 600;
export const SAVE_INTERVAL_MS = 5000;
export const HEARTBEAT_MS = 10000;
export const SEEK_STEP_S = 15;
/** Target audio length of one segment when no override applies. A segment closes once clips and gaps reach this. */
export const SEGMENT_TARGET_S = 60;

/**
 * 60 s. End-to-end builds (VITE_E2E) accept `?segmentSeconds=<n>` so tests use short segments.
 * The caller passes `location.search` and the e2e flag. The override applies only when `e2e` is true.
 */
export function segmentTargetSeconds(search: string, e2e: boolean): number {
  if (e2e) {
    const override = Number(new URLSearchParams(search).get("segmentSeconds"));
    if (Number.isFinite(override) && override > 0) return override;
  }
  return SEGMENT_TARGET_S;
}

/** The generator stays at most this many ready segments ahead of the playing one. */
export const SEGMENTS_AHEAD = 2;
/** Already-played segments kept in memory behind the playing one. Older ones lose their audio. */
export const SEGMENTS_BEHIND = 3;

export const SPEED_MIN = 0.75;
export const SPEED_MAX = 2;

/** Longest wait for a voice init. A model download on a slow phone can take long. */
export const INIT_TIMEOUT_MS = 120_000;

export const STUCK_CHECK_MS = 1500;
export const SNAPSHOT_MS = 500;
export const MAX_RECOVERY_ATTEMPTS = 2;

export const METADATA_TIMEOUT_MS = 5000;

export const PAUSE_IGNORE_MS = 100;
