import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  assertSettlementObservation,
  settlementRecordsEqual,
} from "../core/settlement.js";

export function readSettlementObservations(path) {
  if (!existsSync(path)) return [];
  const observations = [];
  const ids = new Map();
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`);
    }
    if (parsed?.record_type !== "CAPACITY_SETTLEMENT_OBSERVATION") continue;
    try {
      const observation = assertSettlementObservation(parsed);
      const previous = ids.get(observation.observation_id);
      if (previous) {
        if (!settlementRecordsEqual(previous.record, observation)) {
          throw new Error(`observation_id ${observation.observation_id} conflicts with line ${previous.line}`);
        }
        continue;
      }
      ids.set(observation.observation_id, { line: index + 1, record: observation });
      observations.push(observation);
    } catch (error) {
      throw new Error(`invalid settlement observation at line ${index + 1}: ${error.message}`);
    }
  }
  return observations;
}

function slot(record) {
  return [record.data.task_id, record.data.run_id, record.data.observation_kind, record.data.sequence].join("\u0000");
}

export class SettlementObservationStore {
  constructor(path) {
    this.path = path;
    this.observations = readSettlementObservations(path);
    this.byId = new Map(this.observations.map((record) => [record.observation_id, record]));
    this.bySlot = new Map();
    for (const record of this.observations) {
      const key = slot(record);
      if (this.bySlot.has(key)) throw new Error(`settlement observation slot conflicts for ${record.observation_id}`);
      this.bySlot.set(key, record.observation_id);
    }
  }

  ingest(record) {
    assertSettlementObservation(record);
    const previous = this.byId.get(record.observation_id);
    if (previous) {
      if (!settlementRecordsEqual(previous, record)) {
        throw new Error(`observation_id ${record.observation_id} conflicts with existing evidence`);
      }
      return false;
    }
    const key = slot(record);
    if (this.bySlot.has(key)) throw new Error(`settlement observation slot conflicts with ${this.bySlot.get(key)}`);
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    const copy = structuredClone(record);
    this.observations.push(copy);
    this.byId.set(copy.observation_id, copy);
    this.bySlot.set(key, copy.observation_id);
    return true;
  }
}
