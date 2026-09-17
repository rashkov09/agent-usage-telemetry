import { NOT_AVAILABLE } from "./schema.js";

function value(input) {
  return input === undefined || input === null ? NOT_AVAILABLE : String(input);
}

export function renderSummary(event) {
  const capacity = event.capacity.status === "AVAILABLE"
    ? event.capacity.windows.map((window) =>
      `${window.label}: ${window.remaining_percent}% remaining, reset ${value(window.reset_at)}`).join("; ")
    : NOT_AVAILABLE;
  return [
    `${event.provider} / ${event.model}`,
    `observed: ${event.observed_at}`,
    `tokens: input ${value(event.usage.input_tokens)}, output ${value(event.usage.output_tokens)}, cache read ${value(event.usage.cache_read_tokens)}, cache write ${value(event.usage.cache_write_tokens)}, total ${value(event.usage.total_tokens)}`,
    `capacity: ${capacity}`,
    `provider interruptions: ${event.interruptions.count}${event.interruptions.last_category === NOT_AVAILABLE ? "" : ` (${event.interruptions.last_category})`}`,
  ].join("\n");
}
