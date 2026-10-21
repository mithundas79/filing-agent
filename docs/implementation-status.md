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
- Root independent review ran the preceding 154-test checkpoint successfully, including 26 HTTP/CLI integration cases. Current-head Linux CI and independent review are pending confirmation after push.

Initial CLI integration failed because this managed Windows environment's virtualized `os.tmpdir()` allowed writes but denied rename. A minimal comparison confirmed workspace rename succeeds. Tests now create and clean their own workspace temporary directory; the receipt writer retains temporary-file-plus-rename behavior. No persistence check was removed.

## Live-model verification

Ollama and `qwen2.5:7b` were detected by the coordinator. A separate live smoke was attempted, but automatic approval review blocked continuation of its execution session; no resulting live receipt was verified. **Live-model smoke is blocked/unverified.** Do not infer model quality, successful inference or a new live recording from the HTTP stub tests. Existing historical recording files remain byte-for-byte unchanged.

## Remaining work and limits

- Code checkpoint is committed/pushed and draft PR #2 is open. Local final checks passed; independent current-head review/Linux CI confirmation remains pending. No merge was performed.
- Live smoke remains unverified as described above. Unix signal process test is committed for Linux CI but cannot run through forced Windows child-process signals locally.
- Cancellation cannot preempt synchronous JavaScript that blocks the event loop. Custom asynchronous backends must honor the signal to free their own resources even though the controller deadline bounds its result.
- Receipt persistence requires a functioning process and writable output storage; no crash/power-loss fsync guarantee is claimed. Malformed/unreadable preflight inputs may fail before any document starts.
- Legacy recordings cannot be losslessly migrated because their original request contents were never saved. Replay consistency is not cryptographic authenticity.

Codex app PR attachment was attempted after creation and failed with the app bridge MCP `-32000` error; the GitHub draft PR was created successfully.
