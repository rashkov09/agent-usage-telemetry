import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleStore, appendLifecycleEvent, readLifecycleEvents } from "../index.js";
import { segmentEvent, taskEvent } from "./lifecycle-helpers.js";

test("raw JSONL and normalized projection survive restart with identical summaries", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-lifecycle-"));
  const raw = join(directory, "lifecycle.jsonl");
  try {
    const store = new LifecycleStore(raw);
    assert.equal(store.ingest(taskEvent("restart")), true);
    assert.equal(store.ingest(segmentEvent("restart-segment", "restart", "2030-01-01T00:00:00.000Z", "2030-01-01T00:10:00.000Z")), true);
    const before = store.projection.taskSummary("restart");
    const reopened = new LifecycleStore(raw);
    assert.deepEqual(reopened.projection.taskSummary("restart"), before);
    assert.equal(reopened.projection.toJSON().schema_version, 1);
    assert.equal(JSON.parse(readFileSync(`${raw}.projection.json`, "utf8")).schema_version, 1);
    assert.equal(statSync(raw).mode & 0o077, 0);
    assert.equal(statSync(`${raw}.projection.json`).mode & 0o077, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("duplicate ingestion is a no-op for raw and normalized storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-lifecycle-"));
  const raw = join(directory, "lifecycle.jsonl");
  try {
    const store = new LifecycleStore(raw);
    const event = taskEvent("duplicate");
    assert.equal(store.ingest(event), true);
    const bytes = readFileSync(raw, "utf8");
    assert.equal(store.ingest(event), false);
    assert.equal(readFileSync(raw, "utf8"), bytes);
    const conflicting = structuredClone(event);
    conflicting.data.status = "FAILED";
    assert.throws(() => store.ingest(conflicting), /conflicts with existing evidence/);
    assert.equal(readFileSync(raw, "utf8"), bytes);
    assert.equal(readLifecycleEvents(raw).length, 1);
    assert.equal(store.projection.report().completed_tasks, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reopen rebuilds a stale projection from append-only raw evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-lifecycle-"));
  const raw = join(directory, "lifecycle.jsonl");
  try {
    const store = new LifecycleStore(raw);
    store.ingest(taskEvent("rebuild"));
    writeFileSync(`${raw}.projection.json`, JSON.stringify({ schema_version: 999 }), { mode: 0o600 });
    const reopened = new LifecycleStore(raw);
    assert.equal(reopened.projection.taskSummary("rebuild").status, "COMPLETED");
    assert.equal(JSON.parse(readFileSync(`${raw}.projection.json`, "utf8")).schema_version, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart and rebuild enforce terminal logical-task invariants", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-lifecycle-"));
  const raw = join(directory, "lifecycle.jsonl");
  try {
    const store = new LifecycleStore(raw);
    store.ingest(taskEvent("terminal-rebuild"));
    const reopening = taskEvent("terminal-rebuild", {
      status: "IN_PROGRESS",
      completed_at: "NOT_AVAILABLE",
    });
    reopening.event_id = "terminal-rebuild-reopening";
    appendLifecycleEvent(raw, reopening);
    const bytes = readFileSync(raw, "utf8");

    assert.throws(() => store.rebuild(), /terminal state cannot change/);
    assert.throws(() => new LifecycleStore(raw), /terminal state cannot change/);
    assert.equal(readFileSync(raw, "utf8"), bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("duplicate IDs in raw evidence fail closed without rewriting the file", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-lifecycle-"));
  const raw = join(directory, "lifecycle.jsonl");
  try {
    const event = taskEvent("raw-duplicate");
    const line = `${JSON.stringify(event)}\n`;
    writeFileSync(raw, line, { mode: 0o600 });
    appendFileSync(raw, line);
    const bytes = readFileSync(raw, "utf8");

    assert.throws(() => readLifecycleEvents(raw), /duplicate event_id raw-duplicate-task-completed/);
    assert.throws(() => new LifecycleStore(raw), /duplicate event_id raw-duplicate-task-completed/);
    assert.equal(readFileSync(raw, "utf8"), bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lifecycle JSONL rejects unsupported content-bearing fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-lifecycle-"));
  const raw = join(directory, "lifecycle.jsonl");
  try {
    const event = taskEvent("private-content");
    event.data.prompt = "must not be accepted";
    writeFileSync(raw, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    assert.throws(() => readLifecycleEvents(raw), /unsupported fields: prompt/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
