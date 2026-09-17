export const NOT_AVAILABLE = "NOT_AVAILABLE";

export const PROVIDERS = Object.freeze(["openai", "anthropic"]);
export const INTERRUPTION_CATEGORIES = Object.freeze([
  "connection",
  "provider_error",
  "rate_limit",
  "timeout",
  "other",
  NOT_AVAILABLE,
]);

function isCount(value) {
  return value === NOT_AVAILABLE || (Number.isInteger(value) && value >= 0);
}

function isTimestamp(value) {
  return value === NOT_AVAILABLE || (
    typeof value === "string" && Number.isFinite(Date.parse(value))
  );
}

function assertExactKeys(value, keys, label) {
  const expected = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));
  if (unexpected.length) throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(", ")}`);
}

export function assertTelemetryEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("telemetry event must be an object");
  }
  assertExactKeys(event, [
    "event_version", "observed_at", "provider", "model", "usage", "capacity", "interruptions",
  ], "telemetry event");
  if (event.event_version !== 1) throw new TypeError("event_version must be 1");
  if (!PROVIDERS.includes(event.provider)) throw new TypeError("unsupported provider");
  if (typeof event.model !== "string" || !event.model.trim()) {
    throw new TypeError("model must be a non-empty string");
  }
  if (!isTimestamp(event.observed_at) || event.observed_at === NOT_AVAILABLE) {
    throw new TypeError("observed_at must be an ISO-8601 timestamp");
  }

  const requiredUsage = [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
  ];
  if (!event.usage || typeof event.usage !== "object") {
    throw new TypeError("usage must be an object");
  }
  assertExactKeys(event.usage, requiredUsage, "usage");
  for (const key of requiredUsage) {
    if (!isCount(event.usage[key])) throw new TypeError(`usage.${key} must be a non-negative integer or ${NOT_AVAILABLE}`);
  }

  if (!event.capacity || typeof event.capacity !== "object") {
    throw new TypeError("capacity must be an object");
  }
  if (event.capacity.status === "AVAILABLE") {
    assertExactKeys(event.capacity, ["status", "windows"], "capacity");
    if (!Array.isArray(event.capacity.windows) || event.capacity.windows.length === 0) {
      throw new TypeError("available capacity must contain at least one window");
    }
    for (const window of event.capacity.windows) {
      assertExactKeys(window, ["label", "remaining_percent", "reset_at"], "capacity window");
      if (typeof window.label !== "string" || !window.label.trim()) {
        throw new TypeError("capacity window label must be a non-empty string");
      }
      if (typeof window.remaining_percent !== "number" || window.remaining_percent < 0 || window.remaining_percent > 100) {
        throw new TypeError("capacity remaining_percent must be between 0 and 100");
      }
      if (!isTimestamp(window.reset_at)) {
        throw new TypeError(`capacity reset_at must be an ISO-8601 timestamp or ${NOT_AVAILABLE}`);
      }
    }
  } else if (event.capacity.status === NOT_AVAILABLE) {
    assertExactKeys(event.capacity, ["status"], "capacity");
  } else {
    throw new TypeError(`capacity.status must be AVAILABLE or ${NOT_AVAILABLE}`);
  }

  if (!event.interruptions || typeof event.interruptions !== "object") {
    throw new TypeError("interruptions must be an object");
  }
  assertExactKeys(event.interruptions, ["count", "last_category"], "interruptions");
  if (!Number.isInteger(event.interruptions.count) || event.interruptions.count < 0) {
    throw new TypeError("interruptions.count must be a non-negative integer");
  }
  if (!INTERRUPTION_CATEGORIES.includes(event.interruptions.last_category)) {
    throw new TypeError("unsupported interruption category");
  }
  return event;
}
