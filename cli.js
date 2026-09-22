#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { appendEvent, readEvents } from "./storage/jsonl.js";
import { normalizeObservation } from "./core/telemetry.js";
import { renderSummary } from "./core/summary.js";
import { buildLifecycleProjection } from "./core/lifecycle.js";
import { readLifecycleEvents } from "./storage/lifecycle-jsonl.js";

function help() {
  return `agent-usage-telemetry

Usage:
  agent-usage-telemetry ingest --provider <openai|anthropic> --input <file|-> [--output <file>]
  agent-usage-telemetry summary [--input <jsonl>] [--last <count>]
  agent-usage-telemetry lifecycle-summary --input <jsonl> [--task <task-id>]

Defaults:
  ingest --output ./agent-usage.jsonl
  summary --input ./agent-usage.jsonl --last 1
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${flag ?? ""}`);
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function readInput(path) {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

export function run(argv) {
  const { command, options } = parseArgs(argv);
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(help());
    return;
  }
  if (command === "ingest") {
    if (!options.provider || !options.input) throw new Error("ingest requires --provider and --input");
    const event = normalizeObservation(options.provider, JSON.parse(readInput(options.input)));
    const output = options.output ?? "agent-usage.jsonl";
    appendEvent(output, event);
    process.stdout.write(`${renderSummary(event)}\nwritten: ${output}\n`);
    return;
  }
  if (command === "summary") {
    const input = options.input ?? "agent-usage.jsonl";
    const count = options.last === undefined ? 1 : Number.parseInt(options.last, 10);
    if (!Number.isInteger(count) || count < 1) throw new Error("--last must be a positive integer");
    const events = readEvents(input).slice(-count);
    if (events.length === 0) throw new Error(`no telemetry events found in ${input}`);
    process.stdout.write(`${events.map(renderSummary).join("\n\n---\n\n")}\n`);
    return;
  }
  if (command === "lifecycle-summary") {
    if (!options.input) throw new Error("lifecycle-summary requires --input");
    const projection = buildLifecycleProjection(readLifecycleEvents(options.input));
    const result = options.task ? projection.taskSummary(options.task) : projection.report();
    if (!result) throw new Error(`unknown logical task: ${options.task}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
