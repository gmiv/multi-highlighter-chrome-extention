// End-to-end tests: the real unpacked extension in real Chromium, driven by
// real double-clicks on served pages and the real popup page.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, '..');
const fixture = await readFile(path.join(here, 'fixtures', 'page.html'), 'utf8');
const STRICT_CSP = "default-src 'none'; style-src 'none'; script-src 'none'; require-trusted-types-for 'script'";
const SVG_IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="30"><text x="0" y="20">apple</text></svg>';

// Unpacked extensions without a "key" get an ID derived from their path.
const extensionId = createHash('sha256').update(extensionPath).digest('hex').slice(0, 32)
  .replace(/./g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]);

let server;
let origin;
let context;
let userDataDir;
let page;

before(async () => {
  server = createServer((req, res) => {
    if (req.url.startsWith('/image.svg')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(SVG_IMAGE);
      return;
    }
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (req.url.startsWith('/csp')) headers['content-security-policy'] = STRICT_CSP;
    res.writeHead(200, headers).end(fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  userDataDir = await mkdtemp(path.join(tmpdir(), 'word-highlighter-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
});

after(async () => {
  await context?.close();
  server?.close();
  await rm(userDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const p of context.pages()) await p.close();
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  await ext.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.sync.clear()]));
  await ext.close();
  page = await context.newPage();
  await page.goto(`${origin}/page`);
  await page.waitForFunction(() => document.readyState === 'complete');
});

// --- helpers -----------------------------------------------------------------

/** Viewport point at the middle of the nth occurrence of `word` inside `selector`. */
async function wordPoint(target, selector, word, nth = 0) {
  return target.evaluate(([sel, w, n]) => {
    const root = document.querySelector(sel);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      let from = 0;
      for (let i; (i = node.data.indexOf(w, from)) !== -1; from = i + 1) {
        if (seen++ !== n) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + w.length);
        range.startContainer.parentElement.scrollIntoView({ block: 'center' });
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    throw new Error(`"${w}" #${n} not found in ${sel}`);
  }, [selector, word, nth]);
}

async function doubleClickWord(target, selector, word, nth = 0) {
  const { x, y } = await wordPoint(target, selector, word, nth);
  await target.mouse.dblclick(x, y);
  await target.locator('word-highlighter-picker .card').waitFor();
}

const picker = (target = page) => target.locator('word-highlighter-picker');
const swatch = (name, target = page) => picker(target).locator(`button.swatch[title="${name}"]`);

const marks = (target = page) => target.evaluate(() => [...document.querySelectorAll('mark.word-highlighter-mark')]
  .map((m) => ({
    text: m.textContent,
    term: m.dataset.term,
    bg: getComputedStyle(m).backgroundColor,
    color: getComputedStyle(m).color,
    weight: getComputedStyle(m).fontWeight,
    padding: getComputedStyle(m).paddingLeft,
    parent: m.parentElement.id || m.parentElement.tagName,
    nested: !!m.parentElement.closest('mark.word-highlighter-mark'),
  })));

const snapshot = (target = page) => target.evaluate(() => ({
  html: document.body.innerHTML,
  textNodes: [...document.querySelectorAll('p')].map((p) => p.childNodes.length),
}));

/** The tab ID of the one page that is not `extPage` (tab URLs need the `tabs` permission). */
const otherTabId = (extPage) => extPage.evaluate(async () => {
  const self = await chrome.tabs.getCurrent();
  return (await chrome.tabs.query({})).find((t) => t.id !== self.id).id;
});

/** Runs `fn` inside a real extension page (storage, tabs, action APIs). */
async function inExtension(fn, arg) {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/options.html`);
  try {
    return await ext.evaluate(fn, arg);
  } finally {
    await ext.close();
  }
}

const pageTabId = () => inExtension(async () => {
  const self = await chrome.tabs.getCurrent();
  return (await chrome.tabs.query({})).find((t) => t.id !== self.id).id;
});

/** Writes lists and keywords exactly as the extension stores them. */
const seed = ({ lists = [], keywords = [], pausedSites } = {}) => inExtension(([ls, ks, ps]) => chrome.storage.sync.set({
  ...Object.fromEntries(ls.map((l) => [`list:${l.id}`, l])),
  ...Object.fromEntries(ks.map((k) => [`kw:${k.id}`, k])),
  ...(ps ? { pausedSites: ps } : {}),
}), [
  lists.map((l, i) => ({ enabled: true, sites: [], created: i, ...l })),
  keywords.map((k, i) => ({ id: k.term.toLowerCase(), color: '#00FFFF', match: 'word', listId: 'L', created: i, ...k })),
  pausedSites,
]);
const seedKeywords = (...keywords) => seed({ lists: [{ id: 'L', name: 'Test list' }], keywords });
const loadStore = () => inExtension(() => WH.store.load());

async function openOptions() {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#lists-empty:not([hidden]), .list').first().waitFor();
  return options;
}

const setStorage = (area, values) => inExtension(([a, v]) => chrome.storage[a].set(v), [area, values]);
const sendToPage = async (message) => {
  const tabId = await pageTabId();
  return inExtension(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, message]);
};
const waitForMarks = (n, target = page) => target.waitForFunction(
  (count) => document.querySelectorAll('mark.word-highlighter-mark').length === count, n, { timeout: 3000 },
);

/** Opens the real popup page bound to the test page's tab. */
async function openPopup() {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const id = await otherTabId(popup);
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${id}`);
  await popup.locator('#state:not(:has-text("Loading"))').or(popup.locator('#terms li').first()).waitFor();
  return popup;
}

// --- highlighting --------------------------------------------------------------

test('double-click + swatch highlights every whole-word match, keeps casing, bolds', async () => {
  await doubleClickWord(page, '#fruit', 'apple');
  await swatch('Aqua').click();
  await picker().waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => getSelection().toString()), '', 'selection hides the new color');

  const found = await marks();
  const texts = found.map((m) => m.text);
  // fruit: Apple, apple, APPLE, apples (variant) · mixed: apple ×3 · far: apple. Never pineapple.
  assert.deepEqual(texts, ['Apple', 'apple', 'APPLE', 'apples', 'apple', 'apple', 'apple', 'apple']);
  assert.ok(found.every((m) => m.term === 'apple' && !m.nested));
  assert.ok(found.every((m) => m.bg === 'rgb(0, 255, 255)' && m.weight === '700'));
  assert.ok(found.every((m) => m.padding === '0px'), 'page `mark { padding }` must not leak in');
  assert.equal(await page.locator('#ta').inputValue(), 'apple inside a textarea');
  assert.ok(!found.some((m) => ['ce', 'svgtext', 'ta'].includes(m.parent)));
});

test('unicode words match on real word boundaries', async () => {
  await doubleClickWord(page, '#cafe', 'café');
  await swatch('Gold').click();
  assert.deepEqual((await marks()).map((m) => m.text), ['Café', 'café', 'cafés']);
});

test('dark highlight colors get white text for contrast', async () => {
  await doubleClickWord(page, '#cafe', 'corner');
  await swatch('Bright Blue').click();
  const [mark] = await marks();
  assert.equal(mark.color, 'rgb(255, 255, 255)');
});

test('re-highlighting recolors in place without nesting', async () => {
  await doubleClickWord(page, '#fruit', 'apple');
  await swatch('Aqua').click();
  await doubleClickWord(page, '#fruit', 'apple');
  assert.equal(await swatch('Aqua').getAttribute('aria-pressed'), 'true');
  await swatch('Neon Pink').click();

  const found = await marks();
  assert.equal(found.length, 8);
  assert.ok(found.every((m) => m.bg === 'rgb(255, 0, 127)' && !m.nested));
});

test('Remove in the picker restores the original DOM exactly', async () => {
  const original = await snapshot();
  await doubleClickWord(page, '#fruit', 'apple');
  await swatch('Aqua').click();
  await doubleClickWord(page, '#fruit', 'apple');
  await picker().getByRole('button', { name: 'Remove' }).click();

  assert.equal((await marks()).length, 0);
  assert.deepEqual(await snapshot(), original);
});

test('picker dismisses on Escape and on outside click, and stays on-screen', async () => {
  await doubleClickWord(page, '#fruit', 'apple');
  await page.keyboard.press('Escape');
  await picker().waitFor({ state: 'detached' });

  await doubleClickWord(page, '#edge', 'zebra');
  const box = await picker().locator('.card').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 1000, `picker off-screen: ${JSON.stringify(box)}`);
  assert.equal((await swatch('Aqua').boundingBox()).width < 40, true, 'page button CSS leaked into picker');

  await page.mouse.click(10, 10);
  await picker().waitFor({ state: 'detached' });
  assert.equal((await marks()).length, 0);
});

test('arrow keys move between swatches and Enter applies', async () => {
  await doubleClickWord(page, '#fruit', 'juice');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const [mark] = await marks();
  assert.equal(mark.text, 'juice');
  assert.equal(mark.bg, 'rgb(255, 215, 0)'); // Ember → Gold
});

test('works on a page with a strict CSP and Trusted Types', async () => {
  await page.goto(`${origin}/csp`);
  await doubleClickWord(page, '#fruit', 'apple');
  const radius = await swatch('Aqua').evaluate((b) => getComputedStyle(b).borderRadius);
  assert.equal(radius, '50%', 'picker styles were blocked');
  await swatch('Aqua').click();
  assert.equal((await marks()).length, 8);
});

test('double-click copies the word, and the settings switch turns that off', async () => {
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  await doubleClickWord(page, '#fruit', 'juice');
  await picker().locator('.copied.show').waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'juice');
  await page.keyboard.press('Escape');

  const options = await openOptions();
  const copy = options.locator('[data-setting="copyOnDoubleClick"]');
  assert.equal(await copy.isChecked(), true);
  await options.locator('label.setting', { has: copy }).click();
  assert.equal(await copy.isChecked(), false);
  await options.close();

  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  await doubleClickWord(page, '#fruit', 'pie');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'sentinel');
});

// --- popup -----------------------------------------------------------------------

test('popup lists highlights, jumps between matches, removes one, clears all', async () => {
  const original = await snapshot();
  await doubleClickWord(page, '#fruit', 'apple');
  await swatch('Aqua').click();
  await doubleClickWord(page, '#cafe', 'café');
  await swatch('Gold').click();

  const popup = await openPopup();
  const rows = popup.locator('#terms li');
  await assert.doesNotReject(rows.nth(1).waitFor());
  assert.deepEqual(await rows.locator('.label').allTextContents(), ['apple', 'café']);
  assert.deepEqual(await rows.locator('.count').allTextContents(), ['8', '3']);
  assert.equal(await popup.locator('#summary').textContent(), '2 words · 11 matches');

  // Jump cycles through visible matches and scrolls the far one into view.
  const jump = rows.first().locator('.jump');
  for (let i = 0; i < 8; i++) await jump.click();
  assert.equal(await rows.first().locator('.count').textContent(), '8/8');
  await page.waitForFunction(() => scrollY > 1000, null, { timeout: 3000 });

  await rows.nth(1).hover();
  await rows.nth(1).locator('.remove').click();
  await assert.doesNotReject(popup.locator('#terms li').first().waitFor());
  assert.equal(await rows.count(), 1);
  assert.deepEqual([...new Set((await marks()).map((m) => m.term))], ['apple']);

  await popup.locator('#clear').click();
  await popup.locator('#state:has-text("No highlights yet")').waitFor();
  assert.equal(await popup.locator('#clear').isDisabled(), true);
  assert.equal((await marks()).length, 0);
  assert.deepEqual(await snapshot(), original, 'clear must restore the page DOM exactly');
});

test('popup shows an empty state on a fresh page', async () => {
  const popup = await openPopup();
  await popup.locator('#state:has-text("No highlights yet")').waitFor();
  assert.equal(await popup.locator('#clear').isDisabled(), true);
});

test('popup explains when Chrome blocks extensions on the page', async () => {
  await page.goto('chrome://version');
  const popup = await openPopup();
  await popup.locator('#state:has-text("Not available here")').waitFor();
});

test('a second injection (the popup stale-tab fallback) stays a single instance', async () => {
  // executeScript needs the activeTab grant from a real toolbar click, which
  // automation can't make — so evaluate the same file in the extension's world.
  const cdp = await context.newCDPSession(page);
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', ({ context: c }) => worlds.push(c));
  await cdp.send('Runtime.enable');
  const world = worlds.find((c) => c.origin === `chrome-extension://${extensionId}`);
  assert.ok(world, 'extension isolated world not found');
  const source = await readFile(path.join(extensionPath, 'content.js'), 'utf8');
  const { exceptionDetails } = await cdp.send('Runtime.evaluate', { expression: source, contextId: world.id });
  assert.equal(exceptionDetails, undefined);

  await doubleClickWord(page, '#fruit', 'juice');
  assert.equal(await picker().count(), 1, 'double injection created two pickers');
});

// --- saved keywords & engine ---------------------------------------------------

test('saved keywords highlight automatically on every page load, with a badge count', async () => {
  await seedKeywords({ term: 'pie', color: '#00FF99' }, { term: 'juice', color: '#FF3357' });
  await page.reload();
  await waitForMarks(2);
  const found = await marks();
  assert.deepEqual(found.map((m) => m.text), ['pie', 'juice']);
  assert.equal(found[0].bg, 'rgb(0, 255, 153)');
  const tabId = await pageTabId();
  assert.equal(await inExtension((id) => chrome.action.getBadgeText({ tabId: id }), tabId), '2');
});

test('the first highlight on page load already follows a stored "Match word variants" off', async () => {
  await seedKeywords({ term: 'apple', match: 'default' });
  await setStorage('local', { matchVariants: false });
  for (let i = 0; i < 5; i++) {
    await page.reload();
    await waitForMarks(7); // word mode; variants would also mark "apples"
    assert.ok(!(await marks()).some((m) => m.text === 'apples'));
  }
});

test('a document without a body (an SVG image) is left alone, without errors', async () => {
  await seedKeywords({ term: 'apple' });
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/image.svg`);
  const popup = await openPopup();
  assert.deepEqual(errors, []);
  assert.match(await popup.locator('#state').textContent(), /Not available here/);
});

test('saved keywords follow storage changes live, without a reload', async () => {
  const original = await snapshot();
  await seedKeywords({ term: 'apple' });
  await waitForMarks(7); // word mode: Apple, apple, APPLE · mixed ×3 · far
  await setStorage('sync', { 'kw:apple': { id: 'apple', term: 'apple', color: '#FF007F', match: 'variants', listId: 'L', created: 0 } });
  await waitForMarks(8);
  assert.ok((await marks()).every((m) => m.bg === 'rgb(255, 0, 127)'));
  await inExtension(() => chrome.storage.sync.remove('kw:apple'));
  await waitForMarks(0);
  assert.deepEqual(await snapshot(), original);
});

test('content the page adds later gets highlighted', async () => {
  await seedKeywords({ term: 'kiwi' });
  await page.reload();
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'late';
    p.textContent = 'A kiwi arrived late, then another kiwi.';
    document.body.prepend(p);
  });
  await waitForMarks(2);
  // Replaced content (childList) and edited text (characterData) both count.
  await page.evaluate(() => { document.querySelector('#late').textContent = 'kiwi kiwi kiwi'; });
  await waitForMarks(3);
  await page.evaluate(() => { document.querySelector('#cafe').lastChild.data += ' A kiwi too.'; });
  await waitForMarks(4);

  // Double-click highlights keep up too.
  await doubleClickWord(page, '#fruit', 'juice');
  await swatch('Gold').click();
  await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<p>fresh juice</p>'));
  await waitForMarks(6);
});

test('overlapping keywords: the longest one wins', async () => {
  await seedKeywords({ term: 'pie' }, { term: 'apple pie', color: '#FFD700' });
  await page.reload();
  await waitForMarks(1);
  assert.deepEqual((await marks()).map((m) => [m.text, m.term]), [['Apple pie', 'apple pie']]);
});

test('match modes: word, variants, anywhere', async () => {
  const texts = async () => (await marks()).filter((m) => m.parent === 'fruit').map((m) => m.text);
  await seedKeywords({ term: 'apple', match: 'word' });
  await page.reload();
  await waitForMarks(7);
  assert.deepEqual(await texts(), ['Apple', 'apple', 'APPLE']);
  await seedKeywords({ term: 'apple', match: 'variants' });
  await waitForMarks(8);
  assert.deepEqual(await texts(), ['Apple', 'apple', 'APPLE', 'apples']);
  await seedKeywords({ term: 'apple', match: 'anywhere' });
  await waitForMarks(9);
  assert.deepEqual(await texts(), ['Apple', 'apple', 'APPLE', 'apple', 'apple']);
});

test('site-scoped keywords and paused sites', async () => {
  await seed({
    lists: [{ id: 'org', name: 'Org', sites: ['example.org'] }, { id: 'local', name: 'Local', sites: ['127.0.0.1'] }],
    keywords: [{ term: 'pie', listId: 'org' }, { term: 'juice', listId: 'local' }],
  });
  await page.reload();
  await waitForMarks(1);
  assert.equal((await marks())[0].text, 'juice');
  await setStorage('sync', { pausedSites: ['127.0.0.1'] });
  await waitForMarks(0);
  await setStorage('sync', { pausedSites: [] });
  await waitForMarks(1);
});

test('save and unsave from the page', async () => {
  await doubleClickWord(page, '#fruit', 'juice');
  await swatch('Aqua').click();
  await sendToPage({ type: 'save', key: 'juice' });
  const { lists, keywords } = await loadStore();
  assert.equal(keywords[0].color, '#00FFFF');
  assert.deepEqual(lists.map((l) => [l.name, l.sites]), [['My keywords', []]]);
  assert.equal(keywords[0].listId, lists[0].id);
  await page.reload();
  await waitForMarks(1);

  await sendToPage({ type: 'unsave', key: 'juice' });
  assert.deepEqual(await inExtension(() => chrome.storage.sync.get('kw:juice')), {});
  assert.equal((await marks()).length, 1, 'unsave keeps the highlight until reload');
  await page.reload();
  await waitForMarks(0);
});

test('trigger setting: Alt + double-click, or off', async () => {
  await setStorage('local', { trigger: 'alt' });
  await page.reload();
  const { x, y } = await wordPoint(page, '#fruit', 'juice');
  await page.mouse.dblclick(x, y);
  await page.waitForTimeout(200);
  assert.equal(await picker().count(), 0, 'plain double-click must not open the picker');
  await page.keyboard.down('Alt');
  await page.mouse.dblclick(x, y);
  await page.keyboard.up('Alt');
  await picker().locator('.card').waitFor();

  await setStorage('local', { trigger: 'off' });
  await page.keyboard.press('Escape');
  await page.keyboard.down('Alt');
  await page.mouse.dblclick(x, y);
  await page.keyboard.up('Alt');
  await page.waitForTimeout(200);
  assert.equal(await picker().count(), 0);
});

test('context menu / shortcut path opens the picker for the current selection', async () => {
  await page.evaluate(() => {
    const node = document.querySelector('#cafe').firstChild;
    const range = document.createRange();
    range.setStart(node, node.data.indexOf('corner'));
    range.setEnd(node, node.data.indexOf('corner') + 6);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  const { opened } = await sendToPage({ type: 'open-picker' });
  assert.equal(opened, true);
  await page.bringToFront();
  assert.equal(await picker().locator('.term').textContent(), 'corner');
});

test('hide and show all highlights on the page', async () => {
  await seedKeywords({ term: 'apple' });
  await page.reload();
  await waitForMarks(7);
  await sendToPage({ type: 'toggle-hidden' });
  await waitForMarks(0);
  await sendToPage({ type: 'toggle-hidden' });
  await waitForMarks(7);
});

test('scrollbar markers show where matches are and jump on click', async () => {
  await seedKeywords({ term: 'apple' });
  await page.reload();
  await waitForMarks(7);
  const ticks = page.locator('word-highlighter-markers .tick');
  await ticks.first().waitFor();
  assert.ok(await ticks.count() >= 2);
  await page.evaluate(() => scrollTo(0, 0));
  await ticks.last().click();
  await page.waitForFunction(() => scrollY > 1000, null, { timeout: 3000 });

  await setStorage('local', { showMarkers: false });
  await page.locator('word-highlighter-markers').waitFor({ state: 'detached' });
});

test('jumping to a match pulses it visibly, despite the !important highlight styles', async () => {
  await seedKeywords({ term: 'apple' });
  await page.reload();
  await waitForMarks(7);
  await sendToPage({ type: 'jump', key: 'apple' });
  const { rest, peak } = await page.evaluate(() => {
    const mark = [...document.querySelectorAll('mark.word-highlighter-mark')].find((m) => m.getAnimations().length);
    const [animation] = mark.getAnimations();
    const look = () => ['boxShadow', 'outlineStyle', 'outlineWidth', 'outlineColor']
      .map((property) => getComputedStyle(mark)[property]).join(' | ');
    animation.pause();
    animation.currentTime = animation.effect.getComputedTiming().duration * 0.3;
    const atPeak = look();
    animation.cancel();
    return { rest: look(), peak: atPeak };
  });
  assert.notEqual(peak, rest, 'the pulse must change how the mark looks');
});

// --- picker ★ save -----------------------------------------------------------

test('picker ★ Save keeps a word on every page, ★ This site scopes it, ★ Saved unsaves', async () => {
  await doubleClickWord(page, '#fruit', 'juice');
  await picker().getByRole('button', { name: 'Save', exact: true }).click();
  await picker().waitFor({ state: 'detached' });
  let { lists, keywords } = await loadStore();
  assert.deepEqual(keywords.map((k) => k.term), ['juice']);
  assert.equal(lists.find((l) => l.id === keywords[0].listId).name, 'My keywords');
  await page.reload();
  await waitForMarks(1);

  await doubleClickWord(page, '#fruit', 'juice');
  await picker().getByRole('button', { name: 'Saved · My keywords' }).click();
  assert.deepEqual((await loadStore()).keywords, []);

  await doubleClickWord(page, '#fruit', 'pie');
  await picker().getByRole('button', { name: 'This site' }).click();
  ({ lists, keywords } = await loadStore());
  const siteList = lists.find((l) => l.id === keywords.find((k) => k.term === 'pie').listId);
  assert.deepEqual([siteList.name, siteList.sites], ['127.0.0.1', ['127.0.0.1']]);
});

// --- popup controls --------------------------------------------------------------

test('popup: ★ saves a row, the add box saves to every page, the site switch pauses', async () => {
  await doubleClickWord(page, '#fruit', 'juice');
  await swatch('Aqua').click();
  const popup = await openPopup();
  const row = popup.locator('#terms li').first();
  await row.hover();
  await row.locator('.star').click();
  await popup.locator('#terms li .star[aria-pressed="true"]').waitFor();
  assert.equal(await row.locator('.list-name').textContent(), 'My keywords');

  await popup.locator('#add-input').fill('corner');
  await popup.locator('#add-button').click();
  await popup.locator('#note', { hasText: 'Saved “corner” to My keywords' }).waitFor();
  await waitForMarks(2);
  await popup.locator('#terms li').nth(1).waitFor();

  assert.equal(await popup.locator('#site').textContent(), '127.0.0.1');
  await popup.locator('#site-panel').click();
  await waitForMarks(0);
  assert.deepEqual((await loadStore()).pausedSites, ['127.0.0.1']);
  await popup.locator('#site-status', { hasText: 'Paused here' }).waitFor();
  await popup.locator('#site-panel').click();
  await waitForMarks(2);
});

test('popup: Clear removes only page highlights; Hide hides everything', async () => {
  await seedKeywords({ term: 'pie' });
  await page.reload();
  await waitForMarks(1);
  await doubleClickWord(page, '#fruit', 'juice');
  await swatch('Aqua').click();
  await waitForMarks(2);

  const popup = await openPopup();
  await popup.locator('#clear').click();
  await waitForMarks(1);
  assert.deepEqual(await popup.locator('#terms .label').allTextContents(), ['pie']);
  assert.equal(await popup.locator('#clear').isDisabled(), true);

  await popup.locator('#hide').click();
  await waitForMarks(0);
  await popup.locator('#state', { hasText: 'Highlights hidden' }).waitFor();
  await popup.locator('#hide').click();
  await waitForMarks(1);
});

test('variants switch turns word variants off everywhere; per-keyword modes still win', async () => {
  await seedKeywords({ term: 'apple', match: 'default' }, { term: 'café', match: 'variants' });
  await page.reload();
  await waitForMarks(11); // apple + variants: 8 · café forced variants: 3
  const popup = await openPopup();
  assert.equal(await popup.locator('#variants').isChecked(), true);
  await popup.locator('label.setting').click();
  await waitForMarks(10); // "apples" drops out; "cafés" stays
  const texts = (await marks()).map((m) => m.text);
  assert.ok(!texts.includes('apples') && texts.includes('cafés'));
  await popup.locator('label.setting').click();
  await waitForMarks(11);
});

// --- options page -------------------------------------------------------------------

test('options: build a list end to end and watch the page follow live', async () => {
  const options = await openOptions();
  await options.locator('#first-list').click();
  const card = options.locator('.list').first();
  await card.locator('.list-name').fill('Fruit');
  await card.locator('.list-name').press('Enter');
  await card.locator('.add-input').fill('apple, juice, Juice');
  await card.locator('.add-keywords button').click();
  await card.locator('.keyword').nth(1).waitFor();
  assert.equal(await card.locator('.keyword').count(), 2, 'duplicates collapse');
  assert.equal(await card.locator('.add-input').inputValue(), '', 'add box clears');
  let { lists, keywords } = await loadStore();
  assert.deepEqual([lists[0].name, keywords.map((k) => k.term)], ['Fruit', ['apple', 'juice']]);
  assert.notEqual(keywords[0].color, keywords[1].color, 'new keywords get distinct colors');
  await waitForMarks(9); // apple (variants) 8 + juice 1

  const apple = card.locator('.keyword').first();
  await apple.locator('.kw-color').click();
  await options.locator('#palette button[title="Neon Pink"]').click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('mark[data-term="apple"]')).backgroundColor === 'rgb(255, 0, 127)');

  await apple.locator('.kw-match').selectOption('anywhere');
  await waitForMarks(10); // + pineapple
  await apple.locator('.kw-match').selectOption('word');
  await waitForMarks(8);

  await card.locator('.site-input').fill('https://www.example.org/news');
  await card.locator('.site-input').press('Enter');
  await waitForMarks(0);
  ({ lists } = await loadStore());
  assert.deepEqual(lists[0].sites, ['example.org']);
  await card.locator('.sites .chip button').click();
  await waitForMarks(8);

  await card.locator('.list-head label').click();
  await waitForMarks(0);
  await card.locator('.list-head label').click();
  await waitForMarks(8);

  const juice = card.locator('.keyword').nth(1).locator('.kw-term');
  await juice.fill('lait');
  await juice.press('Enter');
  await page.waitForFunction(() => document.querySelector('mark[data-term="lait"]'));
  assert.deepEqual((await loadStore()).keywords.map((k) => k.term).sort(), ['apple', 'lait']);

  await card.locator('.keyword').nth(1).hover();
  await card.locator('.keyword').nth(1).locator('.kw-delete').click();
  await waitForMarks(7);

  options.once('dialog', (dialog) => dialog.accept());
  await card.locator('.list-delete').click();
  await options.locator('#lists-empty:not([hidden])').waitFor();
  await waitForMarks(0);
  assert.deepEqual(await loadStore(), { lists: [], keywords: [], pausedSites: [] });
});

test('options: filter, move between lists, settings, shortcuts, export and import', async () => {
  await seed({
    lists: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
    keywords: [{ term: 'juice', listId: 'a' }, { term: 'pie', listId: 'a' }, { term: 'corner', listId: 'b' }],
    pausedSites: ['example.org'],
  });
  const options = await openOptions();
  await options.locator('.list').nth(1).waitFor();

  await options.locator('#filter').fill('jui');
  assert.equal(await options.locator('.keyword').count(), 1);
  await options.locator('#filter').fill('');

  await options.locator('.keyword', { has: options.locator('.kw-term[aria-label="Keyword pie"]') })
    .locator('.kw-list').selectOption('b');
  await options.locator('.list').nth(1).locator('.keyword').nth(1).waitFor();
  assert.equal((await loadStore()).keywords.find((k) => k.term === 'pie').listId, 'b');

  await options.locator('.segmented label', { hasText: 'Off' }).click();
  assert.equal((await inExtension(() => chrome.storage.local.get('trigger'))).trigger, 'off');

  assert.equal(await options.locator('#shortcut-list li').count(), 3);
  assert.match(await options.locator('#paused').textContent(), /example\.org/);
  assert.match(await options.locator('#usage-text').textContent(), /3 keywords in 2 lists/);

  const [download] = await Promise.all([options.waitForEvent('download'), options.locator('#export').click()]);
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(backup.keywords.length, 3);

  await inExtension(() => chrome.storage.sync.clear());
  await options.locator('#lists-empty:not([hidden])').waitFor();
  await options.locator('#import-file').setInputFiles(await download.path());
  await options.locator('.list').nth(1).waitFor();
  const restored = await loadStore();
  assert.deepEqual(restored.keywords.map((k) => k.term).sort(), ['corner', 'juice', 'pie']);
  assert.deepEqual(restored.pausedSites, ['example.org']);
});
