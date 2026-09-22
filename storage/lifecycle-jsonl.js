import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { assertLifecycleEvent } from "../core/lifecycle-schema.js";
import { buildLifecycleProjection } from "../core/lifecycle.js";

export function appendLifecycleEvent(path, event) {
  assertLifecycleEvent(event);
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readLifecycleEvents(path) {
  if (!existsSync(path)) return [];
  const eventLines = new Map();
  return readFileSync(path, "utf8").split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const event = assertLifecycleEvent(JSON.parse(line));
      const previousLine = eventLines.get(event.event_id);
      if (previousLine !== undefined) {
        throw new Error(`duplicate event_id ${event.event_id} (first seen at line ${previousLine})`);
      }
      eventLines.set(event.event_id, index + 1);
      return [event];
    } catch (error) {
      throw new Error(`invalid lifecycle JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export class LifecycleStore {
  constructor(rawPath, { projectionPath = `${rawPath}.projection.json` } = {}) {
    this.rawPath = rawPath;
    this.projectionPath = projectionPath;
    this.events = readLifecycleEvents(rawPath);
    this.projection = buildLifecycleProjection(this.events);
    this.#persistProjection();
  }

  ingest(event) {
    assertLifecycleEvent(event);
    const duplicate = this.projection.eventIds.has(event.event_id);
    const candidate = buildLifecycleProjection([...this.events, event]);
    if (duplicate) return false;
    appendLifecycleEvent(this.rawPath, event);
    this.events.push(structuredClone(event));
    this.projection = candidate;
    this.#persistProjection();
    return true;
  }

  rebuild() {
    this.events = readLifecycleEvents(this.rawPath);
    this.projection = buildLifecycleProjection(this.events);
    this.#persistProjection();
    return this.projection;
  }

  #persistProjection() {
    atomicWrite(this.projectionPath, this.projection.toJSON());
  }
}
