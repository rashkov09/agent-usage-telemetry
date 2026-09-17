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
