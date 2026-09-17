import { exactCount, normalizeCapacityWindows, normalizeInterruptions } from "../core/normalize.js";

export function normalizeOpenAIObservation(input = {}) {
  const usage = input.usage && typeof input.usage === "object" ? input.usage : {};
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details
    : {};
  return {
    provider: "openai",
    model: input.model,
    usage: {
      input_tokens: exactCount(usage.input_tokens),
      output_tokens: exactCount(usage.output_tokens),
      cache_read_tokens: exactCount(usage.cache_read_tokens ?? details.cached_tokens),
      cache_write_tokens: exactCount(usage.cache_write_tokens),
      total_tokens: exactCount(usage.total_tokens),
    },
    capacity: normalizeCapacityWindows(input.capacity?.windows),
    interruptions: normalizeInterruptions(input.interruption),
  };
}
