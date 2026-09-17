import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, normalizeObservation, readEvents, renderSummary } from "../index.js";

test("appends valid JSONL and reads it after reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-usage-telemetry-"));
  const path = join(directory, "events.jsonl");
  try {
    const event = normalizeObservation("openai", {
      model: "example-openai-model",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    }, { observedAt: "2030-01-01T00:00:00Z" });
    appendEvent(path, event);
    appendEvent(path, event);

    assert.equal(readEvents(path).length, 2);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
    assert.equal(statSync(path).mode & 0o077, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("human summary renders unavailable fields explicitly", () => {
  const event = normalizeObservation("anthropic", {
    model: "example-anthropic-model",
    usage: { input_tokens: 8, output_tokens: 2 },
  }, { observedAt: "2030-01-01T00:00:00Z" });
  const summary = renderSummary(event);
  assert.match(summary, /capacity: NOT_AVAILABLE/);
  assert.match(summary, /total NOT_AVAILABLE/);
});

test("invalid JSONL fails with its line number", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-usage-telemetry-"));
  const path = join(directory, "events.jsonl");
  try {
    writeFileSync(path, "{}\nnot-json\n", { mode: 0o600 });
    assert.throws(() => readEvents(path), /line 1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("JSONL reader rejects extra fields instead of persisting raw provider data", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-usage-telemetry-"));
  const path = join(directory, "events.jsonl");
  try {
    const event = normalizeObservation("openai", {
      model: "example-openai-model",
    }, { observedAt: "2030-01-01T00:00:00Z" });
    writeFileSync(path, `${JSON.stringify({ ...event, raw_response: "must not be accepted" })}\n`, { mode: 0o600 });
    assert.throws(() => readEvents(path), /unsupported fields: raw_response/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
