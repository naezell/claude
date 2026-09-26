/* Ledger Lens UI: "Report a problem", and the safety net shown if the page itself breaks. */
(function () {
  'use strict';
  const { useState, useMemo, useRef } = React;
  const html = htm.bind(React.createElement);
  const UI = window.LedgerUI;
  const { Icon, useEscape, saveTextFile, copyText } = UI;
  const Problem = window.LedgerProblem;

  // `context` adds a few non-client facts, such as the open tab and which kinds of files are loaded.
  function ProblemDrawer({ onClose, context }) {
    const [what, setWhat] = useState('');
    const [status, setStatus] = useState('');
    const [showDetails, setShowDetails] = useState(false);
    useEscape(onClose);
    const report = useMemo(() => Problem.draft(what.trim(), context), [what, context]);
    const full = `${report.subject}\n\n${report.body}`;
    const pre = useRef(null);
    return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="problem-title">
        <div class="drawer-head"><h2 id="problem-title">Report a problem</h2><button class="btn" onClick=${onClose}>Close</button></div>
        <div class="drawer-scroll panel-body problem">
          <p>Something not working, or a figure that looks wrong? Describe it here and send it${report.to ? ` to ${report.to}` : ''}. Nothing is sent until you send it yourself.</p>
          <label class="field" for="problem-what">What happened, and what were you doing?
            <textarea id="problem-what" class="text" rows="5" value=${what} placeholder="For example: I uploaded the Profit and Loss for Bloom & Basil and the Ties to QuickBooks check says it does not tie, but the totals match." onInput=${(e) => setWhat(e.target.value)}></textarea>
          </label>
          <p class="hint">The report adds technical details (app version, browser, recent errors) but no client names, figures or files. If QuickBooks data is part of the problem, say which report and client, and send the file separately only if you are comfortable to.</p>
          <div class="backup-actions">
            ${report.mailto && html`<a class="btn primary" href=${report.mailto} onClick=${() => setStatus('Your email program should open with the report filled in. If nothing happens, use Copy report and paste it into an email.')}>${Icon.flag}Email the report</a>`}
            <button class="btn" onClick=${() => { setShowDetails(true); copyText(full, pre.current).then(setStatus); }}>${Icon.copy}Copy report</button>
            <button class="btn" onClick=${async () => setStatus(await saveTextFile(`ledger-lens-problem-${new Date().toISOString().slice(0, 10)}.txt`, full))}>${Icon.download}Download</button>
          </div>
          <p class="backup-status" role="status">${status}</p>
          <button class="linkish" aria-expanded=${showDetails} onClick=${() => setShowDetails(!showDetails)}>${showDetails ? 'Hide' : 'Show'} what the report contains</button>
          <pre class="problem-details" hidden=${!showDetails} ref=${pre}>${full}</pre>
        </div>
      </aside>
    </div>`;
  }

  // Catches a crash anywhere in the page so it shows a way out instead of a blank screen.
  class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { failed: null, reporting: false }; }
    static getDerivedStateFromError(error) { return { failed: error }; }
    componentDidCatch(error, info) {
      const stack = info && info.componentStack ? info.componentStack.trim().split('\n').slice(0, 3).map((s) => s.trim()).join(' < ') : '';
      Problem.note('crash', (error && error.message) || String(error), stack);
    }
    render() {
      if (!this.state.failed) return this.props.children;
      return html`<div class="wrap crashed">
        <h1>Something went wrong</h1>
        <p>This part of Ledger Lens stopped working. Your saved clients and reviews are safe in this browser. Reload the page to carry on, and please report it so it can be fixed.</p>
        <div class="backup-actions">
          <button class="btn primary" onClick=${() => location.reload()}>Reload the page</button>
          <button class="btn" onClick=${() => this.setState({ reporting: true })}>${Icon.flag}Report a problem</button>
        </div>
        ${this.state.reporting && html`<${ProblemDrawer} context=${{ 'Crashed with': (this.state.failed && this.state.failed.message) || '' }} onClose=${() => this.setState({ reporting: false })} />`}
      </div>`;
    }
  }

  Object.assign(UI, { ProblemDrawer, ErrorBoundary });
})();
