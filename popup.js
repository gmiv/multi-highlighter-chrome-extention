// Word Highlighter — popup. Talks to the content script in the active tab and
// to the saved keyword store.

const { store, normalizeTerm, keyFor } = WH;
const $ = (id) => document.getElementById(id);
const list = $('terms');
const state = $('state');
const summary = $('summary');
const note = $('note');
const clearButton = $('clear');
const hideButton = $('hide');
const sitePanel = $('site-panel');
const siteToggle = $('site-on');
const variantsToggle = $('variants');
const addForm = $('add');
const addInput = $('add-input');
const addButton = $('add-button');
const rowTemplate = $('term-row');

let tabId = null;
let page = null; // last state from the content script; null where Chrome blocks it

// `?tab=<id>` lets the popup page be driven against a specific tab in tests.
async function resolveTab() {
  const requested = Number(new URLSearchParams(location.search).get('tab'));
  if (requested) return requested;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function send(message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // No listener yet: the tab was open before the extension was installed.
    // Inject on demand (throws on pages Chrome won't script, e.g. chrome://).
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function plural(n, word, words = `${word}s`) {
  return `${n} ${n === 1 ? word : words}`;
}

function showState(title, detail = '', demo = false) {
  list.replaceChildren();
  state.replaceChildren();
  if (demo) {
    state.append(Object.assign(document.createElement('span'), { className: 'demo', textContent: 'highlight' }),
      document.createElement('br'));
  }
  state.append(Object.assign(document.createElement('strong'), { textContent: title }), detail);
  state.hidden = false;
}

function flash(message) {
  note.textContent = message;
  note.hidden = !message;
}

function render(next) {
  page = next;
  const { terms, hidden, paused, site } = next;
  const total = terms.reduce((sum, { count }) => sum + count, 0);
  summary.textContent = terms.length && !hidden ? `${plural(terms.length, 'word')} · ${plural(total, 'match', 'matches')}` : '';
  clearButton.disabled = !terms.some((t) => !t.saved);
  hideButton.disabled = false;
  hideButton.setAttribute('aria-pressed', String(hidden));
  hideButton.title = `${hidden ? 'Show' : 'Hide'} highlights on this page (Alt+Shift+J)`;
  sitePanel.hidden = !site;
  $('site').textContent = site;
  siteToggle.checked = !paused;
  $('site-status').textContent = paused ? 'Paused here' : 'Saved keywords on';

  if (hidden) {
    showState('Highlights hidden', 'Click the eye to show them again.');
    return;
  }
  if (!terms.length) {
    showState('No highlights yet', 'Double-click a word on the page, or add a keyword below.', true);
    return;
  }

  state.hidden = true;
  list.replaceChildren(...terms.map(({ key, term, color, count, saved, listName }) => {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    const jump = row.querySelector('.jump');
    const countBadge = row.querySelector('.count');
    row.querySelector('.swatch').style.background = color;
    row.querySelector('.label').textContent = term;
    row.querySelector('.list-name').textContent = saved ? listName : 'This page only';
    countBadge.textContent = count;
    jump.setAttribute('aria-label', `${term}, ${plural(count, 'match', 'matches')}. Jump to next.`);
    jump.addEventListener('click', async () => {
      const { index, count: visible } = await send({ type: 'jump', key });
      if (visible) countBadge.textContent = `${index + 1}/${visible}`;
    });

    const star = row.querySelector('.star');
    star.setAttribute('aria-pressed', String(saved));
    star.textContent = saved ? '★' : '☆';
    star.title = saved ? `Saved in “${listName}”. Click to stop saving it.` : 'Save: highlight it on every page';
    star.setAttribute('aria-label', saved ? `Unsave ${term}` : `Save ${term} to every page`);
    star.addEventListener('click', async () => render(await send({ type: saved ? 'unsave' : 'save', key, scope: 'all' })));

    const remove = row.querySelector('.remove');
    remove.title = saved ? `Delete “${term}” from your saved keywords` : `Remove “${term}”`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', async () => render(await send({ type: 'remove', key })));
    return row;
  }));
}

let refreshTimer = 0;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      render(await chrome.tabs.sendMessage(tabId, { type: 'state' }));
    } catch {
      // Tab navigated away or closed while the popup was open.
    }
  }, 30);
}

// The content script reports after every re-render (saved keywords changed,
// variants toggled, site paused): refresh to match.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'count' && sender.tab?.id === tabId) refresh();
});

addInput.addEventListener('input', () => {
  addButton.disabled = !addInput.value.trim();
  flash('');
});

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const term = normalizeTerm(addInput.value);
  if (!term) return;
  const { keywords, lists } = await store.load();
  const existing = keywords.find((k) => k.id === keyFor(term));
  if (existing) {
    flash(`“${existing.term}” is already in ${lists.find((l) => l.id === existing.listId)?.name ?? 'a list'}.`);
    return;
  }
  const target = await store.defaultList();
  await store.put(store.create(term, store.nextColor(keywords.map((k) => k.color)), { listId: target.id }));
  addInput.value = '';
  addButton.disabled = true;
  flash(`Saved “${term}” to ${target.name}. It's highlighted on every page.`);
});

clearButton.addEventListener('click', async () => render(await send({ type: 'clear' })));
hideButton.addEventListener('click', async () => render(await send({ type: 'hide', hidden: !page?.hidden })));
siteToggle.addEventListener('change', () => store.setPaused(page.site, !siteToggle.checked));
variantsToggle.addEventListener('change', () => chrome.storage.local.set({ matchVariants: variantsToggle.checked }));

for (const id of ['options', 'manage']) {
  $(id).addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

(async () => {
  const { matchVariants = true } = await chrome.storage.local.get('matchVariants');
  variantsToggle.checked = matchVariants;

  tabId = await resolveTab();
  try {
    render(await send({ type: 'state' }));
  } catch {
    showState('Not available here', 'Chrome doesn’t allow extensions on this page.');
  }
})();
