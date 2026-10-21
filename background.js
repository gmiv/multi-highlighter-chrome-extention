// Word Highlighter — background worker: toolbar badge, context menu, shortcuts.

const CONTENT_SCRIPTS = ['shared.js', 'content.js'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'open-picker', title: 'Highlight “%s”', contexts: ['selection'] });
});

// Send to the tab's content script, injecting it first into tabs that were
// open before the extension was installed (the click or shortcut grants
// activeTab, which makes the injection allowed).
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id >= 0) sendToTab(tab.id, { type: info.menuItemId }).catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id >= 0) sendToTab(tab.id, { type: command }).catch(() => {});
});

// Match count on the toolbar icon, per tab.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'count' || !sender.tab) return;
  const { count } = message;
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: count ? (count > 999 ? '999+' : String(count)) : '' });
});

chrome.action.setBadgeBackgroundColor({ color: '#17171C' });
chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
