/* Ledger Lens UI: top-level app. */
(function () {
  'use strict';
  const { useState, useMemo, useEffect, useRef, useCallback } = React;
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const UI = window.LedgerUI;
  const { safeStore, ClientStore, emptyProfile, excelToCsv, useDebounced, Icon, AuditTab, GrowthTab, Banner, CashTab, BreakEvenTab, TrendsTab, BudgetTab, VendorsTab, BenchmarksTab, AdvisoryTab, QuestionsDrawer, ClientsDrawer, ReportDrawer, HelpDrawer, Firm, Backup, CloseTab, ProblemDrawer, ErrorBoundary, LayoutContext, CustomizeBar, Layout, arrangeIds, Portal, HomePage, LenderDrawer, LandscapeTab, IndustryPick, FlagFlow, AssetsTab, FraudTab, Drive, useDrive } = UI;

  const Work = window.LedgerWork;
  const { FileStore, AttachStore } = window.LedgerStore;

  // The analysis for the loaded transactions. Small exports are analyzed right away; large ones
  // in the background, keeping the last result on screen (for the same data) until the new one
  // arrives. `analyzing` is true while background work is under way.
  function useAnalysis(parsedOk, opts) {
    const background = Work.background(parsedOk);
    const now = useMemo(() => (parsedOk && opts && !background ? E.analyze(parsedOk, opts) : null), [parsedOk, opts, background]);
    const [later, setLater] = useState({ result: null, of: null, busy: false });
    useEffect(() => {
      if (!background || !opts) return undefined;
      let live = true;
      setLater((prev) => ({ ...prev, busy: true }));
      Work.analyze(parsedOk, opts).then((result) => {
        if (live && result) setLater({ result, of: parsedOk, busy: false });
      }, (e) => {
        if (!live) return;
        if (window.LedgerProblem) window.LedgerProblem.note('error', `analysis: ${e.message}`);
        // Last resort: do it on the page.
        setLater({ result: E.analyze(parsedOk, opts), of: parsedOk, busy: false });
      });
      return () => { live = false; };
    }, [parsedOk, opts, background]);
    if (!background) return { result: now, analyzing: false };
    return { result: later.of === parsedOk ? later.result : null, analyzing: later.busy || later.of !== parsedOk };
  }

  const TABS = [
    ['audit', 'Diagnostic audit'],
    ['close', 'Month-end close'],
    ['growth', 'Growth & profitability insights'],
    ['cash', 'Cash forecast'],
    ['breakeven', 'Break-even'],
    ['trends', 'Trends'],
    ['budget', 'Budget'],
    ['vendors', 'Vendors'],
    ['benchmarks', 'Benchmarks'],
    ['advisory', 'Tax & lending'],
    ['assets', 'Fixed assets'],
  ];
  // Tabs for one industry, placed after the profitability tab.
  const INDUSTRY_TABS = { landscaping: [['landscape', 'Landscaping'], ['fraud', 'Fraud risk']] };
  const tabsFor = (industry) => (INDUSTRY_TABS[industry] ? [...TABS.slice(0, 3), ...INDUSTRY_TABS[industry], ...TABS.slice(3)] : TABS);

  // ------------------------------------------------------------ top-level app

  function App() {
    // The page opens on Home; 'sample' and 'upload' show an analysis.
    const [source, setSource] = useState({ kind: 'home' });
    const home = source.kind === 'home';
    const sourceRef = useRef(source);
    sourceRef.current = source;
    const [error, setError] = useState('');
    const [tab, setTab] = useState(() => safeStore.get('ll.tab') || 'audit');
    const [groupBy, setGroupBy] = useState('customer');
    const [accountClass, setAccountClass] = useState({});
    const [reportOpen, setReportOpen] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [benchmarks, setBenchmarks] = useState(null);
    const [reviewed, setReviewed] = useState({});
    const [benchPrefs, setBenchPrefs] = useState(null);
    const [restored, setRestored] = useState(null);
    const [questionsOpen, setQuestionsOpen] = useState(false);
    const [clientsOpen, setClientsOpen] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const [problemOpen, setProblemOpen] = useState(false);
    // Flag a problem: picking a part of the page to send as a ticket (src/ui/ticket.js).
    const [flagging, setFlagging] = useState(false);
    // The bookkeeper's arrangement of pages and tabs (src/ui/arrange.js).
    const [layout, setLayoutState] = useState(() => Layout.load());
    const setLayout = useCallback((next) => { Layout.save(next); setLayoutState(next); }, []);
    const [customizing, setCustomizing] = useState(false);
    const layoutCtx = useMemo(() => ({ customizing, layout, setLayout }), [customizing, layout, setLayout]);
    // Number of files being read, for the progress note.
    const [reading, setReading] = useState(0);
    const [welcome, setWelcome] = useState(() => !safeStore.get('ll.welcomed'));
    const dismissWelcome = () => { safeStore.set('ll.welcomed', '1'); setWelcome(false); };
    // Checked when the page opens and whenever the backup drawer closes.
    const [backupDue, setBackupDue] = useState(() => Backup.overdue());
    const [backupSnoozed, setBackupSnoozed] = useState(false);
    // Where saved clients are kept, and whether the last save worked (see src/store.js).
    const [storage, setStorage] = useState(() => ClientStore.status);
    useEffect(() => { ClientStore.statusListeners.add(setStorage); return () => ClientStore.statusListeners.delete(setStorage); }, []);
    const [scenario, setScenario] = useState({ levers: [] });
    const [budgetPrefs, setBudgetPrefs] = useState({ mode: 'auto', revenueGrowth: '10', costGrowth: '5' });
    // Snapshot of the months the bookkeeper closed, to catch later edits to them.
    const [closed, setClosed] = useState(null);
    // Month-end checklist ticks by month, plus steps this client needs beyond the standard ones.
    const [checklist, setChecklist] = useState({});
    const [customSteps, setCustomSteps] = useState([]);
    const loadedAtRef = useRef(null);
    // Answers returned by the client in the questions spreadsheet, by the key of the item asked about.
    const [answers, setAnswers] = useState({});
    // The client's answer link, if one was sent (src/ui/portal.js).
    const [portal, setPortal] = useState(null);
    // The client asked for a lender-ready package (Tax & lending tab).
    const [loanRequest, setLoanRequest] = useState(null);
    // The client's fixed asset register (Fixed assets tab).
    const [assets, setAssets] = useState([]);
    // The client's industry: '' means detected from the file (landscaping adds its own tab).
    const [industry, setIndustry] = useState('');
    const [lenderOpen, setLenderOpen] = useState(false);
    const [pendingAnswers, setPendingAnswers] = useState(null);
    const [notice, setNotice] = useState(null);
    // What the last upload did with each file, so nothing is silently ignored.
    const [uploadNote, setUploadNote] = useState(null);
    // Firm's own receipt limit for this client (blank: only the IRS categories and $2,500+).
    const [receiptLimit, setReceiptLimit] = useState('');
    const [loanInputs, setLoanInputs] = useState({ amount: '', rate: '10.5', years: '10', addBacks: '' });
    const [taxInputs, setTaxInputs] = useState({ entity: 'sole', rate: '', salary: '', paid: '' });
    // Forecast inputs. Empty strings mean "use the value estimated from the export".
    const [cashInputs, setCashInputs] = useState({ startingCash: '', cushion: '', includeDoubtful: false });

    const sampleText = useMemo(() => window.LedgerSample.build(), []);
    // One or more uploaded exports are parsed separately, then merged.
    const parsed = useMemo(() => {
      try {
        if (source.kind === 'home') return {};
        if (source.kind === 'sample') return { ok: E.parseTransactions(sampleText) };
        return { ok: E.mergeParsed(source.files.map((f) => f.parsed)) };
      } catch (e) { return { err: e.message }; }
    }, [source, sampleText]);
    // The chart of accounts, when one was loaded, gives exact account types.
    const sampleChart = useMemo(() => E.parseChartOfAccounts(window.LedgerSample.chartOfAccounts()), []);
    const chart = source.kind === 'sample' ? sampleChart : source.chart ? source.chart.parsed : null;
    const samplePnl = useMemo(() => E.parseProfitAndLoss(window.LedgerSample.profitAndLoss()), []);
    const pnl = source.kind === 'sample' ? samplePnl : source.pnl ? source.pnl.parsed : null;
    const sampleBudget = useMemo(() => E.parseBudget(window.LedgerSample.budgetOverview()), []);
    const sampleAttachments = useMemo(() => E.parseAttachmentList(window.LedgerSample.expenseList()), []);
    const attachments = source.kind === 'sample' ? sampleAttachments.entries : source.attachments ? source.attachments.parsed.entries : null;
    const uploadedBudget = source.kind === 'sample' ? { name: 'Sample FY2026 budget', parsed: sampleBudget } : source.budget || null;

    // Stable object: it only changes when one of the inputs does.
    const typedNow = useMemo(() => ({ cash: cashInputs, loan: loanInputs, tax: taxInputs, scenario, budget: budgetPrefs }), [cashInputs, loanInputs, taxInputs, scenario, budgetPrefs]);
    const typed = useDebounced(typedNow, 300);
    const startingCash = typed.cash.startingCash === '' ? undefined : parseFloat(typed.cash.startingCash);
    const analyzeOpts = useMemo(() => (parsed.ok ? ({
      accountClass, groupBy, chart, pnl, reviewed, closed, answers, attachments, receiptLimit: parseFloat(receiptLimit) || 0, scenario: typed.scenario, industry: industry || undefined, assets, customers: source.customers ? source.customers.parsed : null,
      voided: source.voided ? source.voided.parsed : null, employees: source.employees ? source.employees.parsed : null,
      budget: uploadedBudget && typed.budget.mode !== 'history' ? uploadedBudget.parsed : null,
      budgetGrowth: { revenueGrowth: parseFloat(typed.budget.revenueGrowth) || 0, costGrowth: parseFloat(typed.budget.costGrowth) || 0 },
      cushion: typed.cash.cushion === '' ? undefined : parseFloat(typed.cash.cushion),
      loan: { amount: parseFloat(typed.loan.amount) || 0, rate: parseFloat(typed.loan.rate) || 0, years: parseFloat(typed.loan.years) || 10, addBacks: parseFloat(typed.loan.addBacks) || 0 },
      tax: { entity: typed.tax.entity, rate: typed.tax.rate === '' ? undefined : parseFloat(typed.tax.rate), salary: parseFloat(typed.tax.salary) || 0, paid: typed.tax.paid === '' ? undefined : parseFloat(typed.tax.paid) }, startingCash: isNaN(startingCash) ? undefined : startingCash, includeDoubtful: cashInputs.includeDoubtful,
    }) : null), [parsed, accountClass, groupBy, chart, pnl, uploadedBudget, reviewed, closed, answers, attachments, receiptLimit, startingCash, cashInputs.includeDoubtful, typed, industry, assets]);
    // Large exports are analyzed in the background so the page stays responsive (src/work.js).
    const { result, analyzing } = useAnalysis(parsed.ok, analyzeOpts);
    // The industry's own tab shows once the analysis knows the industry.
    const [lastIndustry, setLastIndustry] = useState('general');
    useEffect(() => { if (result) setLastIndustry(result.industry || 'general'); }, [result]);
    const tabs = tabsFor(result ? result.industry : lastIndustry);
    const tabOrder = arrangeIds(tabs.map((t) => t[0]), layout.tabs.order);
    const hiddenTabs = new Set(layout.tabs.hidden || []);
    // A hidden tab, or another industry's tab, can't stay open: go to the first one shown.
    useEffect(() => {
      if ((hiddenTabs.has(tab) && !customizing) || (result && !tabOrder.includes(tab))) setTab(tabOrder.find((t) => !hiddenTabs.has(t)) || 'audit');
    }, [layout, tab, customizing, result]);

    // Restore a client's saved settings when their file loads; the sample always starts clean.
    const clientId = source.kind === 'upload' && parsed.ok ? E.clientKey(parsed.ok.meta) : null;
    // A sync that brings in this client's work from another device loads it again, so the
    // next save here builds on it instead of writing over it.
    const [syncTick, setSyncTick] = useState(0);
    const driveState = useDrive();
    const [driveLater, setDriveLater] = useState(false);
    const fromSyncRef = useRef(false);
    useEffect(() => {
      const f = (info) => { if (info.synced && clientId && (info.ids || []).includes(clientId)) { fromSyncRef.current = true; setSyncTick((n) => n + 1); } };
      ClientStore.listeners.add(f);
      return () => ClientStore.listeners.delete(f);
    }, [clientId]);
    useEffect(() => {
      const fromSync = fromSyncRef.current;
      fromSyncRef.current = false;
      const saved = ClientStore.get(clientId);
      setAccountClass(saved ? saved.accountClass || {} : {});
      setReviewed(saved ? saved.reviewed || {} : {});
      setClosed(saved && saved.closed ? saved.closed : null);
      // After a sync, keep the other device's copy as it is, so it isn't saved again as a change.
      loadedAtRef.current = fromSync && saved ? saved.loadedAt || null : clientId ? new Date().toISOString() : null;
      setChecklist(saved && saved.checklist ? saved.checklist : {});
      setCustomSteps(saved && saved.customSteps ? saved.customSteps : []);
      setAnswers(saved && saved.answers ? saved.answers : {});
      setPortal(saved && saved.portal ? saved.portal : null);
      setLoanRequest(saved && saved.loanRequest ? saved.loanRequest : null);
      setIndustry(saved && saved.industry ? saved.industry : '');
      setAssets(saved && Array.isArray(saved.assets) ? saved.assets : []);
      setReceiptLimit(saved && saved.receiptLimit ? String(saved.receiptLimit) : '');
      setCashInputs({ startingCash: '', cushion: saved && saved.cushion ? String(saved.cushion) : '', includeDoubtful: false });
      setBenchPrefs(saved ? saved.bench || null : null);
      setScenario({ levers: [] });
      setBudgetPrefs(saved && saved.budgetPrefs ? saved.budgetPrefs : { mode: 'auto', revenueGrowth: '10', costGrowth: '5' });
      setLoanInputs(saved && saved.loan ? saved.loan : { amount: '', rate: '10.5', years: '10', addBacks: '' });
      setTaxInputs(saved && saved.tax ? saved.tax : { entity: 'sole', rate: '', salary: '', paid: '' });
      setRestored(saved && !emptyProfile(saved) ? { name: saved.name, updatedAt: saved.updatedAt, corrections: Object.keys(saved.accountClass || {}).length, reviews: Object.keys(saved.reviewed || {}).length, synced: fromSync } : null);
    }, [source, clientId, syncTick]);
    // A short summary of where this client stands, for the all-clients dashboard. Compared as
    // text so it only saves when something in it actually changed.
    const summaryJson = useMemo(() => (clientId && result ? JSON.stringify(E.clientSummary(result, checklist, customSteps)) : ''), [clientId, result, checklist, customSteps]);
    // Save as the bookkeeper works. Every client whose export is loaded is kept, so they
    // show on the dashboard even before anything is reviewed.
    useEffect(() => {
      if (!clientId || !summaryJson) return;
      const saved = ClientStore.get(clientId);
      const profile = { name: parsed.ok.meta.company || clientId, accountClass, reviewed, closed, checklist, customSteps, answers, portal, loanRequest, industry, assets, receiptLimit, cushion: cashInputs.cushion || '', bench: benchPrefs, loan: loanInputs, tax: taxInputs, budgetPrefs,
        summary: JSON.parse(summaryJson), loadedAt: loadedAtRef.current || (saved && saved.loadedAt) || new Date().toISOString() };
      ClientStore.put(clientId, profile);
    }, [clientId, summaryJson, accountClass, reviewed, closed, checklist, customSteps, answers, portal, loanRequest, industry, assets, receiptLimit, cashInputs.cushion, benchPrefs, loanInputs, taxInputs, budgetPrefs]);
    // Keep a copy of this client's files in the browser, so the Clients panel can reopen them.
    useEffect(() => {
      if (!clientId || source.kind !== 'upload') return;
      const list = [...source.files, source.chart, source.pnl, source.budget, source.attachments, source.customers, source.voided, source.employees].filter(Boolean);
      if (!list.every((f) => typeof f.text === 'string')) return;
      FileStore.put(clientId, list.map((f) => ({ name: f.name, text: f.text })));
    }, [clientId, source]);
    // Collects answers clients sent through their answer links: when the page opens, when a
    // client is loaded, every few minutes while one is waiting, and on request.
    const portalRef = useRef(portal);
    portalRef.current = portal;
    const collectPortal = useCallback(async () => {
      if (!Portal.available()) return 0;
      try {
        const got = await Portal.collectAnswers({
          openId: clientId,
          openRecord: portalRef.current,
          applyOpen: (entries, record) => { setAnswers((prev) => ({ ...prev, ...entries })); setPortal(record); },
        });
        const n = got.reduce((t, g) => t + g.count, 0);
        if (n) setNotice(`${got.map((g) => `${g.name} answered ${g.count} question${g.count === 1 ? '' : 's'}`).join('; ')} through the answer link. The answers are under Client answers on the audit tab.`);
        return n;
      } catch (e) { window.LedgerProblem.note('error', `answer link: ${e.message}`); return 0; }
    }, [clientId]);
    useEffect(() => {
      collectPortal();
      const t = setInterval(() => { if (document.visibilityState === 'visible') collectPortal(); }, 3 * 60 * 1000);
      return () => clearInterval(t);
    }, [collectPortal]);
    // Match a returned questions spreadsheet to the current questions and keep the answers.
    const applyAnswers = useCallback((file) => {
      if (!result) return '';
      const m = E.matchAnswers(result, file.parsed);
      if (!m.matched.length) return `${file.name}: no answers matched the current questions${m.unmatched.length ? ' (they may be for another client, or already cleared)' : ''}.`;
      const at = new Date().toISOString().slice(0, 10);
      setAnswers((prev) => {
        const next = { ...prev };
        for (const a of m.matched) next[a.key] = { ref: a.ref, topic: a.topic, question: a.question, answer: a.answer, receipt: a.receipt, at };
        return next;
      });
      return `Loaded ${m.matched.length} answer${m.matched.length === 1 ? '' : 's'} from ${file.name}${m.unmatched.length ? `; ${m.unmatched.length} row${m.unmatched.length === 1 ? '' : 's'} did not match a current question` : ''}. They are listed under Client answers on the audit tab.`;
    }, [result]);
    useEffect(() => {
      if (!pendingAnswers || !result) return;
      if (!clientId && source.kind !== 'sample') return;
      setNotice(applyAnswers(pendingAnswers));
      setPendingAnswers(null);
    }, [pendingAnswers, result, clientId, source, applyAnswers]);
    const setReview = useCallback((keys, status) => {
      setReviewed((prev) => {
        const next = { ...prev };
        for (const k of [].concat(keys)) {
          if (!status) delete next[k];
          else next[k] = { status, at: new Date().toISOString().slice(0, 10) };
        }
        return next;
      });
    }, []);
    // Default cushion: one month of fixed costs, rounded to the nearest $1,000.
    const defaultCushion = result && result.breakeven ? Math.round(result.breakeven.base.fixed / 1000) * 1000 : 0;
    const cushion = cashInputs.cushion === '' || isNaN(parseFloat(cashInputs.cushion)) ? defaultCushion : parseFloat(cashInputs.cushion);

    useEffect(() => { safeStore.set('ll.tab', tab); }, [tab]);
    useEffect(() => { if (parsed.err) setError(parsed.err); }, [parsed]);

    const readFile = (file) => new Promise((resolve) => {
      const excel = /\.(xlsx|xlsm|xls)$/i.test(file.name);
      if (!excel && !/\.(csv|txt)$/i.test(file.name)) { resolve({ name: file.name, error: 'is not a CSV or Excel file. In QuickBooks, open the report and choose Export.' }); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          // Recognizes the report and parses it, in the background where possible.
          const r = await Work.read(excel ? { buffer: reader.result, excelToCsv } : { text: String(reader.result || '') });
          resolve({ name: file.name, text: r.text, [r.kind]: r.data });
        } catch (e) { resolve({ name: file.name, error: e.message }); }
      };
      reader.onerror = () => resolve({ name: file.name, error: 'could not be read.' });
      if (excel) reader.readAsArrayBuffer(file); else reader.readAsText(file);
    });

    // Uses files that have been read (see readFile). With `append`, adds them to the files already
    // loaded (a file with the same name replaces the earlier copy). `opened` names the client
    // when the files came from the copies saved in this browser.
    const ingest = useCallback((results, append, opened) => {
      const bad = results.filter((r) => r.error);
      const good = results.filter((r) => r.parsed);
      const lastOf = (key) => { const hits = results.filter((r) => r[key]); return hits.length ? { name: hits[hits.length - 1].name, parsed: hits[hits.length - 1][key], text: hits[hits.length - 1].text } : null; };
      const chartFile = lastOf('chart');
      const pnlFile = lastOf('pnl');
      const budgetFile = lastOf('budget');
      const attachFile = lastOf('attachments');
      const customersFile = lastOf('customers');
      const voidedFile = lastOf('voided');
      const employeesFile = lastOf('employees');
      const answersFile = lastOf('answers');
      if (answersFile) setPendingAnswers(answersFile);
      const errors = bad.map((b) => `${b.name} ${b.error}`);
      const KIND = { parsed: 'transactions', chart: 'chart of accounts', pnl: 'Profit and Loss', budget: 'budget', attachments: 'expense list with attachments', customers: 'customer contact list', voided: 'voided and deleted transactions', employees: 'employee list', answers: "client's answers" };
      const seen = results.filter((r) => !r.error).map((r) => `${r.name} (${KIND[Object.keys(KIND).find((k) => r[k])] || 'file'})`);
      setUploadNote(results.length ? { count: results.length, seen, skipped: bad.length, opened } : null);
      const prev = sourceRef.current;
      if (!good.length) {
        // A chart or P&L on its own attaches to the transactions already loaded.
        const extra = chartFile || pnlFile || budgetFile || attachFile || customersFile || voidedFile || employeesFile;
        if (extra && prev.kind === 'upload') setSource({ ...prev, chart: chartFile || prev.chart, pnl: pnlFile || prev.pnl, budget: budgetFile || prev.budget, attachments: attachFile || prev.attachments, customers: customersFile || prev.customers, voided: voidedFile || prev.voided, employees: employeesFile || prev.employees });
        else if (extra) errors.push(`${extra.name} is a ${chartFile ? 'chart of accounts' : pnlFile ? 'Profit and Loss report' : budgetFile ? 'budget' : attachFile ? 'list of expenses with attachments' : customersFile ? 'customer contact list' : voidedFile ? 'voided and deleted transactions report' : 'employee list'}. Upload the client's Transaction Detail with it.`);
      } else {
        const keepPrev = append && prev.kind === 'upload';
        const kept = keepPrev ? prev.files.filter((f) => !good.some((g) => g.name === f.name)) : [];
        setSource({ kind: 'upload', files: [...kept, ...good], chart: chartFile || (keepPrev ? prev.chart : null), pnl: pnlFile || (keepPrev ? prev.pnl : null), budget: budgetFile || (keepPrev ? prev.budget : null), attachments: attachFile || (keepPrev ? prev.attachments : null), customers: customersFile || (keepPrev ? prev.customers : null), voided: voidedFile || (keepPrev ? prev.voided : null), employees: employeesFile || (keepPrev ? prev.employees : null) });
      }
      setError(errors.join(' '));
    }, []);

    const loadFiles = useCallback(async (fileList, append) => {
      const files = [...(fileList || [])];
      if (!files.length) return;
      setReading(files.length);
      const results = await Promise.all(files.map(readFile)).finally(() => setReading(0));
      ingest(results, append);
    }, [ingest]);

    const loadSample = () => { setError(''); setAccountClass({}); setCashInputs({ startingCash: '', cushion: '', includeDoubtful: false }); setUploadNote(null); setSource({ kind: 'sample' }); };
    const goHome = () => { setCustomizing(false); setUploadNote(null); setError(''); setSource({ kind: 'home' }); };
    // Reopens a client from the copies of their files saved in this browser.
    const openClient = useCallback(async (id) => {
      const saved = await FileStore.get(id);
      if (!saved || !saved.length) { setError('The saved files for this client could not be found. Upload their exports again.'); return; }
      setReading(saved.length);
      const results = await Promise.all(saved.map((f) => Work.read({ text: f.text }).then((r) => ({ name: f.name, text: r.text, [r.kind]: r.data }), (e) => ({ name: f.name, error: e.message })))).finally(() => setReading(0));
      ingest(results, false, (ClientStore.get(id) || {}).name || id);
    }, [ingest]);

    useEffect(() => {
      let depth = 0;
      const enter = (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; setDragging(true); e.preventDefault(); } };
      const over = (e) => { if (dragging || depth) e.preventDefault(); };
      const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
      const drop = (e) => { e.preventDefault(); depth = 0; setDragging(false); loadFiles(e.dataTransfer.files, e.shiftKey); };
      window.addEventListener('dragenter', enter); window.addEventListener('dragover', over);
      window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
      return () => {
        window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over);
        window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop);
      };
    }, [loadFiles, dragging]);

    // On the hosted site, visitors signed in to get here; offer a way out.
    const cfg = window.LedgerConfig || {};
    const signedInSite = !!cfg.signIn && (cfg.googleOrigins || []).includes(window.location.origin);
    const closeProgress = useMemo(() => {
      if (!result || !result.closableMonths || !result.closableMonths.length) return '';
      const m = result.closableMonths[result.closableMonths.length - 1];
      const c = E.closeChecklist(result, m, checklist[m], customSteps);
      return `${c.done}/${c.total}`;
    }, [result, checklist, customSteps]);
    // Facts about what is on screen for a problem report: no client names or figures.
    const problemContext = useMemo(() => ({
      Tab: home ? 'home' : tab,
      Data: source.kind === 'home' ? 'none (Home)' : source.kind === 'sample' ? 'sample' : `${source.files.length} transaction file(s)${source.chart ? ', chart of accounts' : ''}${source.pnl ? ', P&L' : ''}${uploadedBudget ? ', budget' : ''}${source.attachments ? ', expense list' : ''}${result ? `, ${result.count} rows, ${result.period.start} to ${result.period.end}` : ''}`,
      'Message on screen': error,
    }), [tab, source, uploadedBudget, result, error]);
    useEffect(() => { if (error) window.LedgerProblem.note('shown', error); }, [error]);
    // Client words to blank out of a ticket's picture: company, customers, vendors, file names.
    const flagNames = useCallback(() => {
      const out = new Set();
      if (parsed.ok) {
        out.add(parsed.ok.meta.company);
        for (const t of parsed.ok.transactions) for (const v of [t.name, t.customer, t.vendor, t.project]) if (v) { out.add(v); for (const piece of String(v).split(':')) out.add(piece); }
      }
      if (source.files) for (const f of source.files) out.add(f.name);
      for (const f of [source.chart, source.pnl, source.budget, source.attachments, source.customers, source.voided, source.employees]) if (f && f.name) out.add(f.name);
      if (source.employees) for (const e of source.employees.parsed.employees) out.add(e.name);
      if (source.voided) for (const x of source.voided.parsed.entries) if (x.name) out.add(x.name);
      for (const c of Object.values(ClientStore.all())) out.add(c.name);
      return [...out];
    }, [parsed, source]);
    const auditCount = result ? result.audit.open.uncategorized + result.audit.open.duplicates + result.audit.open.mismatches : 0;

    return html`<${LayoutContext.Provider} value=${layoutCtx}>
      <header class="topbar">
        <div class="wrap">
          <div class="brand">
            ${Firm.mark
              ? html`<img class="brand-logo" src=${Firm.mark} alt="" />`
              : html`<div class="brand-mark" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3M5 7h4M7 5v4"/></svg>
                </div>`}
            <div><h1>${Firm.name || 'Ledger Lens'}</h1><small>${Firm.name ? 'Ledger Lens · QuickBooks review, profitability & cash forecast' : 'QuickBooks audit, profitability & cash forecast'}</small></div>
          </div>
          <div class="actions">
            <label class="btn" for="csv-upload">${Icon.upload}Upload export</label>
            <input id="csv-upload" class="file-input" type="file" multiple accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange=${(e) => { loadFiles(e.target.files, false); e.target.value = ''; }} />
            ${source.kind === 'upload' && html`<label class="btn" for="csv-add">${Icon.upload}Add export</label>
              <input id="csv-add" class="file-input" type="file" multiple accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange=${(e) => { loadFiles(e.target.files, true); e.target.value = ''; }} />`}
            ${source.kind === 'upload' && html`<button class="btn" onClick=${loadSample}>${Icon.sample}Load sample</button>`}
            ${!home && html`<button class="btn" onClick=${goHome}>${Icon.home}Home</button>`}
            <button class="btn" onClick=${() => setClientsOpen(true)}>${Icon.cloud}Clients</button>
            ${!home && html`<button class="btn" disabled=${!result} onClick=${() => setQuestionsOpen(true)}>${Icon.copy}Client questions</button>
            <button class="btn primary" disabled=${!result} onClick=${() => setReportOpen(true)}>${Icon.report}Client report</button>`}
            <button class="btn" onClick=${() => setHelpOpen(true)}>${Icon.help}Help</button>
          </div>
        </div>
      </header>

      <div class="wrap">
        ${!home && html`<div class="source">
          ${source.kind === 'sample'
            ? html`<span class="pill sample"><span class="dot"></span>Sample data</span><span>Showing a fictional design studio. Upload your QuickBooks <strong>Transaction Detail</strong> export (CSV or Excel; several at once is fine, such as one per year), or drop them anywhere on this page.</span>`
            : html`<span class="pill good"><span class="dot"></span>${source.files.length > 1 ? `${source.files.length} files combined` : 'Your file'}</span><strong>${source.files.map((f) => f.name).join(', ')}</strong>${parsed.ok && parsed.ok.meta.droppedOverlap ? html`<span>${parsed.ok.meta.droppedOverlap} overlapping rows skipped</span>` : ''}`}
          ${result && (result.chart
            ? html`<span class="pill good"><span class="dot"></span>Chart of accounts</span><span>${result.chart.matched} of ${result.chart.of} accounts typed from it</span>`
            : source.kind === 'upload' && html`<span class="hint">Add the client's Chart of Accounts export (Account List report) for exact account types.</span>`)}
          ${uploadedBudget && source.kind === 'upload' && html`<span class="pill good"><span class="dot"></span>Budget</span>`}
          ${source.kind === 'upload' && source.attachments && html`<span class="pill good"><span class="dot"></span>Expense list (receipts)</span>`}
          ${source.kind === 'upload' && source.customers && html`<span class="pill good"><span class="dot"></span>Customer addresses</span>`}
          ${source.kind === 'upload' && source.voided && html`<span class="pill good"><span class="dot"></span>Voided/deleted report</span>`}
          ${source.kind === 'upload' && source.employees && html`<span class="pill good"><span class="dot"></span>Employee list</span>`}
          ${result && (result.tieOut
            ? html`<span class=${`pill ${result.tieOut.ties ? 'good' : 'high'}`}><span class="dot"></span>${result.tieOut.ties ? 'Ties to QuickBooks P&L' : 'Does not tie to QuickBooks P&L'}</span>`
            : source.kind === 'upload' && html`<span class="hint">Add the Profit and Loss export for the same dates to confirm the numbers match QuickBooks.</span>`)}
          ${result && html`<${IndustryPick} value=${industry} detected=${result.detectedIndustry} onChange=${setIndustry} />`}
          ${result && html`<span>${result.meta.company && source.kind !== 'sample' ? `${result.meta.company} · ` : ''}${result.period.start} to ${result.period.end} · <span class="num">${result.count.toLocaleString()}</span> rows${result.entryCount !== result.count ? html` (<span class="num">${result.entryCount.toLocaleString()}</span> unique entries)` : ''}</span>`}
        </div>`}
        ${(reading > 0 || analyzing) && html`<div class="working" role="status"><span class="spinner" aria-hidden="true"></span>${reading > 0 ? `Reading ${reading} file${reading === 1 ? '' : 's'}…` : `Analyzing ${parsed.ok ? parsed.ok.transactions.length.toLocaleString() : ''} rows… The page stays usable meanwhile.`}</div>`}
        ${error && html`<div class="error" role="alert">${error}</div>`}
        ${uploadNote && html`<${Banner} level=${uploadNote.skipped ? 'medium' : 'good'} label=${uploadNote.opened ? `Opened ${uploadNote.opened}` : `${uploadNote.count} file${uploadNote.count === 1 ? '' : 's'} uploaded`}>${uploadNote.seen.length ? `Read: ${uploadNote.seen.join(', ')}.` : ''}${uploadNote.skipped ? ` ${uploadNote.skipped} could not be read (see the message above).` : ''}${uploadNote.count === 1 && source.kind === 'upload' && !source.chart && !source.pnl ? ' To add the chart of accounts, Profit and Loss or expense list, select them together with the transactions, or use Add export.' : ''} <button class="linkish" onClick=${() => setUploadNote(null)}>Dismiss</button></${Banner}>`}
        ${notice && html`<${Banner} level="good" label="Client answers">${notice} <button class="linkish" onClick=${() => setNotice(null)}>Dismiss</button></${Banner}>`}
        ${welcome && !home && html`<${Banner} level="good" label="Welcome">New here? The getting-started guide covers which QuickBooks reports to export, a monthly routine and how to send reports. <button class="linkish" onClick=${() => { dismissWelcome(); setHelpOpen(true); }}>Open the guide</button> · <button class="linkish" onClick=${dismissWelcome}>Dismiss</button></${Banner}>`}
        ${storage.error && html`<${Banner} level="high" label="Not saving">Your reviews and settings are not being saved in this browser: ${storage.error}. Download a backup file now so nothing is lost. <button class="linkish" onClick=${() => setClientsOpen(true)}>Back up now</button></${Banner}>`}
        ${!storage.error && ClientStore.nearlyFull() && html`<${Banner} level="medium" label="Storage nearly full">This browser has almost used up the space it allows this site. Back up, then forget clients you no longer work with. <button class="linkish" onClick=${() => setClientsOpen(true)}>Open Clients</button></${Banner}>`}
        ${!welcome && backupDue && !backupSnoozed && html`<${Banner} level="medium" label="Back up">Your saved clients have not been backed up in over 30 days. They live only in this browser. <button class="linkish" onClick=${() => setClientsOpen(true)}>Back up now</button> · <button class="linkish" onClick=${() => setBackupSnoozed(true)}>Later</button></${Banner}>`}
        ${driveState.account && driveState.auto && Drive.enabled() && !Drive.connected() && !driveLater && html`<${Banner} level="medium" label="Sync paused">Connect Google Drive to bring in work from your other devices and keep this one in sync. <button class="linkish" onClick=${() => Drive.connect()}>Connect</button> · <button class="linkish" onClick=${() => setDriveLater(true)}>Not now</button></${Banner}>`}
        ${restored && restored.synced && html`<${Banner} level="good" label="Synced">Brought in the latest work on ${restored.name} from your other device. <button class="linkish" onClick=${() => setRestored(null)}>Dismiss</button></${Banner}>`}
        ${restored && !restored.synced && html`<${Banner} level="good" label="Settings restored">Picked up where you left off with ${restored.name}${restored.updatedAt ? ` (saved ${restored.updatedAt.slice(0, 10)})` : ''}: ${restored.corrections} account type correction${restored.corrections === 1 ? '' : 's'} and ${restored.reviews} reviewed flag${restored.reviews === 1 ? '' : 's'}. <button class="linkish" onClick=${() => setRestored(null)}>Dismiss</button></${Banner}>`}

        ${home && html`<${HomePage} onOpen=${openClient} onUpload=${() => document.getElementById('csv-upload').click()} onSample=${loadSample} onHelp=${() => setHelpOpen(true)} onClients=${() => setClientsOpen(true)} />`}
        ${!home && html`<div class="tabs-row">
          <div class="tabs" role="tablist">
            ${tabOrder.filter((id) => !hiddenTabs.has(id) || id === tab).map((id) => html`<button key=${id} class="tab" role="tab" id=${`tab-${id}`} aria-selected=${tab === id} onClick=${() => setTab(id)}>${tabs.find((t) => t[0] === id)[1]}${id === 'audit' ? html`<span class="count">${auditCount}</span>` : id === 'close' && closeProgress ? html`<span class="count">${closeProgress}</span>` : ''}</button>`)}
          </div>
          ${result && !customizing && html`<button class="btn flag-toggle" onClick=${() => setFlagging(true)}>${Icon.flag}Flag a problem</button>`}
          ${result && !customizing && html`<button class="btn customize-toggle" onClick=${() => setCustomizing(true)}>${Icon.sliders}Customize</button>`}
        </div>`}
        ${customizing && result && html`<${CustomizeBar} tabs=${tabs} current=${tab} pageLabel=${(tabs.find((t) => t[0] === tab) || tabs[0])[1]} onDone=${() => setCustomizing(false)} />`}

        ${!result && analyzing && html`<div class="empty">Working through a large export. The results appear here in a moment.</div>`}
        ${result && html`<main role="tabpanel" aria-labelledby=${`tab-${tab}`} class=${analyzing ? 'stale' : ''} aria-busy=${analyzing ? 'true' : 'false'}>
          ${tab === 'audit' ? html`<${AuditTab} result=${result} accountClass=${accountClass} setAccountClass=${setAccountClass} onReview=${setReview} onClose=${(through) => { if (!through) setClosed(null); else Promise.resolve(result.closeBooks(through)).then(setClosed); }} canSave=${!!clientId} receiptLimit=${receiptLimit} setReceiptLimit=${setReceiptLimit} onRemoveAnswer=${(key) => setAnswers((prev) => { const n = { ...prev }; if (n[key] && n[key].photoKey) { const [c, r] = n[key].photoKey.split('|'); AttachStore.remove(c, r); } delete n[key]; return n; })} />`
            : tab === 'close' ? html`<${CloseTab} result=${result} checklist=${checklist} setChecklist=${setChecklist} customSteps=${customSteps} setCustomSteps=${setCustomSteps} canSave=${!!clientId} goTo=${setTab} />`
            : tab === 'landscape' ? html`<${LandscapeTab} result=${result} inputs=${cashInputs} setInputs=${setCashInputs} />`
            : tab === 'fraud' ? html`<${FraudTab} result=${result} onAdd=${source.kind === 'upload' ? () => document.getElementById('csv-add').click() : null} />`
            : tab === 'growth' ? html`<${GrowthTab} result=${result} groupBy=${groupBy} setGroupBy=${setGroupBy} onReview=${setReview} />`
            : tab === 'cash' ? html`<${CashTab} cash=${result.cash} scenarioCash=${result.cashScenario} scenario=${scenario} setScenario=${setScenario} inputs=${cashInputs} setInputs=${setCashInputs} cushion=${cushion} defaultCushion=${defaultCushion} />`
            : tab === 'breakeven' ? html`<${BreakEvenTab} be=${result.breakeven} onOpenMapping=${() => setTab('audit')} />`
            : tab === 'trends' ? html`<${TrendsTab} trend=${result.trend} />`
            : tab === 'budget' ? html`<${BudgetTab} bva=${result.budget} uploaded=${uploadedBudget} prefs=${budgetPrefs} setPrefs=${setBudgetPrefs} />`
            : tab === 'vendors' ? html`<${VendorsTab} vendors=${result.vendors} />`
            : tab === 'benchmarks' ? html`<${BenchmarksTab} result=${result} onResult=${setBenchmarks} prefs=${benchPrefs} onPrefs=${setBenchPrefs} />`
            : tab === 'assets' ? html`<${AssetsTab} result=${result} assets=${assets} setAssets=${setAssets} canSave=${!!clientId} />`
            : html`<${AdvisoryTab} result=${result} loanRequest=${loanRequest} setLoanRequest=${setLoanRequest} onPackage=${() => setLenderOpen(true)} canSave=${!!clientId} loanInputs=${loanInputs} setLoanInputs=${setLoanInputs} taxInputs=${taxInputs} setTaxInputs=${setTaxInputs} />`}
        </main>`}
        <footer class="foot">Files are processed in your browser and never uploaded. Review settings are saved in this browser only; back them up from Clients. Flags are leads for review, not confirmed errors.${signedInSite ? html` · <a href="/auth/logout">Sign out</a>` : ''} · <button class="linkish" onClick=${() => setFlagging(true)}>Flag a problem</button> · <button class="linkish" onClick=${() => setProblemOpen(true)}>Report a problem</button>${Firm.website ? html` · <a href=${/^https?:/.test(Firm.website) ? Firm.website : `https://${Firm.website}`} target="_blank" rel="noopener">${Firm.website}</a>` : ''}</footer>
      </div>

      ${questionsOpen && result && html`<${QuestionsDrawer} result=${result} answers=${answers} portal=${portal} setPortal=${setPortal} canSave=${!!clientId} onCheckPortal=${collectPortal} onLoadAnswers=${(file) => applyAnswers(file)} onClose=${() => setQuestionsOpen(false)} onMarkAsked=${(keys) => setReview(keys, 'asked')} />`}
      ${helpOpen && html`<${HelpDrawer} onClose=${() => setHelpOpen(false)} onOpenClients=${() => setClientsOpen(true)} onReport=${() => setProblemOpen(true)} />`}
      ${flagging && html`<${FlagFlow} tab=${home ? { id: 'home', label: 'Home' } : { id: tab, label: (tabs.find((t) => t[0] === tab) || tabs[0])[1] }} names=${flagNames} context=${problemContext} onDone=${() => setFlagging(false)} />`}
      ${problemOpen && html`<${ProblemDrawer} context=${problemContext} onClose=${() => setProblemOpen(false)} />`}
      ${clientsOpen && html`<${ClientsDrawer} currentId=${clientId} onOpen=${(id) => { setClientsOpen(false); openClient(id); }} onClose=${() => { setClientsOpen(false); setBackupDue(Backup.overdue()); }} onForget=${(id) => { if (id === clientId) { setAccountClass({}); setReviewed({}); setBenchPrefs(null); setCashInputs({ startingCash: '', cushion: '', includeDoubtful: false }); setRestored(null); } }} />`}
      ${lenderOpen && result && html`<${LenderDrawer} result=${result} request=${loanRequest} setRequest=${setLoanRequest} loanInputs=${loanInputs} setLoanInputs=${setLoanInputs} onClose=${() => setLenderOpen(false)} />`}
      ${reportOpen && result && html`<${ReportDrawer} result=${result} groupBy=${groupBy} cushion=${cushion} benchmarks=${benchmarks} onClose=${() => setReportOpen(false)} />`}
      ${dragging && html`<div class="drop-overlay">Drop the QuickBooks CSV to analyze it</div>`}
    </${LayoutContext.Provider}>`;
  }

  // Saved clients load from the browser's database first, so the page opens with them in place.
  ClientStore.ready.then(() => ReactDOM.createRoot(document.getElementById('root')).render(html`<${ErrorBoundary}><${App} /></${ErrorBoundary}>`));
})();
