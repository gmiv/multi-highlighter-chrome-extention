// Word Highlighter — shared by the content script, popup and options page.
// Assigned with ??= so the popup's re-injection fallback can load it twice.
globalThis.WH ??= (() => {
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

  const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
  const NOT_BEFORE = '(?<![\\p{L}\\p{N}\\p{M}_])';
  const NOT_AFTER = '(?![\\p{L}\\p{N}\\p{M}_])';

  const normalizeTerm = (text) => text.replace(/\s+/g, ' ').trim();
  const keyFor = (term) => normalizeTerm(term).toLocaleLowerCase();
  const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // How a keyword matches text ("default" in storage follows the global
  // "Match word variants" switch and resolves to word or variants):
  //   word     — the whole word only            apple → apple
  //   variants — plus common English endings    apple → apples, city → cities
  //   anywhere — inside other words too         apple → pineapple
  const MATCH_MODES = ['word', 'variants', 'anywhere'];

  // Inflections of the last word of a term, or null if it isn't all letters.
  function variantsOf(term) {
    const words = term.split(' ');
    const last = words.pop();
    if (!/^\p{L}{2,}$/u.test(last)) return null;
    const lead = words.map((w) => `${escapeRegExp(w)}\\s+`).join('');
    const stem = last.slice(0, -1);
    let forms;
    if (/[^aeiou]y$/i.test(last)) {
      forms = `${last}(?:s|['’]s|ing|ed)?|${stem}i(?:es|ed|er|ers|est|ly)`;
    } else if (/e$/i.test(last) && last.length > 2) {
      forms = `${last}(?:s|d|r|rs|st|ly|['’]s)?|${stem}ing`;
    } else {
      forms = `${last}(?:['’]s|s|es|ed|ing|er|ers|est|ly)?`;
      // Doubled final consonant: run → running, stop → stopped.
      if (/[^aeiou][aeiou][^aeiouwxy]$/i.test(last)) forms += `|${last}${last.at(-1)}(?:ed|ing|er|ers|est)`;
    }
    return `${lead}(?:${forms})`;
  }

  // Regex source for one term, with no capture groups of its own. Word
  // boundaries are Unicode-aware and only asserted on an edge that is itself a
  // word character, so "C++" and "$5" still match.
  function termPattern(term, match = 'word') {
    const body = term.split(' ').map(escapeRegExp).join('\\s+');
    if (match === 'anywhere') return body;
    const chars = Array.from(term);
    const variants = match === 'variants' ? variantsOf(term) : null;
    const head = WORD_CHAR.test(chars[0]) ? NOT_BEFORE : '';
    const tail = variants || WORD_CHAR.test(chars[chars.length - 1]) ? NOT_AFTER : '';
    return head + (variants ?? body) + tail;
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

  // Saved keywords live in chrome.storage.sync as one item per list and per
  // keyword, so two devices editing different keywords merge cleanly and the
  // 8 KB per-item quota is never hit. A keyword's id is its lower-cased term, so
  // a term lives in exactly one list.
  const LIST_PREFIX = 'list:';
  const KEYWORD_PREFIX = 'kw:';
  const PAUSED = 'pausedSites';
  const DEFAULT_LIST_NAME = 'My keywords';

  // "www.example.com" and "example.com" are the same site to a reader.
  const siteOf = (hostname) => hostname.replace(/^www\./, '').toLowerCase();

  // Accepts "https://www.example.com/path", "example.com" or "localhost:8080".
  function parseSite(input) {
    const text = input.trim();
    if (!text) return null;
    try {
      return siteOf(new URL(text.includes('://') ? text : `https://${text}`).hostname) || null;
    } catch {
      return null;
    }
  }

  // A list with no sites applies everywhere; "example.com" covers its subdomains.
  function coversSite(sites, hostname) {
    if (!sites?.length) return true;
    const site = siteOf(hostname);
    return sites.some((s) => site === s || site.endsWith(`.${s}`));
  }

  const byCreated = (a, b) => a.created - b.created;
  const sync = chrome.storage.sync;

  const store = {
    async load() {
      const all = await sync.get(null);
      const lists = [];
      const keywords = [];
      for (const [name, value] of Object.entries(all)) {
        if (name.startsWith(LIST_PREFIX)) lists.push(value);
        else if (name.startsWith(KEYWORD_PREFIX)) keywords.push(value);
      }
      return { lists: lists.sort(byCreated), keywords: keywords.sort(byCreated), pausedSites: all[PAUSED] ?? [] };
    },

    // Keywords that should be highlighted on `hostname`.
    activeKeywords({ lists, keywords }, hostname) {
      const live = new Map(lists
        .filter((list) => list.enabled !== false && coversSite(list.sites, hostname))
        .map((list) => [list.id, list]));
      return keywords.filter((k) => live.has(k.listId)).map((k) => ({ ...k, listName: live.get(k.listId).name }));
    },

    createList(name, options = {}) {
      return { id: crypto.randomUUID(), name, enabled: true, sites: [], created: Date.now(), ...options };
    },

    putList(list) {
      return sync.set({ [LIST_PREFIX + list.id]: list });
    },

    async removeList(id) {
      const { keywords } = await store.load();
      await sync.remove([LIST_PREFIX + id, ...keywords.filter((k) => k.listId === id).map((k) => KEYWORD_PREFIX + k.id)]);
    },

    // Where ★ Save puts a keyword: the first all-sites list, or a new one.
    async defaultList() {
      const { lists } = await store.load();
      const list = lists.find((l) => !l.sites?.length) ?? store.createList(DEFAULT_LIST_NAME);
      if (!lists.includes(list)) await store.putList(list);
      return list;
    },

    // Where "★ This site" puts a keyword: a list for exactly that site.
    async siteList(hostname) {
      const site = siteOf(hostname);
      const { lists } = await store.load();
      const list = lists.find((l) => l.sites?.length === 1 && l.sites[0] === site)
        ?? store.createList(site, { sites: [site] });
      if (!lists.includes(list)) await store.putList(list);
      return list;
    },

    create(term, color, options = {}) {
      const clean = normalizeTerm(term);
      return { id: keyFor(clean), term: clean, color, match: 'default', listId: null, created: Date.now(), ...options };
    },

    put(...keywords) {
      return sync.set(Object.fromEntries(keywords.map((k) => [KEYWORD_PREFIX + k.id, k])));
    },

    async update(id, patch) {
      const name = KEYWORD_PREFIX + id;
      const { [name]: keyword } = await sync.get(name);
      if (keyword) await sync.set({ [name]: { ...keyword, ...patch } });
    },

    remove(...ids) {
      return sync.remove(ids.map((id) => KEYWORD_PREFIX + id));
    },

    async setPaused(hostname, paused) {
      const site = siteOf(hostname);
      const { [PAUSED]: list = [] } = await sync.get(PAUSED);
      const next = paused ? [...new Set([...list, site])] : list.filter((s) => s !== site);
      await sync.set({ [PAUSED]: next });
    },

    isPaused(pausedSites, hostname) {
      return pausedSites.includes(siteOf(hostname));
    },

    // Merge a backup in one write (sync storage limits writes per minute).
    // Keywords whose list is missing land in `fallbackListId`.
    importAll({ lists = [], keywords = [], pausedSites = [] }, current, fallbackListId) {
      const listIds = new Set([...current.lists, ...lists].map((l) => l.id));
      const items = { [PAUSED]: [...new Set([...current.pausedSites, ...pausedSites])] };
      for (const list of lists) items[LIST_PREFIX + list.id] = list;
      for (const k of keywords) items[KEYWORD_PREFIX + k.id] = listIds.has(k.listId) ? k : { ...k, listId: fallbackListId };
      return sync.set(items);
    },

    // A preset the list isn't using yet, so new keywords come out distinct.
    nextColor(usedColors) {
      const used = new Set(usedColors.map((c) => c.toUpperCase()));
      return (PRESETS.find(({ hex }) => !used.has(hex)) ?? PRESETS[used.size % PRESETS.length]).hex;
    },

    onChange(callback) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        const names = Object.keys(changes);
        if (names.some((n) => n.startsWith(KEYWORD_PREFIX) || n.startsWith(LIST_PREFIX) || n === PAUSED)) callback();
      });
    },
  };

  return { PRESETS, MATCH_MODES, normalizeTerm, keyFor, termPattern, inkFor, siteOf, parseSite, store };
})();
