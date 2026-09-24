// The Alt+K window: the same command bar as the manager, over whatever page you were on.
import { db, loadLibrary, getSettings } from "./lib.js";
import { commandBar } from "./cmd.js";

const close = () => window.close();
window.addEventListener("blur", close);

(async () => {
  const [lib, settings, { cmdTab }] = await Promise.all([loadLibrary(), getSettings(), chrome.storage.session.get("cmdTab")]);
  let pages = null;
  if (settings.pageSearch) {
    const all = await db.all("pages");
    pages = new Map([...all].map(([k, v]) => [k, { ...v, low: v.text.toLowerCase() }]));
  }
  document.body.append(commandBar({
    lib, pages: () => pages, tabId: cmdTab, close,
    // Enter opens in the tab you came from, Ctrl or Cmd + Enter in a new one.
    openUrl: async (url, newTab) => {
      if (newTab || !cmdTab) await chrome.tabs.create({ url });
      else await chrome.tabs.update(cmdTab, { url });
      close();
    },
    goTo: async (hash) => {
      await chrome.tabs.create({ url: `chrome://bookmarks/${hash ? "#" + hash : ""}` });
      close();
    },
  }));
})();
