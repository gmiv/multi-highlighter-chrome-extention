// Word Highlighter — options page: keyword lists, settings, backup, shortcuts.

const { PRESETS, MATCH_MODES, store, normalizeTerm, keyFor, inkFor, parseSite } = WH;
const $ = (selector, root = document) => root.querySelector(selector);

const SETTINGS = { trigger: 'dblclick', matchVariants: true, copyOnDoubleClick: true, showMarkers: true };
const SYNC_QUOTA_BYTES = chrome.storage.sync.QUOTA_BYTES ?? 102400;
const SYNC_MAX_ITEMS = chrome.storage.sync.MAX_ITEMS ?? 512;
const HEX = /^#[0-9a-f]{6}$/i;

let data = { lists: [], keywords: [], pausedSites: [] };
let settings = { ...SETTINGS };
let filter = '';
const collapsed = new Set();

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// Every write goes through here so quota errors reach the user.
async function attempt(write, success) {
  try {
    await write();
    if (success) toast(success);
  } catch (error) {
    toast(/quota/i.test(error.message)
      ? 'Sync storage is full. Remove some keywords, or export a backup first.'
      : `Couldn’t save: ${error.message}`);
  }
}

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Storage changes (here, in the popup, or from another device) re-render the
// page; keep whatever the user is typing in and where their cursor is.
function preservingFocus(renderFn) {
  const active = document.activeElement;
  const key = active?.dataset?.focus;
  const snapshot = key && { value: active.value, start: active.selectionStart, end: active.selectionEnd };
  renderFn();
  if (!key) return;
  const next = document.querySelector(`[data-focus="${CSS.escape(key)}"]`);
  if (!next) return;
  if ('value' in next && snapshot.value !== undefined) next.value = snapshot.value;
  next.focus({ preventScroll: true });
  if (snapshot.start != null && next.setSelectionRange) next.setSelectionRange(snapshot.start, snapshot.end);
}

function render() {
  preservingFocus(() => {
    renderLists();
    renderPaused();
  });
  renderUsage();
}

function matchLabel(mode) {
  return mode === 'default' ? `Default (${settings.matchVariants ? 'variants' : 'exact'})` : null;
}

function renderLists() {
  const query = filter.toLocaleLowerCase();
  const cards = data.lists
    .map((list) => listCard(list, data.keywords.filter((k) => k.listId === list.id), query))
    .filter(Boolean);
  $('#lists-container').replaceChildren(...cards);
  $('#lists-empty').hidden = data.lists.length > 0;
  $('#filter-empty').hidden = !(query && data.lists.length && !cards.length);
}

function listCard(list, keywords, query) {
  const shown = query
    ? keywords.filter((k) => k.term.toLocaleLowerCase().includes(query) || list.name.toLocaleLowerCase().includes(query))
    : keywords;
  if (query && !shown.length) return null;

  const card = $('#list-template').content.firstElementChild.cloneNode(true);
  const enabled = list.enabled !== false;
  const isCollapsed = collapsed.has(list.id) && !query;
  card.dataset.id = list.id;
  card.classList.toggle('off', !enabled);
  card.classList.toggle('collapsed', isCollapsed);

  const collapse = $('.collapse', card);
  collapse.setAttribute('aria-expanded', String(!isCollapsed));
  collapse.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${list.name}`);
  collapse.addEventListener('click', () => {
    if (collapsed.has(list.id)) collapsed.delete(list.id);
    else collapsed.add(list.id);
    render();
  });

  const name = $('.list-name', card);
  name.value = list.name;
  name.dataset.focus = `name:${list.id}`;
  name.addEventListener('change', () => {
    const next = name.value.trim() || 'Untitled list';
    if (next !== list.name) attempt(() => store.putList({ ...list, name: next }));
  });
  name.addEventListener('keydown', (event) => { if (event.key === 'Enter') name.blur(); });

  $('.list-count', card).textContent = plural(keywords.length, 'keyword');

  const toggle = $('.list-enabled', card);
  toggle.checked = enabled;
  toggle.setAttribute('aria-label', `${list.name} on`);
  toggle.addEventListener('change', () => attempt(() => store.putList({ ...list, enabled: toggle.checked })));

  const remove = $('.list-delete', card);
  remove.title = `Delete ${list.name}`;
  remove.setAttribute('aria-label', remove.title);
  remove.addEventListener('click', () => {
    const detail = keywords.length ? ` and its ${plural(keywords.length, 'keyword')}` : '';
    if (confirm(`Delete “${list.name}”${detail}? This can’t be undone.`)) {
      attempt(() => store.removeList(list.id), `Deleted ${list.name}`);
    }
  });

  renderSites(card, list);

  const rows = $('.keywords', card);
  rows.replaceChildren(...(shown.length
    ? shown.map((keyword) => keywordRow(keyword))
    : [Object.assign(document.createElement('li'), {
      className: 'no-keywords',
      textContent: 'No keywords yet. Add some below.',
    })]));

  const form = $('.add-keywords', card);
  const input = $('.add-input', form);
  input.dataset.focus = `add:${list.id}`;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // Clear before writing: the write re-renders and would restore the draft.
    const text = input.value;
    input.value = '';
    addKeywords(list, text);
  });
  return card;
}

function renderSites(card, list) {
  const sites = list.sites ?? [];
  const chips = sites.length
    ? sites.map((site) => {
      const chip = Object.assign(document.createElement('span'), { className: 'chip', textContent: site });
      const remove = Object.assign(document.createElement('button'), {
        type: 'button',
        textContent: '×',
        title: `Stop limiting to ${site}`,
        ariaLabel: `Remove ${site}`,
      });
      remove.addEventListener('click', () => attempt(() => store.putList({ ...list, sites: sites.filter((s) => s !== site) })));
      chip.append(remove);
      return chip;
    })
    : [Object.assign(document.createElement('span'), { className: 'chip static', textContent: 'All sites' })];
  $('.sites', card).replaceChildren(...chips);

  const input = $('.site-input', card);
  input.dataset.focus = `site:${list.id}`;
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const site = parseSite(input.value);
    if (!site) {
      toast('Enter a site like example.com');
      return;
    }
    input.value = '';
    if (!sites.includes(site)) attempt(() => store.putList({ ...list, sites: [...sites, site] }), `${list.name} now only runs on its sites`);
  });
}

function keywordRow(keyword) {
  const row = $('#keyword-template').content.firstElementChild.cloneNode(true);
  row.style.setProperty('--c', keyword.color);
  row.style.setProperty('--ink', inkFor(keyword.color));

  const color = $('.kw-color', row);
  color.title = 'Change color';
  color.setAttribute('aria-label', `Color for ${keyword.term}`);
  color.addEventListener('click', () => openPalette(color, keyword.color, (hex) => {
    attempt(() => store.update(keyword.id, { color: hex }));
  }));

  const term = $('.kw-term', row);
  term.value = keyword.term;
  term.dataset.focus = `term:${keyword.id}`;
  term.setAttribute('aria-label', `Keyword ${keyword.term}`);
  term.addEventListener('keydown', (event) => { if (event.key === 'Enter') term.blur(); });
  term.addEventListener('change', () => renameKeyword(keyword, term));

  const match = $('.kw-match', row);
  match.value = MATCH_MODES.includes(keyword.match) ? keyword.match : 'default';
  match.options[0].textContent = matchLabel('default');
  match.setAttribute('aria-label', `Match mode for ${keyword.term}`);
  match.addEventListener('change', () => attempt(() => store.update(keyword.id, { match: match.value })));

  const move = $('.kw-list', row);
  move.hidden = data.lists.length < 2;
  move.setAttribute('aria-label', `List for ${keyword.term}`);
  move.replaceChildren(...data.lists.map((l) => new Option(l.name, l.id, false, l.id === keyword.listId)));
  move.addEventListener('change', () => attempt(() => store.update(keyword.id, { listId: move.value })));

  const remove = $('.kw-delete', row);
  remove.title = `Delete ${keyword.term}`;
  remove.setAttribute('aria-label', remove.title);
  remove.addEventListener('click', () => attempt(() => store.remove(keyword.id), `Deleted “${keyword.term}”`));
  return row;
}

function renderPaused() {
  const chips = data.pausedSites.map((site) => {
    const chip = Object.assign(document.createElement('span'), { className: 'chip', textContent: site });
    const resume = Object.assign(document.createElement('button'), {
      type: 'button', textContent: '×', title: `Resume on ${site}`, ariaLabel: `Resume on ${site}`,
    });
    resume.addEventListener('click', () => attempt(() => store.setPaused(site, false), `Resumed on ${site}`));
    chip.append(resume);
    return chip;
  });
  $('#paused').replaceChildren(...(chips.length
    ? chips
    : [Object.assign(document.createElement('span'), { className: 'chip static', textContent: 'None' })]));
}

async function renderUsage() {
  const bytes = await chrome.storage.sync.getBytesInUse(null);
  const items = data.lists.length + data.keywords.length + 1;
  const share = Math.max(bytes / SYNC_QUOTA_BYTES, items / SYNC_MAX_ITEMS);
  $('#usage-bar').style.width = `${Math.min(100, Math.max(1, share * 100)).toFixed(1)}%`;
  $('#usage-text').textContent = `${plural(data.keywords.length, 'keyword')} in ${plural(data.lists.length, 'list')} · `
    + `${(bytes / 1024).toFixed(1)} KB of ${Math.round(SYNC_QUOTA_BYTES / 1024)} KB sync storage`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function addKeywords(list, text) {
  // First spelling wins: "juice, Juice" saves "juice".
  const unique = new Map();
  for (const term of text.split(/[,\n]/).map(normalizeTerm)) {
    if (term && term.length <= 100 && !unique.has(keyFor(term))) unique.set(keyFor(term), term);
  }
  const terms = [...unique.values()];
  if (!terms.length) return;

  const existing = new Map(data.keywords.map((k) => [k.id, k]));
  const used = data.keywords.filter((k) => k.listId === list.id).map((k) => k.color);
  const writes = [];
  let added = 0;
  let moved = 0;
  terms.forEach((term, i) => {
    const previous = existing.get(keyFor(term));
    if (previous) {
      if (previous.listId !== list.id) {
        writes.push({ ...previous, listId: list.id });
        moved += 1;
      }
      return;
    }
    const color = store.nextColor(used);
    used.push(color);
    writes.push(store.create(term, color, { listId: list.id, created: Date.now() + i }));
    added += 1;
  });

  const parts = [added && `Added ${plural(added, 'keyword')}`, moved && `moved ${moved} from other lists`].filter(Boolean);
  if (writes.length) await attempt(() => store.put(...writes), `${parts.join(', ')} to ${list.name}`);
  else toast(`Already in ${list.name}`);
}

async function renameKeyword(keyword, input) {
  const term = normalizeTerm(input.value);
  if (!term) {
    input.value = keyword.term;
    return;
  }
  if (term === keyword.term) return;
  const id = keyFor(term);
  if (id !== keyword.id && data.keywords.some((k) => k.id === id)) {
    toast(`“${term}” is already saved`);
    input.value = keyword.term;
    return;
  }
  // The id is the lower-cased term, so a rename that changes more than case
  // is a new keyword replacing the old one.
  await attempt(async () => {
    if (id !== keyword.id) await store.remove(keyword.id);
    await store.put({ ...keyword, id, term });
  });
}

async function newList() {
  const list = store.createList('Untitled list');
  await attempt(() => store.putList(list));
  await reload();
  const name = document.querySelector(`[data-focus="name:${CSS.escape(list.id)}"]`);
  name?.select();
  name?.scrollIntoView({ block: 'center' });
}

// ---------------------------------------------------------------------------
// Palette popover
// ---------------------------------------------------------------------------

function openPalette(anchor, current, onPick) {
  const palette = $('#palette');
  const pick = (hex) => {
    closePalette();
    onPick(hex.toUpperCase());
  };
  const swatches = PRESETS.map(({ hex, name }) => {
    const button = Object.assign(document.createElement('button'), {
      type: 'button', title: name, ariaLabel: name, ariaPressed: String(hex === current.toUpperCase()),
    });
    button.style.setProperty('--c', hex);
    button.addEventListener('click', () => pick(hex));
    return button;
  });
  const custom = Object.assign(document.createElement('label'), { className: 'custom', textContent: 'Custom' });
  const input = Object.assign(document.createElement('input'), {
    type: 'color', value: HEX.test(current) ? current.toLowerCase() : '#ff007f', ariaLabel: 'Custom color',
  });
  input.addEventListener('change', () => pick(input.value));
  custom.append(input);
  palette.replaceChildren(...swatches, custom);
  palette.hidden = false;

  const rect = anchor.getBoundingClientRect();
  const { width, height } = palette.getBoundingClientRect();
  const top = rect.bottom + 8 + height > innerHeight ? rect.top - 8 - height : rect.bottom + 8;
  palette.style.top = `${Math.max(8, top)}px`;
  palette.style.left = `${Math.min(Math.max(8, rect.left - 10), innerWidth - width - 8)}px`;
  (swatches.find((b) => b.ariaPressed === 'true') ?? swatches[0]).focus();
}

function closePalette() {
  $('#palette').hidden = true;
}

document.addEventListener('pointerdown', (event) => {
  if (!$('#palette').hidden && !event.target.closest('#palette, .kw-color')) closePalette();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePalette();
});
addEventListener('scroll', closePalette, { passive: true });

// ---------------------------------------------------------------------------
// Settings, backup, shortcuts
// ---------------------------------------------------------------------------

function renderSettings() {
  for (const radio of document.querySelectorAll('input[name="trigger"]')) radio.checked = radio.value === settings.trigger;
  for (const toggle of document.querySelectorAll('[data-setting]')) toggle.checked = Boolean(settings[toggle.dataset.setting]);
}

for (const radio of document.querySelectorAll('input[name="trigger"]')) {
  radio.addEventListener('change', () => chrome.storage.local.set({ trigger: radio.value }));
}
for (const toggle of document.querySelectorAll('[data-setting]')) {
  toggle.addEventListener('change', () => chrome.storage.local.set({ [toggle.dataset.setting]: toggle.checked }));
}

$('#export').addEventListener('click', () => {
  const backup = {
    app: 'word-highlighter',
    version: 1,
    exported: new Date().toISOString(),
    lists: data.lists,
    keywords: data.keywords,
    pausedSites: data.pausedSites,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), {
    href: url,
    download: `word-highlighter-${new Date().toISOString().slice(0, 10)}.json`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${plural(data.keywords.length, 'keyword')}`);
});

$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  let backup;
  try {
    backup = JSON.parse(await file.text());
    if (backup?.app !== 'word-highlighter' || !Array.isArray(backup.keywords)) throw new Error('not a backup');
  } catch {
    toast('That file isn’t a Word Highlighter backup.');
    return;
  }

  // Only trust the shape we expect; anything malformed is dropped or repaired.
  const lists = (Array.isArray(backup.lists) ? backup.lists : [])
    .filter((l) => typeof l?.id === 'string' && typeof l.name === 'string')
    .map((l, i) => ({
      id: l.id,
      name: l.name.slice(0, 60) || 'Untitled list',
      enabled: l.enabled !== false,
      sites: (Array.isArray(l.sites) ? l.sites : []).map((s) => parseSite(String(s))).filter(Boolean),
      created: Number(l.created) || Date.now() + i,
    }));
  const keywords = backup.keywords
    .filter((k) => typeof k?.term === 'string' && normalizeTerm(k.term))
    .map((k, i) => {
      const term = normalizeTerm(k.term).slice(0, 100);
      return {
        id: keyFor(term),
        term,
        color: HEX.test(k.color) ? k.color.toUpperCase() : PRESETS[i % PRESETS.length].hex,
        match: MATCH_MODES.includes(k.match) ? k.match : 'default',
        listId: typeof k.listId === 'string' ? k.listId : null,
        created: Number(k.created) || Date.now() + i,
      };
    });
  const pausedSites = (Array.isArray(backup.pausedSites) ? backup.pausedSites : [])
    .map((s) => parseSite(String(s))).filter(Boolean);

  const needsFallback = keywords.some((k) => ![...data.lists, ...lists].some((l) => l.id === k.listId));
  const fallback = needsFallback ? (await store.defaultList()).id : null;
  await attempt(
    () => store.importAll({ lists, keywords, pausedSites }, data, fallback),
    `Imported ${plural(keywords.length, 'keyword')} in ${plural(lists.length, 'list')}`,
  );
});

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  $('#shortcut-list').replaceChildren(...commands.map(({ name, description, shortcut }) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = name === '_execute_action' ? 'Open the popup' : description;
    const keys = shortcut
      ? Object.assign(document.createElement('kbd'), { textContent: shortcut })
      : Object.assign(document.createElement('span'), { className: 'unset', textContent: 'Not set' });
    item.append(label, keys);
    return item;
  }));
}

$('#edit-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
$('#new-list').addEventListener('click', newList);
$('#first-list').addEventListener('click', newList);
$('#filter').addEventListener('input', (event) => {
  filter = event.target.value.trim();
  render();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function reload() {
  data = await store.load();
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [name, { newValue }] of Object.entries(changes)) {
    if (name in SETTINGS) settings[name] = newValue ?? SETTINGS[name];
  }
  renderSettings();
  if ('matchVariants' in changes) render();
});
store.onChange(reload);

(async () => {
  settings = { ...SETTINGS, ...(await chrome.storage.local.get(Object.keys(SETTINGS))) };
  renderSettings();
  renderShortcuts();
  await reload();
})();
