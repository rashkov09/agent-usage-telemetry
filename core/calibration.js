import { NOT_AVAILABLE } from "./schema.js";

export function buildCalibrationInput(projection, windowId) {
  const summary = projection.capacityWindowSummary(windowId);
  if (!summary) throw new Error(`unknown capacity window: ${windowId}`);
  return {
    calibration_version: 1,
    window_id: summary.window_id,
    provider: summary.provider,
    model: summary.model,
    window_type: summary.window_type,
    started_at: summary.started_at,
    reset_at: summary.reset_at,
    ended_at: summary.ended_at,
    overlapping_segment_ids: summary.overlapping_segment_ids,
    crossing_segment_ids: summary.crossing_segment_ids,
    input_tokens: summary.input_tokens,
    output_tokens: summary.output_tokens,
    cache_read_tokens: summary.cache_read_tokens,
    cache_write_tokens: summary.cache_write_tokens,
    capacity_observation_ids: summary.observation_ids,
    limit_event_ids: summary.limit_event_ids,
  };
}

export function runCapacityEstimator(calibrationInput, estimator) {
  if (typeof estimator !== "function") throw new TypeError("estimator must be a function");
  const estimate = estimator(structuredClone(calibrationInput));
  if (!estimate || typeof estimate !== "object" || Array.isArray(estimate)) {
    throw new TypeError("estimator must return an object");
  }
  const expected = new Set(["used_percent", "remaining_percent", "confidence", "estimator_id"]);
  const unexpected = Object.keys(estimate).filter((key) => !expected.has(key));
  if (unexpected.length) throw new TypeError(`estimate contains unsupported fields: ${unexpected.join(", ")}`);
  for (const key of ["used_percent", "remaining_percent"]) {
    const value = estimate[key];
    if (value !== NOT_AVAILABLE && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
      throw new TypeError(`${key} must be 0..100 or ${NOT_AVAILABLE}`);
    }
  }
  if (typeof estimate.confidence !== "number" || !Number.isFinite(estimate.confidence) || estimate.confidence < 0 || estimate.confidence > 1) {
    throw new TypeError("estimate confidence must be 0..1");
  }
  if (typeof estimate.estimator_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(estimate.estimator_id)) {
    throw new TypeError("estimator_id must be a sanitized identifier");
  }
  return { ...estimate, quality: "ESTIMATED" };
}
