/* Ledger Lens UI: letting the bookkeeper arrange each page.
 *
 * Every page lists its movable sections as parts: [id, label, content]. In normal use they show
 * in the saved order with hidden ones left out; in Customize mode each gets a bar with Move up,
 * Move down and Hide. The KPI tiles and input panels at the top of a page stay where they are,
 * because other sections and the guide refer to them. Tabs can be reordered and hidden too.
 * The layout is saved in this browser for all clients and goes into backups.
 */
(function () {
  'use strict';
  const { useContext, createContext } = React;
  const html = htm.bind(React.createElement);
  const UI = window.LedgerUI;
  const { safeStore } = UI;

  const KEY = 'll.layout';
  // { pages: { audit: { order: [ids], hidden: [ids] } }, tabs: { order: [ids], hidden: [ids] } }
  const Layout = {
    load() { try { const v = JSON.parse(safeStore.get(KEY) || 'null'); return v && typeof v === 'object' ? { pages: v.pages || {}, tabs: v.tabs || {} } : { pages: {}, tabs: {} }; } catch (e) { return { pages: {}, tabs: {} }; } },
    save(layout) { safeStore.set(KEY, JSON.stringify(layout)); },
    isEmpty(layout) { return !Object.keys(layout.pages || {}).length && !(layout.tabs && ((layout.tabs.order || []).length || (layout.tabs.hidden || []).length)); },
  };

  // Puts ids in the saved order. Ids the saved order doesn't know (new sections, or ones added in
  // an update) go back to their usual position.
  function arrangeIds(defaults, saved) {
    const known = new Set(defaults);
    const out = (saved || []).filter((id) => known.has(id));
    const placed = new Set(out);
    defaults.forEach((id, i) => { if (!placed.has(id)) out.splice(Math.min(i, out.length), 0, id); });
    return out;
  }

  // Moves `id` one step past the next item that is actually shown (`shown` ids), so a move is
  // never wasted on a section this client has nothing for.
  function moveId(order, id, dir, shown) {
    const list = order.slice();
    const from = list.indexOf(id);
    let to = from + dir;
    while (to >= 0 && to < list.length && !shown.has(list[to])) to += dir;
    if (from < 0 || to < 0 || to >= list.length) return list;
    list.splice(from, 1);
    list.splice(to, 0, id);
    return list;
  }

  const LayoutContext = createContext({ customizing: false, layout: { pages: {}, tabs: {} }, setLayout: () => {} });

  const upIcon = html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>`;
  const downIcon = html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg>`;

  // parts: [id, label, content]; content that is empty for this client is skipped.
  function Arrange({ page, parts }) {
    const { customizing, layout, setLayout, revealedPart } = useContext(LayoutContext);
    const saved = (layout.pages && layout.pages[page]) || {};
    const byId = new Map(parts.map(([id, label, node]) => [id, { label, node }]));
    const order = arrangeIds(parts.map((p) => p[0]), saved.order);
    const hidden = new Set(saved.hidden || []);
    const shownIds = order.filter((id) => byId.get(id).node);
    const shown = new Set(shownIds);
    // The wrapper takes no space (display: contents); it names the section for Flag a problem.
    if (!customizing) return shownIds.filter((id) => !hidden.has(id) || revealedPart === `${page}:${id}`).map((id) => html`<div key=${id} class="part" data-part=${`${page}:${id}`} data-part-label=${byId.get(id).label}>${byId.get(id).node}</div>`);
    const update = (next) => setLayout({ ...layout, pages: { ...layout.pages, [page]: { order: next.order || order, hidden: next.hidden || [...hidden] } } });
    return shownIds.map((id, i) => {
      const { label, node } = byId.get(id);
      const off = hidden.has(id);
      return html`<div key=${id} class=${`arrange-item ${off ? 'off' : ''}`} data-part=${id}>
        <div class="arrange-bar">
          <span class="arrange-label">${label}${off ? html` <span class="pill low">Hidden</span>` : ''}</span>
          <span class="arrange-actions">
            <button class="btn" aria-label=${`Move ${label} up`} disabled=${i === 0} onClick=${() => update({ order: moveId(order, id, -1, shown) })}>${upIcon}</button>
            <button class="btn" aria-label=${`Move ${label} down`} disabled=${i === shownIds.length - 1} onClick=${() => update({ order: moveId(order, id, 1, shown) })}>${downIcon}</button>
            <button class="btn" onClick=${() => update({ hidden: off ? [...hidden].filter((h) => h !== id) : [...hidden, id] })}>${off ? 'Show' : 'Hide'}</button>
          </span>
        </div>
        ${!off && html`<div class="arrange-body">${node}</div>`}
      </div>`;
    });
  }

  // The bar shown at the top while customizing: what to do, the tabs, Reset and Done.
  function CustomizeBar({ tabs, current, pageLabel, onDone }) {
    const { layout, setLayout } = useContext(LayoutContext);
    const order = arrangeIds(tabs.map((t) => t[0]), layout.tabs && layout.tabs.order);
    const hidden = new Set((layout.tabs && layout.tabs.hidden) || []);
    const label = (id) => (tabs.find((t) => t[0] === id) || [])[1];
    const setTabs = (next) => setLayout({ ...layout, tabs: { order: next.order || order, hidden: next.hidden || [...hidden] } });
    const all = new Set(order);
    const resetPage = () => { const pages = { ...layout.pages }; delete pages[current]; setLayout({ ...layout, pages }); };
    return html`<section class="panel customize-bar" aria-label="Customize">
      <div class="panel-head">
        <h2>Customize ${pageLabel}</h2>
        <p>Use the arrows to move a section up or down, and Hide for ones you don't use. Your layout is saved in this browser for every client. The figures at the top of each page stay put.</p>
        <div class="customize-actions">
          <button class="btn" onClick=${resetPage}>Reset this page</button>
          <button class="btn primary" onClick=${onDone}>Done</button>
        </div>
      </div>
      <div class="panel-body">
        <h3 class="customize-sub">Tabs</h3>
        <ul class="tab-arrange">
          ${order.map((id, i) => {
            const off = hidden.has(id);
            return html`<li key=${id} class=${off ? 'off' : ''}>
              <span>${label(id)}</span>
              <button class="btn" aria-label=${`Move ${label(id)} tab earlier`} disabled=${i === 0} onClick=${() => setTabs({ order: moveId(order, id, -1, all) })}>${upIcon}</button>
              <button class="btn" aria-label=${`Move ${label(id)} tab later`} disabled=${i === order.length - 1} onClick=${() => setTabs({ order: moveId(order, id, 1, all) })}>${downIcon}</button>
              <button class="btn" disabled=${!off && id === current} title=${id === current ? 'This is the page you are on' : ''} onClick=${() => setTabs({ hidden: off ? [...hidden].filter((h) => h !== id) : [...hidden, id] })}>${off ? 'Show' : 'Hide'}</button>
            </li>`;
          })}
        </ul>
        ${!Layout.isEmpty(layout) && html`<p><button class="linkish" onClick=${() => setLayout({ pages: {}, tabs: {} })}>Reset every page and tab to the original layout</button></p>`}
      </div>
    </section>`;
  }

  Object.assign(UI, { Arrange, CustomizeBar, LayoutContext, Layout, arrangeIds, moveId });
})();
