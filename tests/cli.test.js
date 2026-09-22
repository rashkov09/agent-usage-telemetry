import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("CLI ingests a sanitized observation and summarizes its JSONL", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-usage-cli-"));
  const observation = join(directory, "observation.json");
  const output = join(directory, "events.jsonl");
  try {
    writeFileSync(observation, JSON.stringify({
      model: "example-openai-model",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    }));
    const ingest = spawnSync(process.execPath, ["cli.js", "ingest", "--provider", "openai", "--input", observation, "--output", output], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
    assert.equal(ingest.status, 0, ingest.stderr);
    assert.match(ingest.stdout, /written:/);

    const summary = spawnSync(process.execPath, ["cli.js", "summary", "--input", output], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /openai \/ example-openai-model/);
    assert.match(summary.stdout, /capacity: NOT_AVAILABLE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI reports a logical-task lifecycle without changing legacy commands", () => {
  const fixture = new URL("./fixtures/gin-164-shaped.jsonl", import.meta.url);
  const result = spawnSync(process.execPath, ["cli.js", "lifecycle-summary", "--input", fixture.pathname, "--task", "gin-164"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.task_id, "gin-164");
  assert.equal(summary.segment_ids.length, 2);
  assert.equal(summary.total_lead_seconds, 11400);
});

test("CLI calibration summary labels observed, derived, estimated, and unavailable evidence", () => {
  const fixture = new URL("./fixtures/gin-164-shaped.jsonl", import.meta.url);
  const result = spawnSync(process.execPath, ["cli.js", "calibration-summary", "--input", fixture.pathname], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CAPACITY CALIBRATION SUMMARY/);
  assert.match(result.stdout, /OBSERVED/);
  assert.match(result.stdout, /DERIVED/);
  assert.match(result.stdout, /ESTIMATED/);
  assert.match(result.stdout, /NOT_AVAILABLE/);
});
