// Word Highlighter — content script.
// Highlights saved keywords on every page and words double-clicked on this one,
// keeps up with content the page adds later, marks matches on the scrollbar,
// and answers the popup and the background worker.
(() => {
  // The popup and background re-inject this file into tabs that predate the
  // install. A document without a body (an SVG or XML file) has no text to mark.
  if (window.__wordHighlighterLoaded || !document.body) return;
  window.__wordHighlighterLoaded = true;

  const { PRESETS, normalizeTerm, keyFor, termPattern, inkFor, siteOf, store } = WH;

  const MARK_CLASS = 'word-highlighter-mark';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const MAX_TERM_LENGTH = 100;
  const FLUSH_DELAY_MS = 120;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'CANVAS',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  ]);
  const SKIP_ANCESTORS = [...SKIP_TAGS, 'svg', 'math', `mark.${MARK_CLASS}`].join(',');
  const OBSERVE = { childList: true, subtree: true, characterData: true };

  // key → { key, term, color, match, saved, listName }. Saved entries mirror the
  // keyword lists; the others were double-clicked here and last until reload.
  const active = new Map();
  const jumpCursor = new Map();
  const DEFAULTS = {
    copyOnDoubleClick: true,
    highlightColor: PRESETS[0].hex,
    trigger: 'dblclick',
    matchVariants: true,
    showMarkers: true,
  };
  const settings = { ...DEFAULTS };
  let matcher = null;
  let hidden = false;
  let paused = false;
  let picker = null;
  let reportedCount = -1;

  // ---------------------------------------------------------------------------
  // Highlighting
  // ---------------------------------------------------------------------------

  function paint(mark, color) {
    // CSSOM writes are not blocked by page CSP; !important beats page styles.
    mark.style.cssText = [
      `background-color: ${color}`,
      `color: ${inkFor(color)}`,
      `box-shadow: 0 0 0 1px ${color}`,
      'font-weight: 700',
      'display: inline',
      'padding: 0',
      'margin: 0',
      'border-radius: 2px',
      'box-decoration-break: clone',
      '-webkit-box-decoration-break: clone',
    ].map((rule) => `${rule} !important`).join(';');
  }

  function createMark(text, entry) {
    const mark = document.createElement('mark');
    mark.className = MARK_CLASS;
    mark.dataset.term = entry.key;
    mark.textContent = text;
    paint(mark, entry.color);
    return mark;
  }

  function isSkipped(el) {
    return el.namespaceURI !== HTML_NS
      || SKIP_TAGS.has(el.tagName)
      || el.classList.contains(MARK_CLASS)
      || el.isContentEditable;
  }

  function insideSkipped(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !el || el.closest(SKIP_ANCESTORS) !== null || el.isContentEditable;
  }

  // Collect first, mutate after: wrapping while walking would revisit the
  // marks just inserted. Existing marks are skipped, so marks never nest.
  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return isSkipped(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  // "default" follows the global "Match word variants" switch.
  const resolveMatch = (match) => (!match || match === 'default'
    ? (settings.matchVariants ? 'variants' : 'word')
    : match);

  // One regex for every term; each term is its own capture group.
  function buildMatcher(entries) {
    if (!entries.length) return null;
    // Longest first, so "New York" wins over "York" where both match.
    const sorted = [...entries].sort((a, b) => b.term.length - a.term.length);
    const source = sorted.map((entry) => `(${termPattern(entry.term, resolveMatch(entry.match))})`).join('|');
    return { regex: new RegExp(source, 'giu'), entries: sorted };
  }

  function wrapMatches(textNode, { regex, entries }) {
    const text = textNode.nodeValue;
    let fragment = null;
    let last = 0;
    regex.lastIndex = 0;
    for (let match; (match = regex.exec(text));) {
      // The one capture group that took part tells us which term matched.
      const entry = entries[match.indexOf(match[0], 1) - 1];
      fragment ??= document.createDocumentFragment();
      if (match.index > last) fragment.append(text.slice(last, match.index));
      // Keep the page's own casing: "The" and "the" both stay as written.
      fragment.append(createMark(match[0], entry));
      last = match.index + match[0].length;
    }
    if (!fragment) return;
    if (last < text.length) fragment.append(text.slice(last));
    textNode.replaceWith(fragment);
  }

  function highlightIn(root, m) {
    if (insideSkipped(root)) return;
    if (root.nodeType === Node.TEXT_NODE) wrapMatches(root, m);
    else if (root.nodeType === Node.ELEMENT_NODE) for (const node of collectTextNodes(root)) wrapMatches(node, m);
  }

  const allMarks = () => [...document.querySelectorAll(`mark.${MARK_CLASS}`)];
  const marksFor = (key) => allMarks().filter((mark) => mark.dataset.term === key);

  function countByKey() {
    const counts = new Map();
    for (const mark of allMarks()) counts.set(mark.dataset.term, (counts.get(mark.dataset.term) ?? 0) + 1);
    return counts;
  }

  // Put the text back exactly as it was: unwrap, then re-join the text nodes
  // that wrapping split apart.
  function unwrap(mark) {
    const parent = mark.parentNode;
    if (!parent) return;
    const before = mark.previousSibling;
    const stop = mark.nextSibling?.nextSibling ?? null;
    mark.replaceWith(...mark.childNodes);

    let node = before ?? parent.firstChild;
    while (node && node !== stop) {
      const next = node.nextSibling;
      if (node.nodeType === Node.TEXT_NODE && next?.nodeType === Node.TEXT_NODE && next !== stop) {
        node.appendData(next.data);
        next.remove();
      } else {
        node = next;
      }
    }
  }

  // Any change to the set of terms re-highlights the page in one combined
  // pass, so overlapping terms ("New York" vs "York") resolve consistently.
  function render() {
    for (const mark of allMarks()) unwrap(mark);
    matcher = hidden ? null : buildMatcher([...active.values()]);
    if (matcher) highlightIn(document.body, matcher);
    if (!hidden) {
      const counts = countByKey();
      for (const [key, entry] of active) if (!entry.saved && !counts.has(key)) active.delete(key);
    }
    jumpCursor.clear();
    settle(true);
  }

  // After our own DOM writes: drop the observer records they caused, then
  // refresh the scrollbar markers and report the count (toolbar badge, and an
  // open popup refreshes on it). `force` reports even if the count is unchanged.
  function settle(force = false) {
    observer.takeRecords();
    if (matcher) observer.observe(document.body, OBSERVE);
    else observer.disconnect();
    markers.schedule();
    const count = document.querySelectorAll(`mark.${MARK_CLASS}`).length;
    if (count === reportedCount && !force) return;
    reportedCount = count;
    try {
      chrome.runtime.sendMessage({ type: 'count', count }).catch(() => {});
    } catch {
      // Extension was reloaded; this orphaned script can no longer talk to it.
    }
  }

  // ---------------------------------------------------------------------------
  // Content the page adds later (infinite scroll, SPAs, chat, feeds)
  // ---------------------------------------------------------------------------

  const pending = new Set();
  let flushTimer = 0;

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') pending.add(record.target);
      else for (const node of record.addedNodes) pending.add(node);
    }
    flushTimer ||= setTimeout(flush, FLUSH_DELAY_MS);
  });

  function flush() {
    flushTimer = 0;
    const nodes = [...pending];
    pending.clear();
    if (matcher) for (const node of nodes) if (node.isConnected) highlightIn(node, matcher);
    settle();
  }

  // ---------------------------------------------------------------------------
  // Terms: double-clicked (this page) and saved (every page)
  // ---------------------------------------------------------------------------

  const savedSnapshot = () => JSON.stringify([...active.values()].filter((e) => e.saved)
    .sort((a, b) => a.key.localeCompare(b.key)));

  async function loadSaved() {
    const data = await store.load();
    paused = store.isPaused(data.pausedSites, location.hostname);
    const live = paused ? [] : store.activeKeywords(data, location.hostname);
    const before = savedSnapshot();
    for (const [key, entry] of active) if (entry.saved) active.delete(key);
    for (const k of live) {
      active.set(k.id, {
        key: k.id, term: k.term, color: k.color, match: k.match ?? 'default', saved: true, listName: k.listName,
      });
    }
    if (savedSnapshot() !== before) render();
  }

  function highlightTerm(rawTerm, color) {
    const term = normalizeTerm(rawTerm);
    const key = keyFor(term);
    const current = active.get(key);
    active.set(key, {
      key,
      term: current?.term ?? term,
      color,
      match: current?.match ?? 'default',
      saved: Boolean(current?.saved),
      listName: current?.listName,
    });
    render();
    if (current?.saved) store.update(key, { color });
  }

  // Saving keeps the term on every site (first all-sites list) or only this
  // one (a list for this site).
  async function saveTerm(key, scope = 'all') {
    const entry = active.get(key);
    if (!entry) return;
    const list = scope === 'site' ? await store.siteList(location.hostname) : await store.defaultList();
    Object.assign(entry, { saved: true, listName: list.name });
    await store.put(store.create(entry.term, entry.color, { match: entry.match, listId: list.id }));
  }

  // Unsaving keeps the highlight on this page until reload.
  async function unsaveTerm(key) {
    const entry = active.get(key);
    if (entry) entry.saved = false;
    await store.remove(key);
  }

  function removeTerm(key) {
    const entry = active.get(key);
    active.delete(key);
    render();
    if (entry?.saved) store.remove(key);
  }

  // Clears this page's double-click highlights; saved keywords stay.
  function clearPage() {
    for (const [key, entry] of active) if (!entry.saved) active.delete(key);
    render();
  }

  function setHidden(value) {
    hidden = value;
    render();
  }

  function state() {
    const counts = countByKey();
    const terms = [...active.values()]
      .map(({ key, term, color, match, saved, listName }) => ({
        key, term, color, match, saved, listName, count: counts.get(key) ?? 0,
      }))
      .filter((t) => t.count > 0 || hidden);
    return { terms, hidden, paused, site: siteOf(location.hostname) };
  }

  function focusMark(mark) {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    mark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    const color = active.get(mark.dataset.term)?.color ?? '#000000';
    // Outline, not box-shadow: paint() pins box-shadow with !important, and
    // !important styles outrank animations.
    mark.animate(
      [
        { outline: `0 solid ${color}66` },
        { outline: `6px solid ${color}66`, offset: 0.3 },
        { outline: `0 solid ${color}66` },
      ],
      { duration: reduceMotion ? 1 : 900, easing: 'ease-out' },
    );
  }

  function jumpTo(key) {
    const marks = marksFor(key).filter((mark) => mark.checkVisibility());
    if (!marks.length) return { index: 0, count: 0 };
    const index = ((jumpCursor.get(key) ?? -1) + 1) % marks.length;
    jumpCursor.set(key, index);
    focusMark(marks[index]);
    return { index, count: marks.length };
  }

  // ---------------------------------------------------------------------------
  // Scrollbar markers: where every match is on the page, click to jump
  // ---------------------------------------------------------------------------

  const MARKERS_CSS = `
    :host { all: initial; }
    .tick {
      position: absolute; right: 2px; width: 8px; height: 4px; border-radius: 2px;
      pointer-events: auto; cursor: pointer; opacity: 0.85;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3);
      transition: transform 100ms ease, opacity 100ms ease; transform-origin: right center;
    }
    .tick:hover { opacity: 1; transform: scale(1.5); }
  `;

  const markers = {
    host: null,
    root: null,
    timer: 0,

    schedule() {
      this.timer ||= setTimeout(() => {
        this.timer = 0;
        this.draw();
      }, 150);
    },

    draw() {
      const docHeight = document.documentElement.scrollHeight;
      const scrollable = docHeight > innerHeight;
      const rows = new Map();
      if (settings.showMarkers && scrollable) {
        for (const mark of allMarks()) {
          const rect = mark.getBoundingClientRect();
          if (!rect.width && !rect.height) continue;
          // Bucket to 4px rows so a dense page doesn't create thousands of ticks.
          const row = Math.round((((rect.top + scrollY) / docHeight) * (innerHeight - 4)) / 4) * 4;
          if (!rows.has(row)) rows.set(row, mark);
        }
      }
      if (!rows.size) {
        this.host?.remove();
        this.host = null;
        return;
      }
      if (!this.host) {
        this.host = document.createElement('word-highlighter-markers');
        this.host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; width: 12px; height: 100vh;'
          + ' z-index: 2147483646; pointer-events: none;';
        this.root = this.host.attachShadow({ mode: 'open' });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(MARKERS_CSS);
        this.root.adoptedStyleSheets = [sheet];
      }
      if (!this.host.isConnected) document.documentElement.append(this.host);
      this.root.replaceChildren(...[...rows].map(([row, mark]) => {
        const entry = active.get(mark.dataset.term);
        const tick = document.createElement('div');
        tick.className = 'tick';
        tick.style.top = `${row}px`;
        tick.style.background = entry?.color ?? '#888888';
        tick.title = entry?.term ?? '';
        tick.addEventListener('click', () => focusMark(mark));
        return tick;
      }));
    },
  };

  // ---------------------------------------------------------------------------
  // Inline color picker (shadow DOM, so page CSS can't reach it)
  // ---------------------------------------------------------------------------

  const PICKER_CSS = `
    :host { all: initial; }
    .card {
      --bg: #ffffff; --fg: #18181d; --muted: #6c6c7a; --line: rgba(20, 20, 30, 0.1);
      --hover: rgba(20, 20, 30, 0.06); --ring: #18181d;
      box-sizing: border-box; width: 236px; padding: 10px;
      font: 500 12px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--fg); background: var(--bg);
      border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 12px 32px -8px rgba(0,0,0,0.28);
      animation: pop 140ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
      transform-origin: var(--origin, top center);
    }
    @media (prefers-color-scheme: dark) {
      .card {
        --bg: #1c1c22; --fg: #f3f3f6; --muted: #9c9cab; --line: rgba(255,255,255,0.1);
        --hover: rgba(255,255,255,0.07); --ring: #f3f3f6;
      }
    }
    @keyframes pop { from { opacity: 0; transform: scale(0.94); } }
    @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
    * { box-sizing: border-box; }
    header { display: flex; align-items: center; gap: 6px; margin: 0 2px 9px; min-height: 18px; }
    .term { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    .term::before { content: "\\201C"; color: var(--muted); }
    .term::after { content: "\\201D"; color: var(--muted); }
    .copied {
      flex: none; font-size: 10.5px; color: var(--muted); padding: 2px 6px;
      border-radius: 99px; background: var(--hover); opacity: 0; transition: opacity 160ms;
    }
    .copied.show { opacity: 1; }
    .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
    button { font: inherit; color: inherit; cursor: pointer; }
    .swatch {
      width: 100%; aspect-ratio: 1; padding: 0; border-radius: 50%;
      background: var(--c); border: 1px solid rgba(0,0,0,0.12);
      transition: transform 120ms ease, box-shadow 120ms ease; outline: none;
    }
    .swatch:hover { transform: scale(1.12); }
    .swatch:focus-visible { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--ring); }
    .swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--c); }
    footer { display: flex; gap: 6px; margin-top: 9px; }
    .action {
      flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      height: 28px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line);
      background: transparent; position: relative; outline: none; white-space: nowrap;
    }
    .action:hover { background: var(--hover); }
    .action:focus-visible { box-shadow: 0 0 0 2px var(--ring); }
    .action .dot {
      width: 12px; height: 12px; border-radius: 50%;
      background: conic-gradient(#ff3357, #ffd700, #33ff57, #00ffff, #3357ff, #f333ff, #ff3357);
    }
    .action input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; }
    .remove { color: #d92d4f; }
    @media (prefers-color-scheme: dark) { .remove { color: #ff6b85; } }
    .remove[hidden] { display: none; }
    .save-row { margin-top: 6px; }
    .action .star { color: #e5a400; font-size: 13px; line-height: 1; }
    .action .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .saved { background: var(--hover); border-color: transparent; }
  `;

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function closePicker() {
    if (!picker) return;
    picker.teardown();
    picker.host.remove();
    picker = null;
  }

  function openPicker(term, anchor) {
    closePicker();
    const key = keyFor(term);
    const entry = active.get(key);
    const current = entry?.color;
    const site = siteOf(location.hostname);
    const selected = (current ?? settings.highlightColor ?? '').toUpperCase();

    const host = document.createElement('word-highlighter-picker');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(PICKER_CSS);
    root.adoptedStyleSheets = [sheet];

    // Drop the native selection so the new highlight is visible straight away.
    const choose = (color) => {
      closePicker();
      getSelection().removeAllRanges();
      highlightTerm(term, color);
      chrome.storage.local.set({ highlightColor: color });
    };

    const swatches = PRESETS.map(({ hex, name }) => el('button', {
      className: 'swatch',
      title: name,
      ariaLabel: `Highlight with ${name}`,
      ariaPressed: String(hex === selected),
      onclick: () => choose(hex),
    }));
    swatches.forEach((button, i) => button.style.setProperty('--c', PRESETS[i].hex));

    const colorInput = el('input', {
      type: 'color',
      value: /^#[0-9a-f]{6}$/i.test(selected) ? selected.toLowerCase() : '#ff007f',
      ariaLabel: 'Custom color',
      onchange: (event) => choose(event.target.value.toUpperCase()),
    });
    const copied = el('span', { className: 'copied', textContent: 'Copied' });

    // ★ Save highlights with the current (or last-used) color, then saves.
    const saveAs = (scope) => {
      closePicker();
      getSelection().removeAllRanges();
      highlightTerm(term, current ?? selected ?? PRESETS[0].hex);
      if (active.has(key)) saveTerm(key, scope);
    };
    const star = (filled) => el('span', { className: 'star', textContent: filled ? '★' : '☆', ariaHidden: 'true' });
    const saveButtons = entry?.saved
      ? [el('button', {
        className: 'action saved',
        ariaPressed: 'true',
        title: `Saved in “${entry.listName}”. Click to stop saving it.`,
        onclick: () => { closePicker(); unsaveTerm(key); },
      }, [star(true), el('span', { className: 'label', textContent: `Saved · ${entry.listName}` })])]
      : [
        el('button', {
          className: 'action', title: 'Save: highlight it on every site', onclick: () => saveAs('all'),
        }, [star(false), 'Save']),
        ...(site ? [el('button', {
          className: 'action', title: `Save: highlight it only on ${site}`, onclick: () => saveAs('site'),
        }, [star(false), 'This site'])] : []),
      ];
    const removeButton = el('button', {
      className: 'action remove',
      hidden: !current,
      textContent: 'Remove',
      title: 'Remove this highlight',
      onclick: () => { closePicker(); getSelection().removeAllRanges(); removeTerm(key); },
    });

    const card = el('div', { className: 'card', role: 'dialog', ariaLabel: `Highlight “${term}”` }, [
      el('header', {}, [el('span', { className: 'term', textContent: term, title: term }), copied]),
      el('div', { className: 'grid' }, swatches),
      el('footer', {}, [
        el('label', { className: 'action', title: 'Pick any color' }, [
          el('span', { className: 'dot' }), 'Custom', colorInput,
        ]),
        removeButton,
      ]),
      el('footer', { className: 'save-row' }, saveButtons),
    ]);
    root.append(card);
    document.documentElement.append(host);

    // Place below the word, flip above if it would run off-screen, clamp sideways.
    const margin = 8;
    const { width, height } = card.getBoundingClientRect();
    const below = anchor.bottom + margin;
    const fitsBelow = below + height <= innerHeight - margin;
    const top = fitsBelow ? below : Math.max(margin, anchor.top - margin - height);
    const centered = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.min(Math.max(margin, centered), innerWidth - width - margin);
    host.style.top = `${Math.round(top)}px`;
    host.style.left = `${Math.round(left)}px`;
    card.style.setProperty('--origin', fitsBelow ? 'top center' : 'bottom center');

    const startIndex = Math.max(0, PRESETS.findIndex(({ hex }) => hex === selected));
    swatches[startIndex].focus({ preventScroll: true });

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePicker();
        return;
      }
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 }[event.key];
      const index = swatches.indexOf(root.activeElement);
      if (step && index !== -1) {
        event.preventDefault();
        swatches[(index + step + swatches.length) % swatches.length].focus();
      }
    };
    const onPointerDown = (event) => {
      if (!event.composedPath().includes(host)) closePicker();
    };
    const onViewportChange = () => closePicker();

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    addEventListener('resize', onViewportChange);

    picker = {
      host,
      showCopied: () => copied.classList.add('show'),
      teardown() {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('pointerdown', onPointerDown, true);
        removeEventListener('scroll', onViewportChange, { capture: true });
        removeEventListener('resize', onViewportChange);
      },
    };
  }

  // Opens the picker for the current selection; returns false if there is none.
  function openForSelection(fallback) {
    const selection = getSelection();
    const term = normalizeTerm(selection.toString());
    if (!term || term.length > MAX_TERM_LENGTH || !selection.rangeCount) return false;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const anchor = rect.width || rect.height ? rect : fallback;
    openPicker(term, anchor);
    if (settings.copyOnDoubleClick) {
      navigator.clipboard.writeText(term)
        .then(() => picker?.showCopied())
        .catch(() => { /* Clipboard can be blocked by page permissions policy. */ });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  document.addEventListener('dblclick', (event) => {
    if (settings.trigger === 'off' || (settings.trigger === 'alt' && !event.altKey)) return;
    if (picker && event.composedPath().includes(picker.host)) return;
    const target = event.target;
    if (target instanceof Element && (target.closest('input, textarea, select') || target.isContentEditable)) return;
    openForSelection(new DOMRect(event.clientX, event.clientY, 0, 0));
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const reply = (value) => sendResponse(value ?? state());
    switch (message?.type) {
      case 'state': reply(); break;
      case 'jump': reply(jumpTo(message.key)); break;
      case 'remove': removeTerm(message.key); reply(); break;
      case 'clear': closePicker(); clearPage(); reply(); break;
      case 'hide': setHidden(Boolean(message.hidden)); reply(); break;
      case 'toggle-hidden': setHidden(!hidden); reply(); break;
      case 'save': saveTerm(message.key, message.scope).then(() => reply()); return true;
      case 'unsave': unsaveTerm(message.key).then(() => reply()); return true;
      case 'open-picker': {
        const opened = openForSelection(new DOMRect(innerWidth / 2, innerHeight / 3, 0, 0));
        reply({ opened });
        break;
      }
      default: return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [name, { newValue }] of Object.entries(changes)) {
      if (name in settings) settings[name] = newValue ?? DEFAULTS[name];
    }
    if ('showMarkers' in changes) markers.schedule();
    if ('matchVariants' in changes) render();
  });

  // Settings before saved keywords, so the first render already uses the
  // stored "Match word variants".
  chrome.storage.local.get(Object.keys(settings)).then((stored) => {
    Object.assign(settings, stored);
    store.onChange(loadSaved);
    loadSaved();
  });
  addEventListener('resize', () => markers.schedule());
  new ResizeObserver(() => markers.schedule()).observe(document.documentElement);
})();
