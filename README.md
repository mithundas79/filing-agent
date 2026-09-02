# filing-agent

**A tool-calling LLM agent that classifies and files documents — and cannot
mark its own work done. Fully open source, top to bottom: the agent, the
model, the runtime. No API key, no per-token bill, ever.**

**Live walkthrough (a real recorded session):** <https://mithundas79.github.io/filing-agent/>

The model decides *what a document is*. Deterministic code decides everything
else: what a verdict must look like, how many chances the model gets, when a
person takes over, and what goes in the receipt. That separation — judgment to
the model, authority to the code — is the whole design.

The model is **Qwen2.5 7B Instruct** (Apache 2.0) served locally by
[Ollama](https://ollama.com); the licence matters — it is genuinely open
source, not a community licence with usage clauses. Any Ollama model with
tool-calling support drops in via `--model`.

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
  fabricates or paraphrases its supporting evidence is not corrected — it is
  refused, told why (with the closest matching document line as a hint), and
  given a bounded number of chances. After that, a person takes over.

With a 7B model this layer is visibly **load-bearing**: small models
paraphrase, rejections genuinely fire, and the retry path earns its keep. That
is the thesis demonstrated, not asserted.

**Every run writes a receipt** — written by the loop *around* the model, never
by the model. A self-reported "done" is not evidence:

```json
{
  "run_id": "…",
  "document": { "name": "northwind-invoice.txt", "sha256": "…" },
  "model": "qwen2.5:7b",
  "calls": [ { "request_id": "sha256:…", "stop_reason": "tool_use", "input_tokens": 812, "output_tokens": 96 } ],
  "tools": [ { "tool": "read_document", "input_sha256": "…", "result_sha256": "…", "is_error": false } ],
  "usage": { "input_tokens": 1930, "output_tokens": 214 },
  "cost_usd": null,
  "retries": 1,
  "outcome": { "kind": "filed", "verdict": { "category": "supplier-invoices", "evidence": ["Total Due 677.04"] } }
}
```

A local model has no provider-issued request id, so each call is pinned by a
digest of its own response — the receipt still identifies exactly what was
said. `cost_usd` is `null` because local inference has no per-token price, and
an unknown cost stated as a number would be a lie.

**No silent fallback.** A refusal or an unproductive run routes to the human
queue, never to a different model: a different model would be a different
provenance record.

## Quickstart

Prerequisite: [Ollama](https://ollama.com) (Windows, macOS, Linux), then the
model — about a 4.7 GB one-time download:

```bash
ollama pull qwen2.5:7b
```

Then:

```bash
git clone https://github.com/mithundas79/filing-agent
cd filing-agent
npm ci
npm test        # 16 tests, scripted model, no Ollama needed, ~1s

# live, over the bundled fixtures:
npx tsx src/cli.ts fixtures/docs --categories fixtures/categories.json --out receipts
```

Record a session while running live, then replay it anywhere — no model, no
GPU, no wait:

```bash
npx tsx src/cli.ts fixtures/docs --record session.json
npx tsx src/cli.ts fixtures/docs --replay session.json
```

Replay is not a mock: it is a real session re-run through the same loop, with
drift detection if the code no longer produces the conversation it recorded.
The committed `fixtures/session.northwind.json` is one such real recording —
the same one the live walkthrough page replays.

Hardware honesty: a 7B model wants ~5 GB of RAM/VRAM. On a mid-range GPU a
run takes seconds; on CPU it takes a minute or two. `--model qwen2.5:3b` is
the low-spec fallback — noticeably shakier at tool calling, which mostly
means you will watch the validation layer work harder.

## Using it as a library

```ts
import { classifyDocument, ollamaCaller } from "filing-agent";

const { receipt } = await classifyDocument(
  { name: "invoice.txt", text, sha256 },
  { caller: ollamaCaller(), categories, model: "qwen2.5:7b" },
);

if (receipt.outcome.kind === "filed") {
  /* file it */
} else {
  /* it is in the human queue, with the reason on the receipt */
}
```

`ModelCaller` is one small interface; the Ollama backend is one
implementation of it. Pointing the same loop at any other backend — hosted or
local — is a ~50-line adapter, and `src/pricing.ts` is where its per-token
prices would go.

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
- **Receipts over trust.** Model, response digests, token counts, tool trace
  with input/output hashes — for every run, written by the controller.
- **Open end to end.** MIT code, Apache-2.0 model, MIT runtime. A reviewer
  risks nothing by running it.

## Tests

The loop is tested with a *scripted* caller — each test pins the exact
conversation, including the ways a model can misbehave: fabricated evidence,
stopping without a verdict, refusals, infinite tool loops. See
`test/loop.test.ts`; it doubles as the loop's specification. CI runs the
suite without any model, which is the point: the loop's contract does not
depend on the model behaving.

## License

MIT © Mithun Das
