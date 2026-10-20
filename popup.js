// Word Highlighter — popup. Talks to the content script in the active tab.

const $ = (id) => document.getElementById(id);
const list = $('terms');
const state = $('state');
const summary = $('summary');
const clearButton = $('clear');
const copyToggle = $('copy');
const rowTemplate = $('term-row');

let tabId = null;

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
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function plural(n, word, words = `${word}s`) {
  return `${n} ${n === 1 ? word : words}`;
}

function showState(title, detail = '') {
  list.replaceChildren();
  state.replaceChildren();
  if (title) state.append(Object.assign(document.createElement('strong'), { textContent: title }));
  if (detail) state.append(detail);
  state.hidden = false;
}

function render(terms) {
  const total = terms.reduce((sum, { count }) => sum + count, 0);
  clearButton.disabled = terms.length === 0;
  summary.textContent = terms.length ? `${plural(terms.length, 'word')} · ${plural(total, 'match', 'matches')}` : '';

  if (!terms.length) {
    showState('');
    const demo = Object.assign(document.createElement('span'), { className: 'demo', textContent: 'highlight' });
    state.append(demo, document.createElement('br'),
      Object.assign(document.createElement('strong'), { textContent: 'No highlights yet' }),
      'Double-click a word on the page and pick a color.');
    return;
  }

  state.hidden = true;
  list.replaceChildren(...terms.map(({ key, term, color, count }) => {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    const jump = row.querySelector('.jump');
    const countBadge = row.querySelector('.count');
    row.querySelector('.swatch').style.background = color;
    row.querySelector('.label').textContent = term;
    countBadge.textContent = count;
    jump.setAttribute('aria-label', `${term}, ${plural(count, 'match', 'matches')}. Jump to next.`);
    jump.addEventListener('click', async () => {
      const { index, count: visible } = await send({ type: 'jump', key });
      if (visible) countBadge.textContent = `${index + 1}/${visible}`;
    });

    const remove = row.querySelector('.remove');
    remove.title = `Remove “${term}”`;
    remove.setAttribute('aria-label', `Remove highlight for ${term}`);
    remove.addEventListener('click', async () => render((await send({ type: 'remove', key })).terms));
    return row;
  }));
}

clearButton.addEventListener('click', async () => {
  render((await send({ type: 'clear' })).terms);
});

copyToggle.addEventListener('change', () => {
  chrome.storage.local.set({ copyOnDoubleClick: copyToggle.checked });
});

(async () => {
  const { copyOnDoubleClick = true } = await chrome.storage.local.get('copyOnDoubleClick');
  copyToggle.checked = copyOnDoubleClick;

  tabId = await resolveTab();
  try {
    render((await send({ type: 'list' })).terms);
  } catch {
    clearButton.disabled = true;
    showState('Not available here', 'Chrome doesn’t allow extensions on this page.');
  }
})();
