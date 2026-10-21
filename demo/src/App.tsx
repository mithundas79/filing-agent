import { useMemo, useState } from "react";
import type { ValidationFailure } from "../../src/types.js";
import { validateVerdict } from "../../src/validate.js";
import { DOC_NAME, DOC_TEXT } from "./doc.js";
import { buildWalkthrough, CATEGORIES } from "./walkthrough.js";
import "./styles.css";

const SOURCE = "https://github.com/mithundas79/filing-agent/tree/main";
const README = "https://github.com/mithundas79/filing-agent/blob/main/README.md";
const DOCUMENT_QUOTE = "Total Due 677.04";

export function App(): JSX.Element {
  const walkthrough = useMemo(buildWalkthrough, []);
  const [active, setActive] = useState(0);
  const [quote, setQuote] = useState(DOCUMENT_QUOTE);
  const [failures, setFailures] = useState<ValidationFailure[] | null>(null);
  const step = walkthrough.steps[active]!;
  const finalStep = active === walkthrough.steps.length - 1;
  const recordedOn = new Date(walkthrough.recordedAt).toLocaleDateString("en", { dateStyle: "long", timeZone: "UTC" });

  function chooseQuote(next: string): void { setQuote(next); setFailures(null); }
  function reset(): void { setActive(0); chooseQuote(DOCUMENT_QUOTE); }
  function checkQuote(): void {
    setFailures(validateVerdict({ ...walkthrough.verdict, evidence: [quote] }, CATEGORIES, DOC_TEXT, 0.6));
  }

  return (
    <>
      <a className="skip-link" href="#walkthrough">Skip to the walkthrough</a>
      <div className="page-shell">
        <header className="site-header">
          <a className="wordmark" href="#top" aria-label="filing-agent home"><span className="brand-symbol" aria-hidden="true">f.</span>filing-agent</a>
          <nav aria-label="Main navigation"><a href="#walkthrough">Walkthrough</a><a href="#experiment">Try the rule</a><a href={README}>Read the guide <span aria-hidden="true">↗</span></a></nav>
        </header>
        <main id="top">
          <section className="hero" aria-labelledby="hero-title">
            <div className="hero-copy">
              <p className="eyebrow"><span className="status-dot" aria-hidden="true" /> A small agent. A clear paper trail.</p>
              <h1 id="hero-title">Let a model suggest.<br /><span>Let the rules decide.</span></h1>
              <p className="hero-description">Turn business document text into a filing suggestion you can inspect. The local model proposes a category; code checks its evidence and knows when to ask a person.</p>
              <div className="hero-actions"><a className="button primary" href="#walkthrough">Explore the example <span aria-hidden="true">↓</span></a><a className="button secondary" href="#run-locally">Run it locally</a></div>
              <p className="hero-note">For developers building document workflows. No account or installation needed for this walkthrough.</p>
            </div>
            <aside className="preview-card" aria-label="Example workflow">
              <span className="sample-tag">FICTIONAL SAMPLE</span>
              <div className="paper-icon" aria-hidden="true">↳</div>
              <p className="preview-name">northwind-invoice.txt</p>
              <p className="preview-description">An invoice. Three recorded tool calls.<br />One decision worth checking.</p>
              <div className="preview-flow"><span>Document text</span><span aria-hidden="true">↓</span><span>Model proposal + evidence</span><span aria-hidden="true">↓</span><strong>Validation + human review</strong></div>
            </aside>
          </section>

          <section className="mode-strip" aria-label="What runs in this demo">
            <div><span className="mode-label">RECORDED</span><p>Model responses from one historical Ollama run.</p></div>
            <div><span className="mode-label">RUNNING NOW</span><p>Shared tool functions and evidence validation in your browser.</p></div>
            <div><span className="mode-label">LOCAL PROJECT</span><p>Full controller, live inference and receipts require the CLI.</p></div>
          </section>

          <section className="guide-intro" aria-labelledby="how-title">
            <div><p className="eyebrow">A two-minute tour</p><h2 id="how-title">How to use this example</h2></div>
            <ol className="how-list"><li><span>01</span>Read the fictional invoice beside the walkthrough.</li><li><span>02</span>Move through the three recorded calls and inspect what code checks.</li><li><span>03</span>Try an invented quote, then run the full project locally.</li></ol>
          </section>

          <section id="walkthrough" className="walkthrough-section" aria-labelledby="walkthrough-title">
            <div className="section-heading"><div><p className="eyebrow">Follow the decision</p><h2 id="walkthrough-title">From text to a checked proposal</h2></div><button className="text-button" type="button" onClick={reset}>Reset walkthrough <span aria-hidden="true">↺</span></button></div>
            <div className="workbench">
              <aside className="document-panel" aria-labelledby="document-title">
                <div className="panel-heading"><div><p className="eyebrow">01 / Source document</p><h3 id="document-title">The invoice</h3></div><span className="subtle-badge">.txt</span></div>
                <p className="file-name">{DOC_NAME}</p>
                <pre className="document-text">{DOC_TEXT.split("\n").map((line, index) => <span key={index} className={line.startsWith("Total Due") ? "document-total" : ""}>{line}{"\n"}</span>)}</pre>
                <p className="small-note">Fictional company and invoice, published as a project fixture. No upload or personal document is used.</p>
              </aside>
              <div className="step-panel">
                <div className="panel-heading"><div><p className="eyebrow">02 / Recorded model, current checks</p><h3>Walk through the calls</h3></div><span className="subtle-badge">{walkthrough.model}</span></div>
                <ol className="step-tabs" aria-label="Recorded steps">{walkthrough.steps.map((item, index) => <li key={item.id}><button type="button" onClick={() => setActive(index)} aria-current={active === index ? "step" : undefined} aria-controls="step-detail"><span className="step-number">{String(index + 1).padStart(2, "0")}</span>{item.title}</button></li>)}</ol>
                <div className="progress-line"><span data-testid="step-progress">Step {active + 1} of {walkthrough.steps.length}</span><progress aria-label="Walkthrough progress" value={active + 1} max={walkthrough.steps.length} /></div>
                <article id="step-detail" className="step-detail" aria-live="polite" aria-atomic="true">
                  <h4>{step.title}</h4><p>{step.explanation}</p>
                  {step.items.map((item, index) => <div key={index}>
                    <div className="call-card"><span className="card-label">RECORDED MODEL CALL</span><code className="tool-name">{item.tool}</code><details className="call-arguments"><summary>Inspect recorded arguments</summary><pre>{JSON.stringify(item.input, null, 2)}</pre></details></div>
                    <div className={`result-card ${item.rejected ? "rejected" : ""}`}><span className="card-label">COMPUTED NOW WITH SHARED CODE</span><strong>{item.tool === "record_verdict" ? item.rejected ? "Proposal rejected" : "Evidence check passes" : "Tool result"}</strong><pre>{item.result}</pre></div>
                  </div>)}
                  {finalStep && <div className="review-notice" role="status"><span className="card-label">EXPECTED OUTCOME FOR THIS LEGACY RECORDING</span><strong>Human review required</strong><p>The invoice proposal passes today&apos;s validation. This old recording did not save request-content fingerprints, so it cannot authorize filing. Explicit legacy CLI inspection also requires a person.</p></div>}
                </article>
                <div className="step-controls"><button type="button" className="button secondary" disabled={active === 0} onClick={() => setActive((value) => value - 1)}>← Previous step</button><button type="button" className="button dark" disabled={finalStep} onClick={() => setActive((value) => value + 1)}>Next step →</button></div>
                <p className="small-note">Historical responses recorded {recordedOn}. No model is being called here.</p>
              </div>
            </div>
          </section>

          <section id="experiment" className="experiment-section" aria-labelledby="experiment-title">
            <div className="experiment-intro"><p className="eyebrow">Your turn</p><h2 id="experiment-title">A quote is evidence.<br />An invented total isn&apos;t.</h2><p>Change one quote and run the same <code>validateVerdict</code> function used by the local project. This separate experiment edits a sample proposal, not the recording.</p><div className="expected-note"><strong>What to expect</strong><p><code>Total Due 677.04</code> passes. <code>Total Due 999.99</code> is rejected because it is not in the document.</p></div></div>
            <div className="experiment-card"><label htmlFor="evidence-quote">Evidence quote to check</label><textarea id="evidence-quote" value={quote} onChange={(event) => chooseQuote(event.target.value)} rows={3} spellCheck={false} aria-describedby="quote-help" /><p id="quote-help" className="small-note">Matching ignores case and repeated whitespace. It does not judge whether the category is semantically correct.</p><div className="preset-controls"><button className="text-button" type="button" onClick={() => chooseQuote(DOCUMENT_QUOTE)}>Use document quote</button><button className="text-button" type="button" onClick={() => chooseQuote("Total Due 999.99")}>Try invented total</button></div><button type="button" className="button dark" onClick={checkQuote}>Check quote</button><div className="experiment-feedback" aria-live="polite" aria-atomic="true">{failures === null ? <p className="unchecked">Ready to check. Choose a quote, then select Check quote.</p> : failures.length ? <div className="validation-message invalid"><strong>Quote rejected</strong><ul>{failures.map((failure, index) => <li key={index}>{failure.problem}</li>)}</ul></div> : <div className="validation-message valid"><strong>Quote supported by the document</strong><p>The evidence check passes. This experiment makes no filing decision.</p></div>}</div></div>
          </section>

          <section className="capabilities-section" aria-labelledby="capabilities-title"><p className="eyebrow">Know what you are seeing</p><h2 id="capabilities-title">Explore in a browser. Run the agent locally.</h2><div className="capability-grid"><div className="capability-card"><span className="small-caps">THIS WALKTHROUGH</span><h3>Learn the decision path</h3><ul><li>Inspect a historical model response.</li><li>Run shared tool and validation code.</li><li>Try supported and fabricated evidence.</li><li>Reset the example at any time.</li></ul></div><div className="capability-card tinted"><span className="small-caps">THE LOCAL CLI</span><h3>Process your own text</h3><ul><li>Call a local Ollama model.</li><li>Enforce deadlines and human escalation.</li><li>Write diagnostic receipts to disk.</li><li>Record new sessions with strict replay checks.</li></ul></div></div><details className="technical-details"><summary>Technical details and limits</summary><div><p>This page inspects <code>demo/src/session.live.json</code>. It calls shared <code>executeTool</code> and <code>validateVerdict</code> functions; it does not execute the full agent controller, verify canonical replay fingerprints or issue an authoritative receipt.</p><p>No live inference, upload, OCR, file move or persistent review queue runs here. The CLI also produces filing decisions rather than moving documents. Its default duplicate index is empty. Evidence matching proves a quote appears after normalization; it does not prove classification accuracy or calibrated confidence.</p><p>The historical model proposed <code>{walkthrough.verdict.category}</code> at confidence {walkthrough.verdict.confidence}. There were {walkthrough.rejected} rejected proposals in this recording. Recorded usage: {walkthrough.usage.input} input / {walkthrough.usage.output} output tokens; no new inference tokens are used by this page.</p></div></details></section>

          <section id="run-locally" className="local-section" aria-labelledby="local-title"><div><p className="eyebrow">Take it further</p><h2 id="local-title">Run the complete project.</h2><p>You need Node.js 20+, npm, Ollama and the local model for live inference. The automated stub tests need no model or paid service.</p><p className="small-note">These commands use the main release branch. Run each command on its own line in PowerShell or a POSIX shell.</p><a className="button primary" href={README}>Installation, tests and limits <span aria-hidden="true">↗</span></a></div><pre className="terminal" aria-label="Local installation commands"><code>{`git clone --branch main https://github.com/mithundas79/filing-agent.git\ncd filing-agent\nnpm ci\nnpm test\nollama pull qwen2.5:7b\nnode dist/cli.js fixtures/reliability --out receipts`}</code></pre></section>
        </main>
        <footer className="site-footer"><p>filing-agent <span>·</span> MIT licensed <span>·</span> Fictional project fixtures</p><nav aria-label="Project links"><a href={SOURCE}>Source code</a><a href="https://mithundas79.github.io/doc-intake/">Offline OCR demo</a><a href="https://github.com/mithundas79/doc-intake-service/blob/main/README.md#try-the-guided-preview">Review app guide</a></nav></footer>
      </div>
    </>
  );
}
