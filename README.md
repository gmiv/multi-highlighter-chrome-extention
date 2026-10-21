# multi-highlighter-chrome-extention

## Description

Word Highlighter is a Chrome extension that highlights words in color on every page you visit. Keep **saved keyword lists** (job-hunt terms, allergens, names, red flags) that are spotted automatically everywhere, or **double-click** any word for a quick, this-page-only highlight.

## Features

- **Saved keyword lists:** Group keywords into named lists. Each list can be switched on or off and limited to specific sites, and each keyword has its own color and match mode. Lists sync across every Chrome you're signed in to.
- **Highlights every page automatically:** Saved keywords are applied as pages load and keep up with content added later (infinite scroll, single-page apps, feeds, chat).
- **Double-click to highlight:** Pick from 12 neon presets or any custom color. Press **★ Save** to keep the word on every site, or **★ This site** to keep it on just this one.
- **Smart matching:** Whole-word, case-insensitive and Unicode-aware (`café`, `naïve`, `C++`). Turn **Match word variants** on or off (apple → apples, city → cities, run → running), and override it per keyword: Exact word, Word + variants, or Anywhere (apple → pineapple).
- **Scrollbar markers:** Colored ticks on the right edge show where every match is; click one to jump there.
- **Match count on the toolbar icon**, plus a popup listing every highlighted word with its count. Click a word to jump through its matches.
- **Your rules:** Pause saved keywords on a site, hide everything on a page, choose the trigger (double-click, Alt + double-click, or off), copy-on-double-click on or off.
- **Right-click → Highlight** and keyboard shortcuts: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> opens the popup, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> highlights the selection, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd> shows or hides highlights.
- **Backup:** Export and import your lists as JSON.
- **Plays nice with pages:** The picker and markers live in shadow roots so site CSS can't break them, editors and form fields are never touched, it works on pages with strict CSP, and removing highlights restores the page exactly. Light and dark themes follow your system.

## Installation

1. **Clone the Repository:** https://github.com/gmiv/multi-highlighter-chrome-extention.git
2. **Load the Extension in Chrome:**
- Open Chrome and navigate to `chrome://extensions/`.
- Enable 'Developer Mode' at the top right.
- Click 'Load unpacked' and select the cloned extension directory.
3. Tabs that were already open pick the extension up when you refresh them or use it on them.

## Usage

- **Quick highlight:** Double-click a word, then click a color. Double-click a highlighted word to recolor or remove it.
- **Save a keyword:** Press **★ Save** in the picker, click ☆ next to a word in the popup, or type it into the popup's "Add a keyword" box.
- **Manage lists:** Click the sliders icon in the popup (or "Manage keyword lists & settings"). Add keywords in bulk with commas, click a color dot to recolor, rename inline, move keywords between lists, and limit a list to sites like `example.com` (subdomains included).
- **Pause on a site:** Flip "Saved keywords on" in the popup.
- **Clear page highlights:** Removes this page's double-click highlights; saved keywords stay. Use the eye button to hide everything.

## Testing

End-to-end tests load the real unpacked extension into Chromium and drive real double-clicks, the real popup and the real options page:

```sh
cd test
npm install
npx playwright install chromium   # first time only
npm test
```

## Contributing

Contributions to the Word Highlighter extension are welcome. Please follow these steps to contribute:

1. Fork the repository.
2. Create a new branch for your feature.
3. Add your changes and commit them.
4. Push to your branch.
5. Create a new Pull Request.

## License

This project is licensed under the [MIT License](LICENSE).
