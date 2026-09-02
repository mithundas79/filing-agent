# filing-agent

**A tool-calling LLM agent that classifies and files documents — and cannot
mark its own work done.**

**Live walkthrough:** <https://mithundas79.github.io/filing-agent/>

The model decides *what a document is*. Deterministic code decides everything
else: what a verdict must look like, how many chances the model gets, when a
person takes over, and what goes in the receipt. That separation — judgment to
the model, authority to the code — is the whole design.

```
        ┌──────────────────────── the loop (code) ────────────────────────┐
        │                                                                 │
 doc ─▶ │   model ──calls──▶ read_document / list_categories /            │
        │     ▲              check_duplicates                             │
        │     │ tool results (all answered in ONE message)                │
        │     │                                                          │
        │   model ──calls──▶ record_verdict ──▶ VALIDATED BY CODE         │
        │                        │                  │                     │
        │                        │ rejected w/ reasons (bounded retries)  │
        │                        ▼                  ▼                     │
        │                  flag_for_human      accepted                   │
        └────────────│───────────────────────────│────────────────────────┘
                     ▼                           ▼
               human queue                 filed + receipt
```

## What makes it an agent, and what keeps it honest

**The model drives.** It chooses which tools to call, in what order, and can
call them in parallel. Nothing about the sequence is scripted.

**The code judges.** A verdict is accepted only when deterministic validation
passes:

- the category exists in the configured set
- confidence is in range — and *above the threshold*, otherwise the model is
  told to flag for a human instead of forcing it
- **every evidence quote literally appears in the document.** A model that
  fabricates its supporting evidence is not corrected — it is refused, told
  why, and given a bounded number of chances. After that, a person takes over.

**Every run writes a receipt** — written by the loop *around* the model, never
by the model. A self-reported "done" is not evidence:

```json
{
  "run_id": "…",
  "document": { "name": "northwind-invoice.txt", "sha256": "…" },
  "model": "claude-opus-5",
  "calls": [ { "request_id": "msg_…", "stop_reason": "tool_use", "input_tokens": 812, "output_tokens": 96 } ],
  "tools": [ { "tool": "read_document", "input_sha256": "…", "result_sha256": "…", "is_error": false } ],
  "usage": { "input_tokens": 1930, "output_tokens": 214 },
  "cost_usd": 0.015,
  "retries": 0,
  "outcome": { "kind": "filed", "verdict": { "category": "supplier-invoices", "evidence": ["Total Due 677.04"] } }
}
```

The `request_id` is the provider's own message id — the one thing an agent
cannot forge about its execution.

**No silent fallback.** A refusal or an unproductive run routes to the human
queue, never to a different model: a different model would be a different
provenance record.

## Quickstart

```bash
git clone https://github.com/mithundas79/filing-agent
cd filing-agent
npm ci
npm test        # 16 tests, scripted model, no key, no network, ~1s
```

Live, over the bundled fixtures (any credential the Anthropic SDK resolves —
`ANTHROPIC_API_KEY` the usual way):

```bash
export ANTHROPIC_API_KEY=sk-ant-…
npx tsx src/cli.ts fixtures/docs --categories fixtures/categories.json --out receipts
# filed   northwind-invoice.txt -> supplier-invoices  (confidence 0.95, 3 calls, $0.02)
# filed   harbor-coffee-receipt.txt -> receipts  (…)
```

Record a session while running live, then replay it anywhere — no key, no
network, no cost:

```bash
npx tsx src/cli.ts fixtures/docs --record session.json
npx tsx src/cli.ts fixtures/docs --replay session.json
```

Replay is not a mock: it is a real session re-run through the same loop, with
drift detection if the code no longer produces the conversation it recorded.

## Using it as a library

```ts
import Anthropic from "@anthropic-ai/sdk";
import { apiCaller, classifyDocument } from "filing-agent";

const { receipt } = await classifyDocument(
  { name: "invoice.txt", text, sha256 },
  { caller: apiCaller(new Anthropic()), categories, model: "claude-opus-5" },
);

if (receipt.outcome.kind === "filed") {
  /* file it */
} else {
  /* it is in the human queue, with the reason on the receipt */
}
```

The model defaults to `claude-opus-5` and is configurable per call — the
pricing table in `src/pricing.ts` prices receipts for the models it knows and
says `null` for the ones it does not, because an unknown cost is information
and a wrong cost is a lie.

## Works with doc-intake

[doc-intake](https://github.com/mithundas79/doc-intake) turns scans into text
and structured sidecars with OCR and accounting rules — offline, no model.
This agent picks up exactly where it stops: point the CLI at a folder of
doc-intake sidecars and it classifies them into your filing categories.

The third sibling, [doc-intake-service](https://github.com/mithundas79/doc-intake-service),
is the full-stack Python variant with a *trained* classifier instead of an LLM -
same rule layer, different judgment engine.

## Design rules

- **Judgment to the model, authority to the code.** The model proposes; the
  validation layer disposes.
- **Grounded or refused.** Evidence must be verbatim from the document.
- **Bounded everything.** Iterations and retries have hard limits; there are
  no unbounded loops to babysit.
- **Asking for help is success.** `flag_for_human` is a first-class terminal
  outcome, never an error path.
- **Receipts over trust.** Model, provider request ids, token spend, dollar
  cost, tool trace with input/output hashes — for every run, written by the
  controller.

## Tests

The loop is tested with a *scripted* caller — each test pins the exact
conversation, including the ways a model can misbehave: fabricated evidence,
stopping without a verdict, refusals, infinite tool loops. See
`test/loop.test.ts`; it doubles as the loop's specification.

## License

MIT © Mithun Das
