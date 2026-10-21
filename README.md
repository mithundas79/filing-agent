# filing-agent

**Turn document text into a checked filing decision, with a receipt you can inspect.**

For developers and small teams adding a local document-classification step to a
business workflow. Give it invoice, receipt, statement or contract text; a local
model suggests a category and quotes its evidence. Deterministic code accepts
that proposal, asks for human review, or records an execution error.

**[Open the browser demo](https://mithundas79.github.io/filing-agent/)** ·
[Source code on main](https://github.com/mithundas79/filing-agent/tree/main) ·
[Verification](docs/implementation-status.md)

The browser demo is published from `main` through GitHub Pages. Source links
and setup commands below target `main`. Hosted build/browser checks run before
release; deployed-page verification is recorded in the verification notes once
publication is complete.

## What it does

| Input | What happens | Output |
| --- | --- | --- |
| A folder of `.txt` files or JSON sidecars with a string `text` field | Ollama proposes a category; code checks shape, confidence and evidence, with bounded retries/deadlines | A `filed`, `human` or `error` decision and JSON receipts for each started run |
| A newly recorded v2 session plus the same inputs/settings | Strict replay checks canonical request fingerprints without calling a model | A reproducible decision, or an explicit drift/exhaustion error |

- Runs locally with Ollama; no API key or paid service is required.
- Rejects malformed verdicts and fabricated evidence. Human escalation wins over
  a competing filing verdict.
- Keeps diagnostic receipts, per-run archives and a trace of tool execution.
- Produces **filing decisions**; it does not move documents, OCR scans, provide
  an approval queue or remember duplicates with the default empty index.
- Evidence matching is case/whitespace normalized. It does not establish model
  accuracy, vendor identity or calibrated confidence. Local inference still uses
  your hardware and electricity; per-token cost is unknown (`cost_usd: null`).

## Try the guided browser demo

No installation, account or model is needed to explore the
[GitHub Pages demo](https://mithundas79.github.io/filing-agent/).

The upgraded walkthrough uses one rights-safe fictional Northwind invoice and
three actual historical model calls:

1. Read the source document beside the recorded call.
2. Step through reading, category lookup and the classification proposal; use
   Previous/Next, select a numbered step, or reset the walkthrough.
3. The recorded invoice proposal passes the current shared validator. The
   **expected legacy outcome is human review** because the old recording lacks
   request-content fingerprints.
4. In the separate evidence experiment, `Total Due 677.04` passes and
   `Total Due 999.99` is rejected by the real shared `validateVerdict` function.

The browser inspects saved responses and runs shared tools/validation. It makes
no live model calls, runs no full controller, verifies no canonical replay,
writes no authoritative receipt and moves no files. Use the local CLI for the
complete agent, new strict recordings and receipts. See the expandable limits
on the page for details.

## Install the current implementation

Prerequisites: Node.js 20+ and npm. Live inference additionally needs
[Ollama](https://ollama.com), the `qwen2.5:7b` model, and several GB of RAM/VRAM.
First-load and CPU inference can be slow. The tests and browser walkthrough do
not need the model. The package declares Node 18+; Node 20 is the tested setup.

Clone the release from `main`:

```bash
git clone --branch main https://github.com/mithundas79/filing-agent.git
cd filing-agent
npm ci
npm run typecheck
npm test
```

`npm test` builds the real CLI before running its tests. Commands below each fit
on a single line and work in PowerShell or a POSIX shell.

### Run the local model on the bundled invoice

```bash
ollama pull qwen2.5:7b
node dist/cli.js fixtures/reliability --out receipts --record session.json --call-timeout-ms 300000 --run-timeout-ms 600000
node dist/cli.js fixtures/reliability --out replay-receipts --replay session.json
```

Expected: the fictional invoice should support `supplier-invoices`; actual live
model behavior is not scripted, so it may also request review or hit a limit.
Inspect `receipts/invoice.txt.receipt.json` for the actual decision and diagnostics.
`filed` means a checked filing decision, not a physical file operation. New replay
uses no model and must match the original request, settings and document contents.
Increase explicit deadlines for slower hardware; changing models invalidates
strict replay. Live-model quality/inference remains separately unverified.

### Run a deterministic example without Ollama

In one terminal:

```bash
npm run stub -- --port 11435
```

In another terminal, run these separately. Some exit unsuccessfully by design:

```bash
node dist/cli.js fixtures/reliability --host http://127.0.0.1:11435/success --out receipts/success --record stub-session.json
node dist/cli.js fixtures/reliability --host http://127.0.0.1:11435/validation --out receipts/validation --max-retries 1
node dist/cli.js fixtures/reliability --host http://127.0.0.1:11435/human --out receipts/human
node dist/cli.js fixtures/reliability --host http://127.0.0.1:11435/malformed --out receipts/malformed
node dist/cli.js fixtures/reliability --host http://127.0.0.1:11435/failure --out receipts/failure
node dist/cli.js fixtures/reliability --host http://127.0.0.1:11435/timeout --out receipts/timeout --call-timeout-ms 200
node dist/cli.js fixtures/reliability --replay stub-session.json --out receipts/replay
node dist/cli.js fixtures/reliability --replay stub-session.json --model changed-model --out receipts/drift
```

Expected: success and matching replay exit **0**; validation exhaustion and human
review exit **1**; malformed output, provider failure, timeout and replay drift
exit **2**. Inspect each output folder's `invoice.txt.receipt.json`. These are
HTTP stub demonstrations, not live inference or a live-model recording.

### Run the browser walkthrough locally

```bash
npm ci --prefix demo
npm run dev --prefix demo -- --host 127.0.0.1
```

Open **http://127.0.0.1:5173/filing-agent/**. To serve the production build instead:

```bash
npm run build --prefix demo
npm run preview --prefix demo -- --host 127.0.0.1
```

Open **http://127.0.0.1:4173/filing-agent/**. This is the same base path tested for
GitHub Pages; opening the built HTML directly with `file://` is unsupported.

## Verify the project

| Command | What it verifies |
| --- | --- |
| `npm run typecheck` | Source, core tests and HTTP stub types |
| `npm test` | 161 core cases on Linux: original behavior, malformed inputs, terminal policy, deadlines and canonical replay; includes actual child-process CLI/HTTP integration |
| `npm run test:integration` | Local HTTP provider stub plus separate-process CLI runs, persisted receipts and exit codes |
| `npm run build --prefix demo` | Browser source typecheck and production bundle |
| `npm run typecheck:browser --prefix demo` | Browser test/config types |
| `npm run test:browser --prefix demo` | Built-site desktop/mobile Chromium interactions at `/filing-agent/`, validation experiment, reset, keyboard navigation and screenshots |

For browser tests, install their dependencies and Chromium first:

```bash
npm ci --prefix demo
cd demo
npx playwright install chromium
npm run typecheck:browser
npm run test:browser
cd ..
```

Linux systems may need `npx playwright install --with-deps chromium` to install
browser system libraries. Browser tests build the site and start its preview
server automatically. Results go to `demo/playwright-report/` and
`demo/test-results/`; CI uploads desktop/mobile PNG screenshots and the report
as the **filing-agent-demo-browser** artifact. PR CI runs the complete core and
browser jobs without a GPU or paid service. The optional manual verification
dispatch becomes available when the workflow update reaches the default branch.
It builds/tests only; GitHub Pages deployment remains a separate gated workflow.

After a successful Pages deployment, the `verify-live` job runs the same ten
desktop/mobile browser checks against **https://mithundas79.github.io/filing-agent/**.
It sets `PUBLISHED_DEMO_URL` to that exact allowlisted URL and disables the local
preview server, so these checks read the published site rather than a local
mirror. Live screenshots, traces/report files use separate output directories
and the **filing-agent-live-browser** artifact. The default browser command keeps
building and testing the local production bundle. An unsupported or empty
`PUBLISHED_DEMO_URL` fails configuration rather than falling back to local tests.

On Windows the Unix SIGTERM process case is skipped; the other 160 core cases
run. HTTP stubs and recorded responses test controller behavior, not live model
quality. See [verification details](docs/implementation-status.md) for actual
results and remaining limits.

## Runtime guarantees

Model response objects, block types, tool IDs, stop reasons and token usage are
validated before use. Tool inputs must match the supported schema: no null
argument objects, extra properties or wrong field types. A verdict requires a
known category, a string-or-null vendor, a one-line summary, finite confidence
in `[0,1]` at or above the configured threshold, and at least one evidence quote.

Evidence uses case-insensitive, whitespace-normalized substring matching. It
rejects missing and fabricated quotes; it does not prove the model's semantic
classification, vendor identity or calibrated confidence. The prompt asks the
model to read first, but the controller does not enforce a fixed tool order.

Invalid tool arguments/verdicts receive structured error feedback with a shared
retry budget. Exhausting it routes to human review. An invalid provider response
or a throwing provider/tool ends with an error receipt. Provider failures are
not retried automatically. Defaults are 10 iterations, 3 correction retries,
120 seconds per model call and 10 minutes for the entire document run. Limits
must be finite integers; timeout values must be positive milliseconds.

Terminal calls are resolved over the entire response before tool execution:

- Any `flag_for_human` wins over every verdict regardless of order. The first
  valid reason is used; malformed flags still request human review and add a
  validation diagnostic. Other tools are suppressed after escalation.
- Multiple `record_verdict` calls in one response route to a person, even when
  both validate. A model refusal also routes to a person.
- One valid verdict is accepted only if no tool in that response failed or was
  rejected. All tool calls receive a traced result in one conversation message.

`--call-timeout-ms`, `--run-timeout-ms`, `--max-iterations`, and `--max-retries`
configure the limits. SIGINT/SIGTERM cancel an active run; the CLI awaits its
receipt write and exits 2. The library also accepts an `AbortSignal` and passes
a derived signal to the backend. The controller returns at its deadline even
if a custom asynchronous caller ignores cancellation. Such a caller must honor
the signal to release its own resources. Synchronous plugins that block the JS
event loop cannot be preempted; run untrusted blocking code in another process.

## Receipts and exit codes

Every started classification returns a receipt while the process remains able
to execute. The CLI writes both `<document>.receipt.json` (latest) and
`<run_id>.receipt.json` (per-run archive), using temporary files plus rename.
Subsequent runs retain earlier archives. The output directory must be writable.
No program can guarantee a receipt after process termination, power loss,
exhausted memory, or unavailable output storage. Writes do not claim disk-fsync
or multi-file transaction durability. Bad CLI input/session JSON or unreadable
inputs can fail during preflight before a document run starts.

Receipts include document identity, timestamps, successful validated call IDs
and canonical request hashes, usage, tool input/result hashes, retry count,
structured `diagnostics`, and a terminal `filed`, `human`, or `error` outcome.
Failed provider attempts have a diagnostic with their request hash and iteration;
they have no successful call record or invented token counts. A local response
ID is a response-content digest, not a provider-issued authentication proof.
Tool traces identify `executed`, `rejected`, `suppressed` or `failed` calls; inspect `status`, `is_error` and
the terminal outcome. Receipt hashes are identifiers, not tamper-proof signatures.

| Exit | Meaning |
| --- | --- |
| 0 | Every processed document has an accepted filing decision |
| 1 | At least one needs human review, with no run errors |
| 2 | At least one run, replay, input/configuration or output-storage error |

Batches continue after per-document provider failures and write each receipt.
Cancellation stops after the active document. Errors take exit-code precedence
over human review. An error is printed as `error`, never mislabeled as `human`.

## Recording format and migration

New recordings use `format_version: 2` and
`fingerprint_algorithm: "sha256-canonical-json-v1"`. Each exchange stores a SHA-256
fingerprint of canonical JSON: object keys sorted, array order preserved.
The fingerprint binds model, token limit, system prompt, full conversation,
tool names/descriptions/schemas and controller context. Context includes the
complete document (even before `read_document`), category configuration, confidence
threshold and retry/iteration policy. Cancellation signals and wall-clock
transport deadlines are not model request contents. Replay returns copied
responses, rejects any material request drift and checks exhaustion. The CLI
also rejects unused exchanges at the end of a complete session; library users
should call `replay.assertComplete()` when their whole session finishes.

A recording verifies request consistency, not recording authenticity. Editing
both a recording and its fingerprints is outside this mechanism's threat model.
Only completed, runtime-valid responses are recorded; an interrupted recording
may end before its run does and replay then reports exhaustion.

The committed `fixtures/session.northwind.json` and `demo/src/session.live.json`
are historical live recordings with **only message counts and tool names**.
Their missing prompts/document contents cannot be reconstructed honestly. They
are preserved unchanged, not assigned invented fingerprints. Strict replay
rejects them. For historical inspection only:

```bash
# Put only northwind-invoice.txt in a directory before replaying this one-document session.
node dist/cli.js northwind-only --replay fixtures/session.northwind.json --allow-legacy-replay --out historical-receipts
```

Explicit legacy mode checks available model/count/tool-name metadata, prints a
warning, labels receipts `legacy-unverified`, and converts any recorded filing
decision into human review. It cannot certify unchanged request contents. The
browser walkthrough likewise labels its historical verdict unverified. To
obtain strict replay, make a **new actual run** with `--record`; there is no
lossless in-place migration of the old recordings.

## Library

```ts
import { classifyDocument, ollamaCaller } from "filing-agent";

const controller = new AbortController();
const { receipt } = await classifyDocument(
  { name: "invoice.txt", text, sha256 },
  { caller: ollamaCaller(), categories, model: "qwen2.5:7b",
    callTimeoutMs: 120_000, runTimeoutMs: 600_000, signal: controller.signal },
);
if (receipt.outcome.kind === "filed") {
  // Apply your own filing operation to receipt.outcome.verdict.
} else {
  // Distinguish human review from an execution error; persist receipt.
}
```

Existing `ModelCaller.create(params)` adapters remain compatible; implement the
optional second `{ signal }` argument for transport cancellation. Custom callers
are runtime-validated too. `EmptyFiledIndex` is the CLI default and does not
remember previous documents. Supply a persistent `FiledIndex` in your application
if duplicate checking is required. Receipts and recordings are local JSON files;
the repository does not provide an approval queue, authentication or a document
storage service.

[doc-intake](https://github.com/mithundas79/doc-intake) produces text/structured
sidecars; this CLI reads `.txt` files and `.json` sidecars with a string `text`
field. [doc-intake-service](https://github.com/mithundas79/doc-intake-service)
provides a separate web intake workflow.

MIT - Mithun Das
