import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { assertTelemetryEvent } from "../core/schema.js";

export function appendEvent(path, event) {
  assertTelemetryEvent(event);
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [assertTelemetryEvent(JSON.parse(line))];
    } catch (error) {
      throw new Error(`invalid telemetry JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}
