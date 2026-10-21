# Implementation status

Issue: [#1](https://github.com/mithundas79/filing-agent/issues/1)
Branch: `feature/reliable-agent-runs`
Date: 2026-10-21
Code checkpoint: `c71a6bab2ffcb5b09938e3972b13dc915e8141f8` (all implementation and regression tests).
Draft PR: [#2](https://github.com/mithundas79/filing-agent/pull/2). Later documentation-only checkpoint records these observations.

## Acceptance evidence

| Criterion | Implementation and evidence |
| --- | --- |
| Runtime model/tool validation | `model-validation.ts`, strict Ollama translation, `validateVerdict(unknown)` and `validateToolInput`; `test/runtime.test.ts` covers nulls, wrong fields/types, malformed/empty evidence and summaries, non-finite confidence, invalid usage, duplicate IDs and non-JSON arguments. |
| Terminal diagnostic receipts | Loop catches provider/validation/tool/control failures; structured diagnostic includes code/stage/iteration/request fingerprint. HTTP integration starts the real CLI in child processes and checks latest and archived JSON receipts plus exit 0/1/2 for success, malformed JSON/shapes, HTTP 503, disconnect and timeout. Throwing `FiledIndex` regression checks tool-error receipt/trace. |
| Configurable cancellation/deadlines | Optional `ModelCaller.create(params, {signal})`; `callTimeoutMs`, `runTimeoutMs`, caller cancellation and finite retry/iteration checks. Regressions exercise pre-abort, mid-call cancellation, non-cooperative asynchronous callers and both deadlines. CLI signal integration runs on Unix; Node's forced Windows child-process termination does not dispatch a catchable signal. |
| Sticky human escalation | Entire response is resolved before tool execution. Any human flag wins; malformed reasons fail closed; first valid reason wins. Multiple verdicts route human. Unit cases cover both orders, invalid flags, multiple flags/verdicts, refusal/token-limit coexistence and suppressed throwing dependencies. |
| Canonical replay and honest migration | Version 2 SHA-256 canonical JSON binds model/token limit/system/conversation/full document/categories/policy/tools. One-component-at-a-time drift tests cover each request part. Strict mode rejects untouched historical recordings; explicit legacy inspection is labeled unverified and cannot file. Integration checks record/replay, changed documents, exhaustion/unused exchanges and legacy CLI behavior. |
| Existing classification/evidence behavior | Original 16 tests remain green. Whitespace/case normalization remains unchanged and is now stated precisely. README distinguishes decisions from physical file moves and documents the default empty duplicate index. Historical demo labels request contents unverified. |
| CI without paid/GPU dependencies | CI installs npm dependencies, runs build + full source/test/script typecheck + full suite (including HTTP/CLI integration), then demo install/build. No model download/service is part of CI. |
| Reproducible reviewer commands | README fresh-checkout steps and `npm run stub` scenarios demonstrate success, validation rejection, human escalation, malformed/provider failure/timeout and canonical replay drift using the actual compiled CLI. Rights-safe invoice is `fixtures/reliability/invoice.txt`. |

## Observed verification

Environment: Windows, Node v20.20.2, npm 10.8.2. All HTTP integration results below use a deterministic local HTTP provider stub, **not a live model**.

- `npm ci` — passed; 50 packages installed using the committed lockfile.
- `npm ci --prefix demo` — passed; 68 packages installed.
- `npm run typecheck` — passed, including `src`, `test` and `scripts`.
- `npm test` — passed at the last full run: 160 passed, 1 skipped, 6 files; 30 HTTP/CLI cases included (29 executed, Unix SIGTERM case skipped on Windows). Final repeated run at the code checkpoint: 6.31 seconds; all trace status assertions passed. Unknown-tool-name regressions and strict provider stop-reason handling are included.
- `npm run test:integration` — earlier standalone run passed 26/26; expanded 30-case suite passed as part of the full run above.
- `npm run build --prefix demo` — passed, TypeScript plus Vite production build (35 modules).
- Original 16 scripted tests — included and passed in every complete run.
- Independent review ran the preceding 154-test checkpoint successfully, including 26 HTTP/CLI integration cases. Independent Linux verification passed all 161 tests, full TypeScript checks and the demo build at `f9909178`; see [passing CI](https://github.com/mithundas79/filing-agent/actions/runs/39616056802).

CLI integration creates and cleans a test-owned workspace directory, checking the same temporary-file-plus-rename receipt writes used by the real command.

## Live-model verification

**Live-model inference remains unverified.** The passing provider integration tests use a local HTTP stub and do not establish live model quality or inference success. Existing historical recording files remain byte-for-byte unchanged.

## Remaining work and limits

- Implementation is committed/pushed and draft PR #2 is open. Independent review and Linux CI passed for the implementation; this follow-up changes verification documentation only. No merge was performed.
- Live smoke remains unverified as described above. Unix signal process test is committed for Linux CI but cannot run through forced Windows child-process signals locally.
- Cancellation cannot preempt synchronous JavaScript that blocks the event loop. Custom asynchronous backends must honor the signal to free their own resources even though the controller deadline bounds its result.
- Receipt persistence requires a functioning process and writable output storage; no crash/power-loss fsync guarantee is claimed. Malformed/unreadable preflight inputs may fail before any document starts.
- Legacy recordings cannot be losslessly migrated because their original request contents were never saved. Replay consistency is not cryptographic authenticity.


## Guided demo and README follow-up — issue #3

The implementation branch now adds a guided historical walkthrough and a separate shared-validator experiment. The public Pages URL continues to serve its deployed default-branch version until the normal gated deployment publishes the update.

| Criterion | Implementation/evidence |
| --- | --- |
| Purpose and input/output | README opens with intended users, document-text input, checked decision/receipt output and feature limits; package description says decisions rather than physical filing. |
| Install/run/test commands | Clone explicitly selects `feature/reliable-agent-runs`; shell-neutral single-line CLI commands, expected exits, local demo startup and core/integration/browser commands are documented. |
| Useful browser walkthrough | Three actual recorded tool calls have step selection, Previous/Next and reset. Current shared tool/validation results are distinguished from recorded responses. Legacy outcome explicitly requires human review. |
| Real validation experiment | Separate quote field/presets use shared `validateVerdict`; document total passes and invented total is rejected. No recording is altered. |
| Readability/accessibility | Responsive layout, native labeled buttons/details/textarea, keyboard activation, visible progress, live feedback, focus styles and reduced-motion support. Source/UI text is UTF-8 without control/replacement characters. |
| Built-demo browser QA | Playwright desktop/mobile Chromium projects build/serve `/filing-agent/`; tests exercise navigation, keyboard/reset, quote rejection/acceptance, technical explanation, matching source links, overflow/assets and no provider requests. CI uploads full-page PNGs and HTML/report results. |
| Deployment boundary | Pages workflow/environment policy is unchanged. Verification CI has an optional manual build/test dispatch; it does not publish. Independent hosted browser checks and deployed-page verification are required before completion. |

Observed local checks for the follow-up: `npm run typecheck`, `npm test` (160 passed, 1 Unix-only skipped), `npm run build --prefix demo` (38 modules), and `npm run typecheck:browser --prefix demo` passed. Browser execution/screenshots are pending hosted CI; no local browser run is claimed. Existing historical recording files are unchanged. The examples contain only fictional project fixtures.
