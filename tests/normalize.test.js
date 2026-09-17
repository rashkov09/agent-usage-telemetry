import test from "node:test";
import assert from "node:assert/strict";
import { NOT_AVAILABLE, normalizeCapacityWindows, normalizeObservation } from "../index.js";

test("normalizes OpenAI counters and capacity only when exposed", () => {
  const event = normalizeObservation("openai", {
    model: "example-openai-model",
    usage: {
      input_tokens: 1200,
      output_tokens: 430,
      input_tokens_details: { cached_tokens: 800 },
      total_tokens: 1630,
    },
    capacity: {
      windows: [{ label: "5h", used_percent: 45, reset_at: "2030-01-01T05:00:00Z" }],
    },
  }, { observedAt: "2030-01-01T00:00:00Z" });

  assert.deepEqual(event.usage, {
    input_tokens: 1200,
    output_tokens: 430,
    cache_read_tokens: 800,
    cache_write_tokens: NOT_AVAILABLE,
    total_tokens: 1630,
  });
  assert.deepEqual(event.capacity, {
    status: "AVAILABLE",
    windows: [{ label: "5h", remaining_percent: 55, reset_at: "2030-01-01T05:00:00.000Z" }],
  });
});

test("does not fabricate missing totals or capacity", () => {
  const event = normalizeObservation("openai", {
    model: "example-openai-model",
    usage: { input_tokens: 12, output_tokens: 3 },
  }, { observedAt: "2030-01-01T00:00:00Z" });

  assert.equal(event.usage.total_tokens, NOT_AVAILABLE);
  assert.deepEqual(event.capacity, { status: NOT_AVAILABLE });
});

test("keeps Anthropic capacity unavailable and preserves exposed token dimensions", () => {
  const event = normalizeObservation("anthropic", {
    model: "example-anthropic-model",
    usage: {
      input_tokens: 900,
      output_tokens: 260,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 40,
    },
    capacity: { windows: [{ label: "day", remaining_percent: 50 }] },
  }, { observedAt: "2030-01-01T00:00:00Z" });

  assert.equal(event.usage.cache_read_tokens, 400);
  assert.equal(event.usage.cache_write_tokens, 40);
  assert.equal(event.usage.total_tokens, NOT_AVAILABLE);
  assert.deepEqual(event.capacity, { status: NOT_AVAILABLE });
});

test("normalizes reset epochs and rejects unusable windows", () => {
  assert.deepEqual(normalizeCapacityWindows([
    { label: "week", remaining_percent: 25, reset_at: 1893456000 },
    { label: "invalid", used_percent: 110 },
  ]), {
    status: "AVAILABLE",
    windows: [{ label: "week", remaining_percent: 25, reset_at: "2030-01-01T00:00:00.000Z" }],
  });
});

test("counts categorized interruptions without retaining raw errors", () => {
  const event = normalizeObservation("anthropic", {
    model: "example-anthropic-model",
    interruption: {
      occurred: true,
      category: "rate_limit",
      message: "sensitive provider response that must not be persisted",
    },
  }, { observedAt: "2030-01-01T00:00:00Z" });

  assert.deepEqual(event.interruptions, { count: 1, last_category: "rate_limit" });
  assert.equal(JSON.stringify(event).includes("sensitive provider response"), false);
});
