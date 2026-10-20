// Word Highlighter — content script.
// Double-click a word to pick a color; every occurrence on the page is
// highlighted. The popup lists, jumps to, and clears highlights via messages.
(() => {
  // The popup re-injects this file into tabs that predate the install.
  if (window.__wordHighlighterLoaded) return;
  window.__wordHighlighterLoaded = true;

  const PRESETS = [
    { hex: '#FF5733', name: 'Ember' },
    { hex: '#FFD700', name: 'Gold' },
    { hex: '#FFFF00', name: 'Electric Yellow' },
    { hex: '#00FF00', name: 'Bright Green' },
    { hex: '#33FF57', name: 'Neon Lime' },
    { hex: '#00FF99', name: 'Neon Mint' },
    { hex: '#00FFFF', name: 'Aqua' },
    { hex: '#3357FF', name: 'Bright Blue' },
    { hex: '#F333FF', name: 'Bright Magenta' },
    { hex: '#FF00FF', name: 'Neon Purple' },
    { hex: '#FF007F', name: 'Neon Pink' },
    { hex: '#FF3357', name: 'Neon Red' },
  ];

  const MARK_CLASS = 'word-highlighter-mark';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const MAX_TERM_LENGTH = 100;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'CANVAS',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  ]);
  const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
  const NOT_BEFORE = '(?<![\\p{L}\\p{N}\\p{M}_])';
  const NOT_AFTER = '(?![\\p{L}\\p{N}\\p{M}_])';

  // key (lower-cased term) → { term, color }, in the order terms were added.
  const terms = new Map();
  const jumpCursor = new Map();
  const settings = { copyOnDoubleClick: true, highlightColor: PRESETS[0].hex };
  let picker = null;

  chrome.storage.local.get(['copyOnDoubleClick', 'highlightColor'], (stored) => {
    Object.assign(settings, stored);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [name, { newValue }] of Object.entries(changes)) {
      if (name in settings) settings[name] = newValue;
    }
  });

  // ---------------------------------------------------------------------------
  // Highlighting
  // ---------------------------------------------------------------------------

  const keyFor = (term) => term.toLocaleLowerCase();
  const normalizeTerm = (text) => text.replace(/\s+/g, ' ').trim();

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Whole-word, case-insensitive, Unicode-aware. A boundary is only asserted
  // on an edge that is itself a word character, so "C++" and "$5" still match.
  function termRegex(term) {
    const chars = Array.from(term);
    const body = term.split(' ').map(escapeRegExp).join('\\s+');
    const head = WORD_CHAR.test(chars[0]) ? NOT_BEFORE : '';
    const tail = WORD_CHAR.test(chars[chars.length - 1]) ? NOT_AFTER : '';
    return new RegExp(head + body + tail, 'giu');
  }

  // Black or white text, whichever contrasts more with the highlight (WCAG).
  function inkFor(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.179 ? '#111111' : '#FFFFFF';
  }

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

  function createMark(text, key, color) {
    const mark = document.createElement('mark');
    mark.className = MARK_CLASS;
    mark.dataset.term = key;
    mark.textContent = text;
    paint(mark, color);
    return mark;
  }

  function isSkipped(el) {
    return el.namespaceURI !== HTML_NS
      || SKIP_TAGS.has(el.tagName)
      || el.classList.contains(MARK_CLASS)
      || el.isContentEditable;
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

  function wrapMatches(textNode, regex, key, color) {
    const text = textNode.nodeValue;
    let fragment = null;
    let last = 0;
    regex.lastIndex = 0;
    for (let match; (match = regex.exec(text));) {
      fragment ??= document.createDocumentFragment();
      if (match.index > last) fragment.append(text.slice(last, match.index));
      // Keep the page's own casing: "The" and "the" both stay as written.
      fragment.append(createMark(match[0], key, color));
      last = match.index + match[0].length;
    }
    if (!fragment) return;
    if (last < text.length) fragment.append(text.slice(last));
    textNode.replaceWith(fragment);
  }

  function marksFor(key) {
    return [...document.querySelectorAll(`mark.${MARK_CLASS}`)]
      .filter((mark) => mark.dataset.term === key);
  }

  function highlightTerm(rawTerm, color) {
    const term = normalizeTerm(rawTerm);
    if (!term) return 0;
    const key = keyFor(term);
    for (const mark of marksFor(key)) paint(mark, color);
    const regex = termRegex(term);
    for (const node of collectTextNodes(document.body)) wrapMatches(node, regex, key, color);

    const count = marksFor(key).length;
    if (count) terms.set(key, { term: terms.get(key)?.term ?? term, color });
    return count;
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

  function removeTerm(key) {
    for (const mark of marksFor(key)) unwrap(mark);
    terms.delete(key);
    jumpCursor.delete(key);
  }

  function clearAll() {
    for (const mark of document.querySelectorAll(`mark.${MARK_CLASS}`)) unwrap(mark);
    terms.clear();
    jumpCursor.clear();
  }

  function listTerms() {
    const counts = new Map();
    for (const mark of document.querySelectorAll(`mark.${MARK_CLASS}`)) {
      counts.set(mark.dataset.term, (counts.get(mark.dataset.term) ?? 0) + 1);
    }
    // Drop terms whose marks the page itself has since removed.
    for (const key of terms.keys()) if (!counts.has(key)) terms.delete(key);
    return [...terms].map(([key, { term, color }]) => ({ key, term, color, count: counts.get(key) }));
  }

  function jumpTo(key) {
    const marks = marksFor(key).filter((mark) => mark.checkVisibility());
    if (!marks.length) return { index: 0, count: 0 };
    const index = ((jumpCursor.get(key) ?? -1) + 1) % marks.length;
    jumpCursor.set(key, index);

    const mark = marks[index];
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    mark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    const color = terms.get(key)?.color ?? 'currentColor';
    mark.animate(
      [
        { boxShadow: `0 0 0 1px ${color}` },
        { boxShadow: `0 0 0 6px ${color}66`, offset: 0.3 },
        { boxShadow: `0 0 0 1px ${color}` },
      ],
      { duration: reduceMotion ? 1 : 900, easing: 'ease-out' },
    );
    return { index, count: marks.length };
  }

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
    const current = terms.get(key)?.color;
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

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  document.addEventListener('dblclick', (event) => {
    if (picker && event.composedPath().includes(picker.host)) return;
    const target = event.target;
    if (target instanceof Element && (target.closest('input, textarea, select') || target.isContentEditable)) return;

    const selection = getSelection();
    const term = normalizeTerm(selection.toString());
    if (!term || term.length > MAX_TERM_LENGTH || !selection.rangeCount) return;

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const anchor = rect.width || rect.height
      ? rect
      : new DOMRect(event.clientX, event.clientY, 0, 0);
    openPicker(term, anchor);

    if (settings.copyOnDoubleClick) {
      navigator.clipboard.writeText(term)
        .then(() => picker?.showCopied())
        .catch(() => { /* Clipboard can be blocked by page permissions policy. */ });
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'list':
        sendResponse({ terms: listTerms() });
        break;
      case 'remove':
        removeTerm(message.key);
        sendResponse({ terms: listTerms() });
        break;
      case 'clear':
        closePicker();
        clearAll();
        sendResponse({ terms: listTerms() });
        break;
      case 'jump':
        sendResponse(jumpTo(message.key));
        break;
      default:
        return false;
    }
    return false;
  });
})();
