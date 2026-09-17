# agent-usage-telemetry

> Track token usage, provider capacity, resets, and interruptions across AI coding agents.

AI coding agents expose usage in different shapes, and some providers do not expose quota windows at all. `agent-usage-telemetry` turns supported observations into a small, honest JSONL record: provider and model identity, exact counters when supplied, capacity windows when supplied, and explicit `NOT_AVAILABLE` values everywhere else.

It is a dependency-free Node.js library and CLI. It does **not** read credentials, call provider account APIs, estimate billing, or infer hidden quota data.

## Provider capabilities

| Capability | OpenAI | Anthropic |
| --- | --- | --- |
| Token counters | Supported where exposed | Supported where exposed |
| Cache counters | Supported where exposed | Supported where exposed |
| Rolling capacity window | Supported where exposed | Not currently available |
| Reset time | Supported where exposed | Not currently available |
| Provider interruptions | Supported | Supported |

“Supported where exposed” means the calling agent or integration must provide the observation. The package never fabricates missing counters or fetches private account data.

## Install and run

Requires Node.js 20 or newer.

```bash
git clone https://github.com/rashkov09/agent-usage-telemetry.git
cd agent-usage-telemetry
npm install
npm test

node cli.js ingest \
  --provider openai \
  --input examples/openai-observation.json \
  --output agent-usage.jsonl

node cli.js summary --input agent-usage.jsonl
```

Use `--input -` to read an observation from stdin. JSONL files are created with owner-only permissions where the operating system supports them.

## Output

```json
{
  "event_version": 1,
  "observed_at": "2030-01-01T00:00:00.000Z",
  "provider": "openai",
  "model": "example-openai-model",
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 430,
    "cache_read_tokens": 800,
    "cache_write_tokens": "NOT_AVAILABLE",
    "total_tokens": 1630
  },
  "capacity": {
    "status": "AVAILABLE",
    "windows": [
      {
        "label": "5h",
        "remaining_percent": 55,
        "reset_at": "2030-01-01T05:00:00.000Z"
      }
    ]
  },
  "interruptions": {
    "count": 0,
    "last_category": "NOT_AVAILABLE"
  }
}
```

If a provider or integration does not expose capacity, the result stays explicit:

```json
{
  "capacity": {
    "status": "NOT_AVAILABLE"
  }
}
```

Raw provider error messages are not persisted. Interruptions are reduced to a count and a small category set to avoid accidentally storing sensitive response data.

## Library API

```js
import {
  appendEvent,
  normalizeObservation,
  renderSummary,
} from "agent-usage-telemetry";

const event = normalizeObservation("openai", providerObservation);
appendEvent("agent-usage.jsonl", event);
console.log(renderSummary(event));
```

The input examples document the supported provider shapes. A JSON Schema for normalized output lives at `schema/telemetry-event.schema.json`.

## Add another provider

1. Add a module under `providers/` that maps only directly exposed values into `usage`, `capacity`, and `interruptions`.
2. Return `NOT_AVAILABLE` instead of estimating missing values.
3. Register the adapter in `core/telemetry.js`.
4. Add sanitized tests proving both available and unavailable fields.
5. Update the capability table with claims demonstrated by the adapter and tests.

## Scope and status

This is an intentionally small MVP for normalizing and storing observations supplied by AI-agent integrations. It has been extracted from real OpenAI and Anthropic telemetry work, but it is not a universal account-quota client and is not presented as production-ready.

Non-goals for v1: dashboards, billing estimates, provider routing, orchestration, databases, and credential handling.
