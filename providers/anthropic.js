import { exactCount, normalizeInterruptions, unavailableCapacity } from "../core/normalize.js";

export function normalizeAnthropicObservation(input = {}) {
  const usage = input.usage && typeof input.usage === "object" ? input.usage : {};
  return {
    provider: "anthropic",
    model: input.model,
    usage: {
      input_tokens: exactCount(usage.input_tokens),
      output_tokens: exactCount(usage.output_tokens),
      cache_read_tokens: exactCount(usage.cache_read_input_tokens),
      cache_write_tokens: exactCount(usage.cache_creation_input_tokens),
      total_tokens: exactCount(usage.total_tokens),
    },
    // Anthropic quota/capacity windows are not exposed by the currently
    // observed integration. Do not infer them from token counters.
    capacity: unavailableCapacity(),
    interruptions: normalizeInterruptions(input.interruption),
  };
}
