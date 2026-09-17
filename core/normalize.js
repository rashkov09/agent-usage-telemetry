import { INTERRUPTION_CATEGORIES, NOT_AVAILABLE } from "./schema.js";

export function exactCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : NOT_AVAILABLE;
}

export function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.valueOf()) ? NOT_AVAILABLE : date.toISOString();
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return NOT_AVAILABLE;
}

export function unavailableCapacity() {
  return { status: NOT_AVAILABLE };
}

export function normalizeCapacityWindows(windows) {
  if (!Array.isArray(windows)) return unavailableCapacity();
  const normalized = windows.flatMap((window) => {
    if (!window || typeof window !== "object" || typeof window.label !== "string" || !window.label.trim()) return [];
    const remaining = typeof window.remaining_percent === "number"
      ? window.remaining_percent
      : typeof window.used_percent === "number"
        ? 100 - window.used_percent
        : NOT_AVAILABLE;
    if (typeof remaining !== "number" || remaining < 0 || remaining > 100) return [];
    return [{
      label: window.label.trim(),
      remaining_percent: remaining,
      reset_at: normalizeTimestamp(window.reset_at),
    }];
  });
  return normalized.length
    ? { status: "AVAILABLE", windows: normalized }
    : unavailableCapacity();
}

export function normalizeInterruptions(input) {
  if (!input || typeof input !== "object") {
    return { count: 0, last_category: NOT_AVAILABLE };
  }
  const count = Number.isInteger(input.count) && input.count >= 0
    ? input.count
    : input.occurred === true
      ? 1
      : 0;
  const category = INTERRUPTION_CATEGORIES.includes(input.category)
    ? input.category
    : NOT_AVAILABLE;
  return {
    count,
    last_category: count > 0 ? category : NOT_AVAILABLE,
  };
}
