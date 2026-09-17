import { normalizeTimestamp } from "./normalize.js";
import { assertTelemetryEvent } from "./schema.js";
import { normalizeAnthropicObservation } from "../providers/anthropic.js";
import { normalizeOpenAIObservation } from "../providers/openai.js";

const ADAPTERS = {
  openai: normalizeOpenAIObservation,
  anthropic: normalizeAnthropicObservation,
};

export function normalizeObservation(provider, input, options = {}) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new TypeError(`unsupported provider: ${provider}`);
  const normalized = adapter(input);
  const observedAt = normalizeTimestamp(options.observedAt ?? input?.observed_at ?? Date.now());
  return assertTelemetryEvent({
    event_version: 1,
    observed_at: observedAt,
    ...normalized,
  });
}
