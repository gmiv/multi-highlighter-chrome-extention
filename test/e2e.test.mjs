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
  await ext.evaluate(() => chrome.storage.local.clear());
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
  // fruit: Apple, apple, APPLE · mixed: apple ×3 · far: apple. Not pineapple/apples.
  assert.deepEqual(texts, ['Apple', 'apple', 'APPLE', 'apple', 'apple', 'apple', 'apple']);
  assert.ok(found.every((m) => m.term === 'apple' && !m.nested));
  assert.ok(found.every((m) => m.bg === 'rgb(0, 255, 255)' && m.weight === '700'));
  assert.ok(found.every((m) => m.padding === '0px'), 'page `mark { padding }` must not leak in');
  assert.equal(await page.locator('#ta').inputValue(), 'apple inside a textarea');
  assert.ok(!found.some((m) => ['ce', 'svgtext', 'ta'].includes(m.parent)));
});

test('unicode words match on real word boundaries', async () => {
  await doubleClickWord(page, '#cafe', 'café');
  await swatch('Gold').click();
  assert.deepEqual((await marks()).map((m) => m.text), ['Café', 'café']);
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
  assert.equal(found.length, 7);
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
  assert.equal((await marks()).length, 7);
});

test('double-click copies the word, and the popup toggle turns that off', async () => {
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  await doubleClickWord(page, '#fruit', 'juice');
  await picker().locator('.copied.show').waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'juice');
  await page.keyboard.press('Escape');

  const popup = await openPopup();
  assert.equal(await popup.locator('#copy').isChecked(), true);
  await popup.locator('.setting').click();
  assert.equal(await popup.locator('#copy').isChecked(), false);
  await popup.close();

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
  assert.deepEqual(await rows.locator('.count').allTextContents(), ['7', '2']);
  assert.equal(await popup.locator('#summary').textContent(), '2 words · 9 matches');

  // Jump cycles through visible matches and scrolls the far one into view.
  const jump = rows.first().locator('.jump');
  for (let i = 0; i < 7; i++) await jump.click();
  assert.equal(await rows.first().locator('.count').textContent(), '7/7');
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
