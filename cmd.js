// One box for bookmarks, open tabs and actions. Every result says why it matched.
import { parseQuery, matchBookmark, shortUrl, n, isWeb, normUrl, guessFolder, setMeta, db, wordCount, activity } from "./lib.js";
import { h, icon, fav, isMac, captureText } from "./ui.js";

// opts: { lib, pages() -> Map|null, tabId, close(), openUrl(url, newTab), goTo(hash) }
export function commandBar(opts) {
  const input = h("input", { placeholder: "Search bookmarks, open tabs and actions", "aria-label": "Search", autocomplete: "off", spellcheck: false });
  const results = h("div", { className: "cmd-results", role: "listbox" });
  const foot = [["↑ ↓", "Move"], ["Enter", "Open"], [isMac ? "⌘ Enter" : "Ctrl Enter", "New tab"], ["Esc", "Close"]];
  const root = h("div", { className: "cmd", role: "dialog", "aria-label": "Command bar" },
    h("div", { className: "cmd-input" }, icon("search"), input, h("span", { className: "kbd", textContent: "Esc" })),
    h("hr"),
    results,
    h("div", { className: "cmd-foot" }, foot.map(([k, t]) => h("span", {}, h("span", { className: "kbd", textContent: k }), t))),
  );

  let items = [], active = 0, tab = null, folder = null, seq = 0;

  const why = (b, m, q) => m.where === "Note" ? `your note mentions ${q.text}` : m.where === "Page text" ? "matched in the saved page text" : b.path || "Top level";

  function item({ lead, title, sub, aside, kbd, run }) {
    const el = h("button", { className: "cmd-item", type: "button", role: "option" },
      lead,
      h("span", { className: "main" }, h("b", { textContent: title }), sub && h("small", { textContent: sub })),
      aside && h("span", { className: "aside", textContent: aside }),
      kbd && h("span", { className: "kbd", textContent: kbd }));
    const it = { el, run };
    el.onclick = (e) => run(e.metaKey || e.ctrlKey);
    el.onmousemove = () => select(items.indexOf(it));
    return it;
  }

  function select(i) {
    if (!items.length) return;
    active = (i + items.length) % items.length;
    items.forEach((it, j) => it.el.setAttribute("aria-selected", String(j === active)));
    items[active].el.scrollIntoView({ block: "nearest" });
  }

  async function update() {
    const mine = ++seq;
    const q = parseQuery(input.value);
    const groups = [];
    if (q.terms.length || q.site || q.tag) {
      const pages = opts.pages?.();
      const hits = [];
      for (const b of opts.lib.bookmarks) {
        const m = matchBookmark(b, q, pages?.get(b.norm));
        if (m) hits.push([b, m]);
      }
      const rank = { Title: 0, Note: 1, "Page text": 2 };
      hits.sort((a, b) => rank[a[1].where] - rank[b[1].where] || (b[0].opens?.last || 0) - (a[0].opens?.last || 0));
      const shown = hits.slice(0, 5);
      if (shown.length) groups.push([`Bookmarks, ${shown.length} of ${n(hits.length)}`, shown.map(([b, m]) => item({ lead: fav(b.url), title: b.title, sub: `${b.host} · ${why(b, m, q)}`, aside: activity(b), run: (nt) => opts.openUrl(b.url, nt) }))]);
      const tabs = (await chrome.tabs.query({})).filter((t) => isWeb(t.url || "") && q.terms.every((x) => `${t.title} ${t.url}`.toLowerCase().includes(x))).slice(0, 3);
      if (tabs.length) groups.push(["Open tabs", tabs.map((t) => item({ lead: fav(t.url), title: t.title, sub: shortUrl(t.url), aside: "Switch to tab", run: () => { chrome.tabs.update(t.id, { active: true }); chrome.windows.update(t.windowId, { focused: true }); opts.close(); } }))]);
    } else {
      const recent = [...opts.lib.bookmarks].sort((a, b) => b.dateAdded - a.dateAdded).slice(0, 5);
      groups.push(["Saved lately", recent.map((b) => item({ lead: fav(b.url), title: b.title, sub: `${b.host} · ${b.path || "Top level"}`, aside: activity(b), run: (nt) => opts.openUrl(b.url, nt) }))]);
    }
    const acts = [];
    if (tab && folder && isWeb(tab.url)) {
      const saved = opts.lib.byNorm.get(normUrl(tab.url));
      acts.push(saved
        ? item({ lead: icon("ribbon"), title: `This tab is already saved in ${saved[0].path || "the top level"}`, run: () => opts.goTo(`q=${encodeURIComponent(tab.url)}`) })
        : item({ lead: icon("ribbon"), title: `Save this tab to ${folder.title}`, kbd: "Alt S", run: saveTab }));
    }
    if (q.text) acts.push(item({ lead: icon("reader"), title: `Search only saved page text for ${q.text}`, run: () => opts.goTo(`q=${encodeURIComponent(input.value)}&scope=text`) }));
    for (const [title, hash, ic] of [["Start clean-up", "cleanup", "refresh"], ["Open settings", "settings", "sliders"], ["Open the library", "", "library"]]) {
      if (!q.text || title.toLowerCase().includes(q.text)) acts.push(item({ lead: icon(ic), title, run: () => opts.goTo(hash) }));
    }
    if (acts.length) groups.push(["Actions", acts]);

    if (mine !== seq) return; // a newer keystroke already rendered
    items = groups.flatMap(([, its]) => its);
    results.replaceChildren(...groups.flatMap(([label, its]) => [h("div", { className: "cmd-group", textContent: label }), ...its.map((it) => it.el)]));
    if (!items.length) results.append(h("p", { className: "empty", textContent: "Nothing matches. Try fewer words." }));
    select(0);
  }

  async function saveTab() {
    const text = await captureText(tab.id);
    await chrome.storage.session.set({ saving: tab.url });
    const node = await chrome.bookmarks.create({ parentId: folder.id, title: tab.title || tab.url, url: tab.url });
    await chrome.storage.local.set({ lastFolder: folder.id });
    if (wordCount(text) > 20) await db.put("pages", normUrl(tab.url), { text, words: wordCount(text), title: tab.title, fetchedAt: Date.now(), via: "save" });
    await setMeta(node.id, {});
    input.value = "";
    input.placeholder = `Saved to ${folder.title}`;
    setTimeout(opts.close, 700);
  }

  input.oninput = update;
  root.onkeydown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); select(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(active - 1); }
    else if (e.key === "Enter" && items[active]) { e.preventDefault(); items[active].run(e.metaKey || e.ctrlKey); }
    else if (e.key === "Escape") { e.preventDefault(); opts.close(); }
  };

  (async () => {
    if (opts.tabId) {
      tab = await chrome.tabs.get(opts.tabId).catch(() => null);
      if (tab && isWeb(tab.url)) {
        const g = await guessFolder(opts.lib, tab.url);
        folder = opts.lib.folders.find((f) => f.id === g.id);
      }
    }
    update();
  })();

  setTimeout(() => input.focus());
  return root;
}
