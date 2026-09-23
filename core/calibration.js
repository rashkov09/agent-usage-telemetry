import { createHash } from "node:crypto";
import { NOT_AVAILABLE } from "./schema.js";

export const CALIBRATION_REASONS = Object.freeze([
  "INSUFFICIENT_SAMPLES",
  "INCOMPATIBLE_WINDOWS",
  "MISSING_TOKEN_DIMENSIONS",
  "MODEL_MIX_UNRESOLVED",
  "NO_CAPACITY_LABELS",
  "PROVIDER_MODEL_MISMATCH",
  "MISSING_BASELINE_OBSERVATION",
  "STALE_MODEL",
  "EVIDENCE_INCOMPLETE",
  "EVIDENCE_COMPLETENESS_NOT_AVAILABLE",
]);

export const CAPACITY_ESTIMATOR_VERSION = "t3-complete-evidence-nnls-v1";
export const MINIMUM_INDEPENDENT_WINDOWS = 8;

const OBSERVED_QUALITIES = new Set([
  "PROVIDER_REPORTED",
  "PROVIDER_CLIENT_REPORTED",
  "RUNTIME_REPORTED",
]);
const TOKEN_FEATURES = Object.freeze([
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function unavailable(reason, extra = {}) {
  return { availability: NOT_AVAILABLE, reason, ...extra };
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function protectedMinimum(builtInMinimum, requestedMinimum) {
  return Number.isInteger(requestedMinimum)
    ? Math.max(builtInMinimum, requestedMinimum)
    : builtInMinimum;
}

function hasCompleteAttributionEvidence(sample) {
  return sample.attribution_completeness === "COMPLETE" &&
    Array.isArray(sample.attribution_completeness_causes) && sample.attribution_completeness_causes.length === 0 &&
    Array.isArray(sample.attribution_evidence_ids) && sample.attribution_evidence_ids.length > 0 &&
    new Set(sample.attribution_evidence_ids).size === sample.attribution_evidence_ids.length &&
    Array.isArray(sample.attribution_evidence_sources) && sample.attribution_evidence_sources.length > 0 &&
    sample.attribution_evidence_sources.every((source) => source !== NOT_AVAILABLE) &&
    Array.isArray(sample.attribution_evidence_qualities) && sample.attribution_evidence_qualities.length > 0 &&
    sample.attribution_evidence_qualities.every((quality) => OBSERVED_QUALITIES.has(quality));
}

function strictTotal(records, key) {
  if (!records.length || records.some((record) => !isCount(record[key]))) return NOT_AVAILABLE;
  return records.reduce((total, record) => total + record[key], 0);
}

function intervalSeconds(records) {
  const intervals = records.map((record) => [Date.parse(record.started_at), Date.parse(record.ended_at)])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const current of intervals) {
    const previous = merged.at(-1);
    if (!previous || current[0] > previous[1]) merged.push([...current]);
    else previous[1] = Math.max(previous[1], current[1]);
  }
  return merged.reduce((total, [start, end]) => total + end - start, 0) / 1000;
}

function sameObservedEndpoint(left, right, key) {
  return left[key] !== NOT_AVAILABLE && left[key] === right[key];
}

export function deriveCapacityDelta(start, end) {
  if (!start || !end || !OBSERVED_QUALITIES.has(start.quality) || !OBSERVED_QUALITIES.has(end.quality)) {
    return unavailable("NO_CAPACITY_LABELS", { source: NOT_AVAILABLE });
  }
  if (!Number.isFinite(start.remaining_percent) || !Number.isFinite(end.remaining_percent)) {
    return unavailable("NO_CAPACITY_LABELS", { source: NOT_AVAILABLE });
  }
  const compatible = ["provider", "window_type", "window_id", "reset_at", "source", "quality"]
    .every((key) => sameObservedEndpoint(start, end, key));
  const startTime = Date.parse(start.observed_at);
  const endTime = Date.parse(end.observed_at);
  const resetTime = Date.parse(start.reset_at);
  if (!compatible || !Number.isFinite(startTime) || !Number.isFinite(endTime) ||
      !Number.isFinite(resetTime) || startTime >= endTime || endTime > resetTime ||
      end.remaining_percent > start.remaining_percent) {
    return unavailable("INCOMPATIBLE_WINDOWS", { source: NOT_AVAILABLE });
  }
  return {
    availability: "AVAILABLE",
    source: "DERIVED",
    observed_start_remaining_percent: start.remaining_percent,
    observed_end_remaining_percent: end.remaining_percent,
    observed_consumption_percent: round(start.remaining_percent - end.remaining_percent, 3),
  };
}

function matchingInterruptions(state, window, startTime, endTime) {
  return state.interruptions.filter((event) =>
    event.category === "PROVIDER_CAPACITY" && event.provider === window.provider &&
    (window.model === NOT_AVAILABLE || event.model === window.model) &&
    Date.parse(event.occurred_at) >= startTime && Date.parse(event.occurred_at) <= endTime &&
    (event.reset_at === NOT_AVAILABLE || window.reset_at === NOT_AVAILABLE || event.reset_at === window.reset_at));
}

function completenessForInterval(state, identity) {
  const evidence = (state.capacity_interval_evidence ?? []).filter((item) =>
    item.window_id === identity.window_id &&
    item.start_observation_id === identity.start_observation_id &&
    item.end_observation_id === identity.end_observation_id);
  if (!evidence.length) {
    return {
      status: NOT_AVAILABLE,
      causes: ["EVIDENCE_NOT_RECORDED"],
      evidence_ids: [],
      sources: [],
      qualities: [],
    };
  }
  const statuses = new Set(evidence.map((item) => item.status));
  return {
    status: statuses.has("INCOMPLETE") ? "INCOMPLETE"
      : statuses.has(NOT_AVAILABLE) ? NOT_AVAILABLE
        : "COMPLETE",
    causes: [...new Set(evidence.flatMap((item) => item.causes))].sort(),
    evidence_ids: evidence.map((item) => item.evidence_id).sort(),
    sources: [...new Set(evidence.map((item) => item.source))].sort(),
    qualities: [...new Set(evidence.map((item) => item.quality))].sort(),
  };
}

function sampleFromInterval(state, window, start, end, delta) {
  const startedAt = Date.parse(start.observed_at);
  const endedAt = Date.parse(end.observed_at);
  const overlappingSegments = state.segments.filter((segment) => {
    const segmentStartedAt = Date.parse(segment.started_at);
    const segmentEndedAt = Date.parse(segment.ended_at);
    return Number.isFinite(segmentStartedAt) && segmentStartedAt < endedAt &&
      (segment.ended_at === NOT_AVAILABLE || (Number.isFinite(segmentEndedAt) && segmentEndedAt > startedAt));
  });
  const unresolvedSegments = overlappingSegments.filter((segment) =>
    segment.ended_at === NOT_AVAILABLE || segment.provider === NOT_AVAILABLE);
  if (unresolvedSegments.length) {
    return unavailable("INCOMPATIBLE_WINDOWS", {
      window_id: window.window_id,
      start_observation_id: start.observation_id,
      end_observation_id: end.observation_id,
    });
  }

  const providerSegments = overlappingSegments.filter((segment) => segment.provider === window.provider);
  const crossing = providerSegments.filter((segment) =>
    Date.parse(segment.started_at) < startedAt || Date.parse(segment.ended_at) > endedAt);
  if (crossing.length) {
    return unavailable("INCOMPATIBLE_WINDOWS", {
      window_id: window.window_id,
      start_observation_id: start.observation_id,
      end_observation_id: end.observation_id,
    });
  }

  const segments = providerSegments.sort((left, right) =>
    left.started_at.localeCompare(right.started_at) || left.segment_id.localeCompare(right.segment_id));
  const models = [...new Set(segments.map((segment) => segment.model))].sort();
  const hasUnknownModel = models.includes(NOT_AVAILABLE);
  const knownModels = models.filter((model) => model !== NOT_AVAILABLE);
  const taskIds = [...new Set(segments.map((segment) => segment.task_id))].sort();
  const tasks = taskIds.map((taskId) => state.tasks.find((task) => task.task_id === taskId)).filter(Boolean);
  const taskClasses = [...new Set(tasks.map((task) => task.task_kind).filter((kind) => kind !== NOT_AVAILABLE))].sort();
  const tokenTotals = Object.fromEntries(TOKEN_FEATURES.map((key) => [key, strictTotal(segments, key)]));
  const hasAllTokenDimensions = TOKEN_FEATURES.every((key) => tokenTotals[key] !== NOT_AVAILABLE);
  const singleModel = !hasUnknownModel && knownModels.length === 1 ? knownModels[0] : NOT_AVAILABLE;
  const limitEvents = matchingInterruptions(state, window, startedAt, endedAt);
  const identity = {
    window_id: window.window_id,
    start_observation_id: start.observation_id,
    end_observation_id: end.observation_id,
  };
  const completeness = completenessForInterval(state, identity);
  const reason = completeness.status === "INCOMPLETE" ? "EVIDENCE_INCOMPLETE"
    : completeness.status === NOT_AVAILABLE ? "EVIDENCE_COMPLETENESS_NOT_AVAILABLE"
      : hasUnknownModel || knownModels.length > 1 ? "MODEL_MIX_UNRESOLVED"
        : singleModel === NOT_AVAILABLE || !hasAllTokenDimensions ? "MISSING_TOKEN_DIMENSIONS"
          : NOT_AVAILABLE;

  return {
    sample_id: `cal-${digest(identity).slice(0, 24)}`,
    provider: window.provider,
    model: singleModel,
    model_mix: models,
    window_type: window.window_type,
    window_id: window.window_id,
    started_at: start.observed_at,
    ended_at: end.observed_at,
    observed_start_remaining_percent: delta.observed_start_remaining_percent,
    observed_end_remaining_percent: delta.observed_end_remaining_percent,
    observed_consumption_percent: delta.observed_consumption_percent,
    ...tokenTotals,
    active_execution_seconds: segments.length ? intervalSeconds(segments) : NOT_AVAILABLE,
    segment_count: segments.length,
    task_count: taskIds.length,
    task_class: taskIds.length === 1 && taskClasses.length === 1 ? taskClasses[0] : NOT_AVAILABLE,
    capacity_limit_reached: limitEvents.length > 0,
    capacity_limit_event_ids: limitEvents.map((event) => event.event_id).sort(),
    evidence_source: start.source,
    evidence_quality: start.quality,
    endpoint_evidence_class: "OBSERVED",
    consumption_evidence_class: "DERIVED",
    attribution_completeness: completeness.status,
    attribution_completeness_causes: completeness.causes,
    attribution_evidence_ids: completeness.evidence_ids,
    attribution_evidence_sources: completeness.sources,
    attribution_evidence_qualities: completeness.qualities,
    usable_for_single_model_estimator: reason === NOT_AVAILABLE,
    unusable_reason: reason,
  };
}

function capacityLimitAnchors(state) {
  return state.interruptions.filter((event) => event.category === "PROVIDER_CAPACITY")
    .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id))
    .map((event) => {
      const matches = state.capacity_windows.filter((window) =>
        window.provider === event.provider &&
        (event.model === NOT_AVAILABLE || window.model === NOT_AVAILABLE || window.model === event.model) &&
        event.reset_at !== NOT_AVAILABLE && window.reset_at === event.reset_at);
      const window = matches.length === 1 ? matches[0] : undefined;
      return {
        anchor_id: `limit-${digest({ event_id: event.event_id }).slice(0, 24)}`,
        provider: event.provider,
        model: event.model,
        window_type: window?.window_type ?? NOT_AVAILABLE,
        window_id: window?.window_id ?? NOT_AVAILABLE,
        occurred_at: event.occurred_at,
        reset_at: event.reset_at,
        evidence_source: event.source,
        evidence_quality: event.quality,
        evidence_class: "OBSERVED",
        capacity_limit_reached: true,
        quota_exhaustion_percent: NOT_AVAILABLE,
      };
    });
}

export function buildCalibrationDataset(projection) {
  const state = projection.toJSON();
  const samples = [];
  const rejections = [];
  for (const window of state.capacity_windows) {
    const observations = state.capacity_observations.filter((observation) => observation.window_id === window.window_id)
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at) || left.observation_id.localeCompare(right.observation_id));
    for (let index = 1; index < observations.length; index += 1) {
      const start = observations[index - 1];
      const end = observations[index];
      if (window.reset_at === NOT_AVAILABLE || start.reset_at !== window.reset_at || end.reset_at !== window.reset_at) {
        rejections.push({
          window_id: window.window_id,
          start_observation_id: start.observation_id,
          end_observation_id: end.observation_id,
          reason: "INCOMPATIBLE_WINDOWS",
        });
        continue;
      }
      const delta = deriveCapacityDelta(start, end);
      if (delta.availability === NOT_AVAILABLE) {
        rejections.push({
          window_id: window.window_id,
          start_observation_id: start.observation_id,
          end_observation_id: end.observation_id,
          reason: delta.reason,
        });
        continue;
      }
      const sample = sampleFromInterval(state, window, start, end, delta);
      if (sample.availability === NOT_AVAILABLE) rejections.push(sample);
      else samples.push(sample);
    }
  }
  const unique = new Map(samples.map((sample) => [sample.sample_id, sample]));
  return {
    calibration_dataset_version: 2,
    samples: [...unique.values()].sort((left, right) => left.sample_id.localeCompare(right.sample_id)),
    capacity_limit_anchors: capacityLimitAnchors(state),
    rejections: rejections.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

function eligibleSamples(samples, scope) {
  return [...new Map(samples.map((sample) => [sample.sample_id, sample])).values()].filter((sample) =>
    sample.provider === scope.provider && sample.model === scope.model && sample.window_type === scope.window_type &&
    hasCompleteAttributionEvidence(sample) &&
    sample.usable_for_single_model_estimator === true && Number.isFinite(sample.observed_consumption_percent) &&
    TOKEN_FEATURES.every((key) => isCount(sample[key])));
}

function featureNamesFor(samples) {
  return [...TOKEN_FEATURES];
}

function fitNnls(samples, featureNames) {
  const scales = Object.fromEntries(featureNames.map((name) => {
    const positives = samples.map((sample) => sample[name]).filter((value) => value > 0);
    return [name, positives.length ? median(positives) : 1];
  }));
  const names = ["intercept", ...featureNames];
  const rows = samples.map((sample) => [1, ...featureNames.map((name) => sample[name] / scales[name])]);
  const labels = samples.map((sample) => sample.observed_consumption_percent);
  const coefficients = [median(labels), ...featureNames.map(() => 0)];
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    for (let column = 0; column < names.length; column += 1) {
      let numerator = 0;
      let denominator = 0;
      for (let row = 0; row < rows.length; row += 1) {
        const without = coefficients.reduce((total, coefficient, index) =>
          index === column ? total : total + coefficient * rows[row][index], 0);
        numerator += rows[row][column] * (labels[row] - without);
        denominator += rows[row][column] ** 2;
      }
      coefficients[column] = denominator ? Math.max(0, numerator / denominator) : 0;
    }
  }
  return {
    coefficients: Object.fromEntries(names.map((name, index) => [name, round(coefficients[index], 12)])),
    feature_scales: Object.fromEntries(Object.entries(scales).map(([name, value]) => [name, round(value, 6)])),
  };
}

function predict(fit, featureNames, workload) {
  return Math.max(0, Math.min(100, fit.coefficients.intercept + featureNames.reduce((total, name) =>
    total + fit.coefficients[name] * workload[name] / fit.feature_scales[name], 0)));
}

function validationMetrics(samples, featureNames) {
  const windows = [...new Set(samples.map((sample) => sample.window_id))].sort();
  const errors = [];
  for (const windowId of windows) {
    const training = samples.filter((sample) => sample.window_id !== windowId);
    const testing = samples.filter((sample) => sample.window_id === windowId);
    if (!training.length) continue;
    const fit = fitNnls(training, featureNames);
    for (const sample of testing) errors.push(Math.abs(predict(fit, featureNames, sample) - sample.observed_consumption_percent));
  }
  if (!errors.length) return NOT_AVAILABLE;
  return {
    method: "LEAVE_ONE_WINDOW_OUT",
    mean_absolute_percentage_point_error: round(errors.reduce((sum, value) => sum + value, 0) / errors.length, 1),
    median_absolute_percentage_point_error: round(median(errors), 1),
    max_absolute_percentage_point_error: round(Math.max(...errors), 1),
    sample_count: errors.length,
  };
}

function confidenceFor(independentWindows, metrics) {
  if (metrics === NOT_AVAILABLE) return "LOW";
  const mae = metrics.mean_absolute_percentage_point_error;
  if (independentWindows >= 25 && mae <= 5 && metrics.max_absolute_percentage_point_error <= 15) return "HIGH";
  if (independentWindows >= 12 && mae <= 10) return "MEDIUM";
  return "LOW";
}

function trainingIdentity(samples, scope) {
  return digest({
    model_version: CAPACITY_ESTIMATOR_VERSION,
    scope,
    samples: samples.map((sample) => Object.fromEntries([
      ["sample_id", sample.sample_id],
      ["window_id", sample.window_id],
      ["observed_consumption_percent", sample.observed_consumption_percent],
      ...TOKEN_FEATURES.map((key) => [key, sample[key]]),
      ["attribution_completeness", sample.attribution_completeness],
      ["attribution_evidence_ids", sample.attribution_evidence_ids],
      ["attribution_evidence_sources", sample.attribution_evidence_sources],
      ["attribution_evidence_qualities", sample.attribution_evidence_qualities],
    ])).sort((left, right) => left.sample_id.localeCompare(right.sample_id)),
  });
}

export function trainCapacityEstimator(samples, scope, { minimumIndependentWindows = MINIMUM_INDEPENDENT_WINDOWS, generatedAt = NOT_AVAILABLE } = {}) {
  const requiredWindows = protectedMinimum(MINIMUM_INDEPENDENT_WINDOWS, minimumIndependentWindows);
  const selected = eligibleSamples(samples, scope);
  const labeledScopeSamples = [...new Map(samples.map((sample) => [sample.sample_id, sample])).values()].filter((sample) =>
    sample.provider === scope.provider && sample.window_type === scope.window_type &&
    Number.isFinite(sample.observed_consumption_percent));
  const windows = [...new Set(selected.map((sample) => sample.window_id))].sort();
  const common = {
    provider: scope.provider,
    model: scope.model,
    window_type: scope.window_type,
    source: "ESTIMATED",
    model_version: CAPACITY_ESTIMATOR_VERSION,
    method: "NON_NEGATIVE_LINEAR_COORDINATE_DESCENT",
    minimum_independent_windows: requiredWindows,
    sample_count: selected.length,
    independent_window_count: windows.length,
    generated_at: generatedAt,
  };
  if (!selected.length) {
    const reason = labeledScopeSamples.some((sample) => sample.model === scope.model && (
      sample.attribution_completeness === "INCOMPLETE" || sample.unusable_reason === "EVIDENCE_INCOMPLETE"))
      ? "EVIDENCE_INCOMPLETE"
      : labeledScopeSamples.some((sample) => sample.model === scope.model && (
        !hasCompleteAttributionEvidence(sample) || sample.unusable_reason === "EVIDENCE_COMPLETENESS_NOT_AVAILABLE"))
        ? "EVIDENCE_COMPLETENESS_NOT_AVAILABLE"
        : labeledScopeSamples.some((sample) => sample.unusable_reason === "MODEL_MIX_UNRESOLVED")
          ? "MODEL_MIX_UNRESOLVED"
          : labeledScopeSamples.some((sample) => sample.model === scope.model && sample.unusable_reason === "MISSING_TOKEN_DIMENSIONS")
            ? "MISSING_TOKEN_DIMENSIONS"
            : "NO_CAPACITY_LABELS";
    return unavailable(reason, common);
  }
  if (windows.length < requiredWindows) return unavailable("INSUFFICIENT_SAMPLES", common);
  const featureNames = featureNamesFor(selected);
  const fit = fitNnls(selected, featureNames);
  const validationError = validationMetrics(selected, featureNames);
  return {
    availability: "AVAILABLE",
    ...common,
    feature_names: featureNames,
    coefficients: fit.coefficients,
    feature_scales: fit.feature_scales,
    feature_ranges: Object.fromEntries(featureNames.map((name) => [name, {
      min: Math.min(...selected.map((sample) => sample[name])),
      max: Math.max(...selected.map((sample) => sample[name])),
    }])),
    validation_error: validationError,
    confidence: confidenceFor(windows.length, validationError),
    training_data_digest: trainingIdentity(selected, scope),
  };
}

export function isEstimatorArtifactStale(artifact, samples) {
  if (!artifact || artifact.availability !== "AVAILABLE") return true;
  const scope = { provider: artifact.provider, model: artifact.model, window_type: artifact.window_type };
  return artifact.model_version !== CAPACITY_ESTIMATOR_VERSION ||
    artifact.training_data_digest !== trainingIdentity(eligibleSamples(samples, scope), scope);
}

export function estimateCapacity(artifact, request) {
  const observed = Number.isFinite(request.observed_remaining_percent)
    ? { source: "OBSERVED", remaining_percent: request.observed_remaining_percent }
    : { source: NOT_AVAILABLE, remaining_percent: NOT_AVAILABLE };
  const common = {
    provider: request.provider,
    model: request.model,
    window_type: request.window_type,
    observed,
    estimated: { source: NOT_AVAILABLE, remaining_percent: NOT_AVAILABLE, consumption_percent: NOT_AVAILABLE },
    model_version: artifact?.model_version ?? CAPACITY_ESTIMATOR_VERSION,
    method: artifact?.method ?? NOT_AVAILABLE,
    sample_count: artifact?.sample_count ?? 0,
    validation_error: artifact?.validation_error ?? NOT_AVAILABLE,
    generated_at: request.generated_at ?? NOT_AVAILABLE,
  };
  if (!artifact || artifact.availability !== "AVAILABLE") {
    return unavailable(artifact?.reason ?? "INSUFFICIENT_SAMPLES", { ...common, confidence: "LOW" });
  }
  if (artifact.model_version !== CAPACITY_ESTIMATOR_VERSION) {
    return unavailable("STALE_MODEL", { ...common, confidence: "LOW" });
  }
  if (artifact.provider !== request.provider || artifact.model !== request.model || artifact.window_type !== request.window_type) {
    return unavailable("PROVIDER_MODEL_MISMATCH", { ...common, confidence: "LOW" });
  }
  if (request.training_data_digest && request.training_data_digest !== artifact.training_data_digest) {
    return unavailable("STALE_MODEL", { ...common, confidence: "LOW" });
  }
  if (artifact.feature_names.some((name) => !Number.isFinite(request.workload?.[name]) || request.workload[name] < 0)) {
    return unavailable("MISSING_TOKEN_DIMENSIONS", { ...common, confidence: "LOW" });
  }
  if (!Number.isFinite(request.baseline_remaining_percent)) {
    return unavailable("MISSING_BASELINE_OBSERVATION", { ...common, confidence: "LOW" });
  }
  const consumption = predict(artifact, artifact.feature_names, request.workload);
  const outsideRange = artifact.feature_names.some((name) => {
    const range = artifact.feature_ranges[name];
    return request.workload[name] < range.min / 2 || request.workload[name] > Math.max(1, range.max * 2);
  });
  return {
    availability: "AVAILABLE",
    ...common,
    estimated: {
      source: "ESTIMATED",
      remaining_percent: Math.round(Math.max(0, request.baseline_remaining_percent - consumption)),
      consumption_percent: Math.round(consumption),
    },
    confidence: outsideRange ? "LOW" : artifact.confidence,
    training_data_digest: artifact.training_data_digest,
    reason: NOT_AVAILABLE,
  };
}

export function summarizeTaskClassCapacity(samples, scope, taskClass, { minimumIndependentWindows = 3 } = {}) {
  const requiredWindows = protectedMinimum(3, minimumIndependentWindows);
  const candidates = [...new Map(samples.map((sample) => [sample.sample_id, sample])).values()].filter((sample) =>
    sample.provider === scope.provider && sample.model === scope.model && sample.window_type === scope.window_type &&
    sample.task_count === 1 && sample.task_class === taskClass && Number.isFinite(sample.observed_consumption_percent));
  const selected = eligibleSamples(samples, scope).filter((sample) =>
    sample.task_count === 1 && sample.task_class === taskClass);
  const windows = new Set(selected.map((sample) => sample.window_id));
  const common = {
    provider: scope.provider,
    model: scope.model,
    window_type: scope.window_type,
    task_class: taskClass,
    source: selected.length ? "DERIVED" : NOT_AVAILABLE,
    sample_count: selected.length,
    independent_window_count: windows.size,
  };
  if (!selected.length) {
    const reason = candidates.some((sample) => sample.attribution_completeness === "INCOMPLETE")
      ? "EVIDENCE_INCOMPLETE"
      : candidates.some((sample) => !hasCompleteAttributionEvidence(sample))
        ? "EVIDENCE_COMPLETENESS_NOT_AVAILABLE"
        : "NO_CAPACITY_LABELS";
    return unavailable(reason, common);
  }
  if (windows.size < requiredWindows) return unavailable("INSUFFICIENT_SAMPLES", common);
  const values = selected.map((sample) => sample.observed_consumption_percent);
  return {
    availability: "AVAILABLE",
    ...common,
    median_observed_consumption_percent: round(median(values), 1),
    min_observed_consumption_percent: round(Math.min(...values), 1),
    max_observed_consumption_percent: round(Math.max(...values), 1),
    confidence: windows.size >= 20 ? "HIGH" : windows.size >= 8 ? "MEDIUM" : "LOW",
    reason: NOT_AVAILABLE,
  };
}

export function renderCalibrationSummary(projection) {
  const dataset = buildCalibrationDataset(projection);
  const state = projection.toJSON();
  const scopes = new Map();
  for (const window of state.capacity_windows) {
    const key = `${window.provider}\u0000${window.model}\u0000${window.window_type}`;
    scopes.set(key, { provider: window.provider, model: window.model, window_type: window.window_type });
  }
  const lines = ["CAPACITY CALIBRATION SUMMARY"];
  for (const scope of [...scopes.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))) {
    const windows = state.capacity_windows.filter((window) =>
      window.provider === scope.provider && window.model === scope.model && window.window_type === scope.window_type);
    const observations = state.capacity_observations.filter((observation) =>
      windows.some((window) => window.window_id === observation.window_id) && OBSERVED_QUALITIES.has(observation.quality))
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at));
    const samples = dataset.samples.filter((sample) =>
      sample.provider === scope.provider && sample.window_type === scope.window_type &&
      (scope.model === NOT_AVAILABLE || sample.model === scope.model));
    const completeSamples = samples.filter((sample) => sample.attribution_completeness === "COMPLETE");
    const incompleteSamples = samples.filter((sample) => sample.attribution_completeness === "INCOMPLETE");
    const unknownSamples = samples.filter((sample) => sample.attribution_completeness === NOT_AVAILABLE);
    const estimator = trainCapacityEstimator(dataset.samples, scope);
    const latest = observations.at(-1);
    lines.push(
      "",
      `${scope.provider} / ${scope.model} / ${scope.window_type}`,
      `OBSERVED windows: ${windows.length}`,
      `OBSERVED latest remaining: ${latest?.remaining_percent ?? NOT_AVAILABLE}`,
      `OBSERVED reset_at: ${latest?.reset_at ?? NOT_AVAILABLE}`,
      `DERIVED calibration samples: ${samples.length}`,
      `DERIVED COMPLETE attribution samples: ${completeSamples.length}`,
      `DERIVED INCOMPLETE attribution samples: ${incompleteSamples.length}`,
      `NOT_AVAILABLE attribution samples: ${unknownSamples.length}`,
      `ESTIMATED availability: ${estimator.availability}`,
      `ESTIMATED confidence: ${estimator.confidence ?? "LOW"}`,
      `ESTIMATED validation error: ${estimator.validation_error === NOT_AVAILABLE ? NOT_AVAILABLE : `${estimator.validation_error.mean_absolute_percentage_point_error}pp MAE`}`,
      `NOT_AVAILABLE reason: ${estimator.availability === NOT_AVAILABLE ? estimator.reason : NOT_AVAILABLE}`,
    );
  }
  if (scopes.size === 0) lines.push(
    "",
    "OBSERVED windows: 0",
    "DERIVED calibration samples: 0",
    "DERIVED COMPLETE attribution samples: 0",
    "DERIVED INCOMPLETE attribution samples: 0",
    "NOT_AVAILABLE attribution samples: 0",
    `ESTIMATED availability: ${NOT_AVAILABLE}`,
    "ESTIMATED confidence: LOW",
    "ESTIMATED validation error: NOT_AVAILABLE",
    "NOT_AVAILABLE reason: NO_CAPACITY_LABELS",
  );
  lines.push("", `OBSERVED capacity-limit anchors: ${dataset.capacity_limit_anchors.length}`);
  return lines.join("\n");
}

// T1 compatibility seam. T2's built-in estimator only consumes samples produced
// by buildCalibrationDataset.
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
