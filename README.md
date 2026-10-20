# multi-highlighter-chrome-extention

## Description

Word Highlighter is a Chrome extension: double-click any word on a webpage, pick a color, and every occurrence of that word on the page is highlighted in bold. Use one color per theme to make the structure of an article jump off the page.

## Features

- **Highlight every match:** Double-click a word and choose from 12 neon presets or any custom color. Matching is whole-word, case-insensitive, and Unicode-aware (`café`, `naïve`, `C++` all work), and the page's original casing is kept.
- **Recolor or remove in place:** Double-click a highlighted word to change its color or remove it.
- **Popup overview:** See every highlighted word on the page with its match count, click a word to jump through its matches, remove one, or **Clear all highlights**.
- **Copy on double-click:** The word is also copied to your clipboard (toggle it off in the popup).
- **Keyboard friendly:** Arrow keys move between swatches, Enter applies, Esc closes the picker.
- **Plays nice with pages:** The picker lives in a shadow root so site CSS can't break it, editors and form fields are never touched, it works on pages with strict CSP, and removing highlights restores the page exactly.
- **Light and dark:** Follows your system theme.

## Installation

1. **Clone the Repository:** https://github.com/gmiv/multi-highlighter-chrome-extention.git
2. **Load the Extension in Chrome:**
- Open Chrome and navigate to `chrome://extensions/`.
- Enable 'Developer Mode' at the top right.
- Click 'Load unpacked' and select the cloned extension directory.
3. Tabs that were already open pick the extension up when you refresh them or open its popup on them.

## Usage

- **Highlight a Word:** Double-click a word, then click a color.
- **Recolor / Remove:** Double-click a highlighted word and pick a new color or **Remove**.
- **Jump to Matches:** Open the popup and click a word to scroll to its next match.
- **Clear Highlights:** Click the extension icon in the toolbar and press **Clear all highlights**.

Highlights last until the page is reloaded.

## Testing

End-to-end tests load the real unpacked extension into Chromium and drive real double-clicks and the real popup:

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
