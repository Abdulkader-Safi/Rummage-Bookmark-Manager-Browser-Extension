import { db, DAY, BIN_DAYS, SYNC_LIMIT, loadLibrary, inInbox, isWeb, host, shortUrl, normUrl, setMeta, getSettings, saveSettings, parseQuery, matchBookmark, snippet, linkLabel, ago, fmtDate, n, plural, activity, toNetscape } from "./lib.js";
import { h, icon, fav, tagInput, download, isMac } from "./ui.js";
import { commandBar } from "./cmd.js";

const $ = (id) => document.getElementById(id);
const ALL = { origins: ["<all_urls>"] };

let lib = { bookmarks: [], folders: [], roots: [], byNorm: new Map(), nodes: 0 };
let byId = new Map(), folderById = new Map();
let settings = {};
let pages = null, pagesLoading = null, pagesAt = 0; // saved page text, loaded on first search
let binCount = 0, groups = [], counts = {}, loadedAt = Date.now();
let matches = new Map();       // bookmark id -> where the current search matched
let current = { items: [] };   // what the open view lists, for select-all and the counters

const ui = { view: "all", folder: null, tab: "dead", mode: "list", sort: "newest", q: "", scope: "all", time: "any", hideDead: false, focus: null };
const selected = new Set();

let expanded;
try { expanded = new Set(JSON.parse(localStorage.getItem("expanded") || "[]")); } catch { expanded = new Set(); }

/* Data */

async function load() {
  [lib, settings, binCount] = await Promise.all([loadLibrary(), getSettings(), db.keys("bin").then((k) => k.length)]);
  byId = new Map(lib.bookmarks.map((b) => [b.id, b]));
  folderById = new Map(lib.folders.map((f) => [f.id, f]));
  if (ui.folder && !folderById.has(ui.folder)) Object.assign(ui, { folder: null, view: ui.view === "folder" ? "all" : ui.view });
  if (ui.focus && !byId.has(ui.focus)) ui.focus = null;
  if (ui.view !== "bin") for (const id of selected) if (!byId.has(id)) selected.delete(id);
  derive();
  loadedAt = Date.now();
}

function derive() {
  const now = Date.now();
  groups = [...lib.byNorm.values()].filter((g) => g.length > 1 && isWeb(g[0].url)).sort((a, b) => b.length - a.length || a[0].title.localeCompare(b[0].title));
  const extra = new Set(groups.flatMap((g) => [...g].sort((a, b) => a.dateAdded - b.dateAdded).slice(1).map((b) => b.id)));
  const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
  const c = { inbox: 0, fav: 0, week: 0, dead: 0, suspect: 0, redirected: 0, never: 0, twice: extra.size, openedYear: 0, oldest: now, gauge: { kept: 0, inbox: 0, never: 0, twice: 0, dead: 0 } };
  for (const b of lib.bookmarks) {
    b.inbox = inInbox(b, lib);
    b.stale = !b.opens?.count && now - b.dateAdded > 30 * DAY;
    if (b.inbox) c.inbox++;
    if (b.meta.star) c.fav++;
    if (now - b.dateAdded < 7 * DAY) c.week++;
    if (b.state in c) c[b.state]++;
    if (b.stale) c.never++;
    if (b.opens?.last >= jan1) c.openedYear++;
    if (b.dateAdded && b.dateAdded < c.oldest) c.oldest = b.dateAdded;
    c.gauge[b.state === "dead" ? "dead" : extra.has(b.id) ? "twice" : b.inbox ? "inbox" : b.opens?.count ? "kept" : "never"]++;
  }
  counts = c;
}

// ponytail: every saved page's text sits in memory while searching; fine into the tens of
// thousands of pages, move matching into IndexedDB cursors if a huge library runs short of memory
async function loadPages() {
  pagesLoading ??= (async () => {
    const all = await db.all("pages");
    pages = new Map([...all].map(([k, v]) => [k, { ...v, low: v.text.toLowerCase() }]));
    pagesAt = Date.now();
    pagesLoading = null;
  })();
  return pagesLoading;
}

let loadTimer;
const scheduleLoad = () => { clearTimeout(loadTimer); loadTimer = setTimeout(async () => { await load(); render(); }, 200); };

/* Rendering */

function render() {
  $("search").placeholder = `Search ${plural(lib.bookmarks.length, "bookmark")}: titles, notes${settings.pageSearch ? " and the text of every saved page" : " and addresses"}`;
  $("sync-note").textContent = `Both ways, updated ${sinceText(loadedAt)}`;
  renderNav();
  if (ui.q) renderSearch();
  else if (ui.view === "cleanup") renderCleanup();
  else if (ui.view === "bin") renderBin();
  else if (ui.view === "settings") renderSettings();
  else renderLibrary();
  updateBulk();
}

const sinceText = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : ago(t); };

// Heading on top, then a list with an optional side column (detail or confirm panels).
function mount(top, content, side) {
  const split = h("div", { className: `split${side || ui.focus ? "" : " no-side"}`, id: "split" }, content, h("aside", { className: "side", id: "side" }, side));
  $("view").replaceChildren(...[top].flat(), split);
  if (ui.focus && !side && byId.has(ui.focus)) showDetail(byId.get(ui.focus));
}

// Renders rows 200 at a time as the list scrolls, so 50,000 links open instantly.
function renderRows(list, items, rowFn) {
  let i = 0;
  const sentinel = h("li", { className: "more-sentinel", "aria-hidden": "true" });
  const io = new IntersectionObserver((e) => e[0].isIntersecting && more(), { rootMargin: "1200px" });
  function more() {
    const end = Math.min(items.length, i + 200), out = [];
    for (; i < end; i++) out.push(...[rowFn(items[i], i)].flat().filter(Boolean));
    sentinel.before(...out);
    if (i >= items.length) { io.disconnect(); sentinel.remove(); }
  }
  list.replaceChildren(sentinel);
  more();
  if (i < items.length) io.observe(sentinel);
}

/* Sidebar */

const isOpen = (f) => expanded.has(f.id) !== (f.depth === 0); // top folders start open, the rest closed

function renderNav() {
  const cur = (v, extra) => !ui.q && ui.view === v && (v !== "cleanup" || ui.tab === extra) && (v !== "folder" || ui.folder === extra);
  const item = (v, ic, label, count, extra, o = {}) => h("button",
    { className: "side-item", type: "button", "aria-current": String(cur(v, extra)), style: o.style, onclick: () => go(v, v === "folder" ? { folder: extra } : v === "cleanup" ? { tab: extra } : {}) },
    icon(ic), h("span", { className: "name ellipsis", textContent: label }), h("span", { className: `count${o.alert ? " alert" : ""}`, textContent: n(count) }), o.twisty);
  const label = (t) => h("div", { className: "side-label", textContent: t });

  const folders = [];
  for (const f of lib.folders) {
    let p = folderById.get(f.parentId), shown = true;
    for (; p; p = folderById.get(p.parentId)) if (!isOpen(p)) { shown = false; break; }
    if (!shown) continue;
    const twisty = f.hasKids && h("button", {
      className: "twisty", type: "button", "aria-expanded": String(isOpen(f)), "aria-label": `${isOpen(f) ? "Collapse" : "Expand"} ${f.title}`,
      onclick: (e) => {
        e.stopPropagation();
        expanded.has(f.id) ? expanded.delete(f.id) : expanded.add(f.id);
        try { localStorage.setItem("expanded", JSON.stringify([...expanded])); } catch {}
        renderNav();
      },
    }, icon("chevron"));
    const el = item("folder", "folder", f.title, f.count, f.id, { twisty, style: `padding-left: ${14 + Math.min(f.depth, 5) * 22}px` });
    el.ondragover = (e) => { e.preventDefault(); el.classList.add("drop"); };
    el.ondragleave = () => el.classList.remove("drop");
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove("drop");
      const id = e.dataTransfer.getData("text/bookmark-id");
      if (id) moveTo(selected.has(id) ? [...selected] : [id], f.id);
    };
    folders.push(el);
  }

  $("nav").replaceChildren(
    item("all", "library", "All bookmarks", lib.bookmarks.length),
    item("inbox", "inbox", "Inbox", counts.inbox),
    item("favourites", "star", "Favourites", counts.fav),
    item("week", "clock", "Saved this week", counts.week),
    label("Clean up"),
    item("cleanup", "deadlink", "Dead links", counts.dead, "dead", { alert: counts.dead > 0 }),
    item("cleanup", "duplicate", "Duplicates", counts.twice, "dupes"),
    item("cleanup", "eye", "Never opened", counts.never, "never"),
    item("bin", "trash", "Bin", binCount),
    label("Folders"),
    ...folders,
  );
}

async function go(view, extra = {}) {
  Object.assign(ui, { view, focus: null }, extra);
  if (ui.q) { ui.q = ""; $("search").value = ""; }
  selected.clear();
  await load();
  if (view === "cleanup") preselect();
  render();
  scrollTo(0, 0);
}

/* Rows */

function status(b) {
  if (b.state === "dead") return { text: linkLabel(b.link), cls: "danger" };
  if (b.copies > 1) return { text: b.copies === 2 ? "Saved twice" : `Saved ${b.copies} times`, cls: "brand" };
  return { text: activity(b) };
}

// o: { pick (click selects), match, st, where, whereBrand, line }
function row(b, o = {}) {
  const st = o.st || status(b);
  const m = o.match;
  const stop = (e) => e.stopPropagation();
  const li = h("li", { className: `row${b.state === "dead" ? " dead" : ""}`, "data-id": b.id, "aria-selected": String(!o.pick && ui.focus === b.id), draggable: !o.pick },
    h("button", { className: `box${o.pick ? "" : " hover-only"}`, type: "button", role: "checkbox", "aria-checked": String(selected.has(b.id)), "aria-label": `Select ${b.title}`, onclick: (e) => { stop(e); toggleSelect(b.id); } }),
    fav(b.url),
    h("div", { className: "main" },
      h("a", { className: "title", href: b.url, target: "_blank", rel: "noopener", textContent: b.title, draggable: false, onclick: stop }),
      h("div", { className: "url", textContent: shortUrl(b.url) }),
      m?.snippet && h("div", { className: "snip" }, m.prefix, m.snippet.before, h("b", { textContent: m.snippet.hit }), m.snippet.after),
      o.line && h("div", { className: "snip", textContent: o.line })),
    h("div", { className: "tags" }, (b.meta?.tags || []).slice(0, 3).map((t) => h("span", { className: "tag", textContent: t }))),
    h("div", { className: `where${o.whereBrand ? " brand" : ""}`, textContent: o.where ?? b.path }),
    h("div", { className: `st${st.cls ? " " + st.cls : ""}`, textContent: st.text }),
    h("a", { className: "open", href: b.url, target: "_blank", rel: "noopener", "aria-label": "Open in a new tab", draggable: false, onclick: stop }, icon("arrow")));
  li.onclick = () => (o.pick ? toggleSelect(b.id) : setFocus(b.id));
  li.ondragstart = (e) => e.dataTransfer.setData("text/bookmark-id", b.id);
  return li;
}

function cardEl(b) {
  const st = status(b);
  const li = h("li", { className: "row", "data-id": b.id, "aria-selected": String(ui.focus === b.id), draggable: true },
    h("div", { className: "top-line" }, fav(b.url), h("span", { className: "ellipsis", textContent: b.host })),
    h("a", { className: "title", href: b.url, target: "_blank", rel: "noopener", textContent: b.title, onclick: (e) => e.stopPropagation() }),
    h("div", { className: "tags" }, (b.meta.tags || []).slice(0, 3).map((t) => h("span", { className: "tag", textContent: t }))),
    h("div", { className: `st${st.cls ? " " + st.cls : ""}`, textContent: st.text }));
  li.onclick = () => setFocus(b.id);
  li.ondragstart = (e) => e.dataTransfer.setData("text/bookmark-id", b.id);
  return li;
}

function refreshRow(b) {
  const old = document.querySelector(`.row[data-id="${CSS.escape(b.id)}"]`);
  if (old) old.replaceWith(old.closest(".cards") ? cardEl(b) : row(b, { match: matches.get(b.id) }));
}

function selectAllBox() {
  return h("button", { className: "box on-card", id: "select-all", type: "button", role: "checkbox", "aria-checked": "false", "aria-label": "Select all",
    onclick: () => {
      const all = current.items.length && current.items.every((b) => selected.has(b.id));
      for (const b of current.items) all ? selected.delete(b.id) : selected.add(b.id);
      refreshBoxes();
    } });
}

function toggleSelect(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  refreshBoxes();
}

function refreshBoxes() {
  for (const box of document.querySelectorAll(".row[data-id] .box")) box.setAttribute("aria-checked", String(selected.has(box.closest(".row").dataset.id)));
  updateBulk();
}

function updateBulk() {
  const picking = !ui.q && ["cleanup", "bin"].includes(ui.view);
  $("bulk").hidden = picking || !selected.size || ui.view === "settings";
  $("bulk-count").textContent = `${n(selected.size)} selected`;
  const inView = current.items.filter((b) => selected.has(b.id)).length;
  $("select-all")?.setAttribute("aria-checked", !inView ? "false" : inView === current.items.length ? "true" : "mixed");
  for (const l of document.querySelectorAll(".list")) l.classList.toggle("picking", picking || selected.size > 0);
  if ($("pick-note")) $("pick-note").textContent = current.note?.() || "";
  if (picking) drawConfirm();
}

/* Detail panel */

function setFocus(id) {
  ui.focus = ui.focus === id ? null : id;
  for (const el of document.querySelectorAll('.row[aria-selected="true"]')) el.setAttribute("aria-selected", "false");
  if (!ui.focus) {
    $("split")?.classList.add("no-side");
    $("side")?.replaceChildren();
    return;
  }
  document.querySelector(`.row[data-id="${CSS.escape(id)}"]`)?.setAttribute("aria-selected", "true");
  showDetail(byId.get(id));
}

function showDetail(b) {
  if (!b || !$("side")) return;
  $("split").classList.remove("no-side");
  $("side").replaceChildren(detail(b, matches.get(b.id)));
}

const fact = (k, v) => h("div", {}, h("dt", { textContent: k }), h("dd", {}, v));

function detail(b, m) {
  const page = pages?.get(b.norm);
  const lc = b.link;
  const lcText = !lc ? (settings.linkChecks ? "Not checked yet" : "Link checks are off")
    : b.state === "ok" ? `${lc.code} OK, checked ${ago(lc.checkedAt)}`
    : b.state === "redirected" ? `Moves to ${host(lc.finalUrl)}`
    : `${linkLabel(lc)}, checked ${ago(lc.checkedAt)}`;
  const lcClass = b.state === "ok" ? "brand-text" : ["dead", "suspect"].includes(b.state) ? "danger-text" : "";
  const update = async (patch) => { b.meta = await setMeta(b.id, patch); b.head = null; refreshRow(b); };
  const rerender = async (patch) => { await update(patch); derive(); renderNav(); showDetail(b); };

  const title = h("h2", { textContent: b.title, contentEditable: "plaintext-only", spellcheck: false, title: "Click to rename",
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
    onblur: async (e) => { const t = e.target.textContent.trim(); if (t && t !== b.title) await chrome.bookmarks.update(b.id, { title: t }); } });

  const more = h("button", { className: "btn btn-round", type: "button", "aria-label": "More actions", "aria-haspopup": "menu",
    onclick: (e) => popover(e.currentTarget, [
      [b.meta.star ? "Remove from favourites" : "Add to favourites", "star", () => rerender({ star: !b.meta.star })],
      [b.meta.remindAt ? "Clear the reminder" : "Bring it back in a week", "clock", () => rerender({ remindAt: b.meta.remindAt ? 0 : Date.now() + 7 * DAY })],
      ["Copy the address", "globe", async () => { await navigator.clipboard.writeText(b.url); toast("Address copied"); }],
      ["Move to bin", "trash", () => binIds([b.id])],
    ]) }, icon("more"));

  const copy = b.hasText ? h("a", { className: "btn btn-sunken", href: `reader.html?u=${encodeURIComponent(b.norm)}`, target: "_blank" }, icon("reader"), "Saved copy")
    : lc?.wayback ? h("a", { className: "btn btn-sunken", href: lc.wayback, target: "_blank", rel: "noopener" }, icon("reader"), "Wayback copy") : null;

  return h("section", { className: "card detail", "aria-label": "Bookmark details" },
    h("div", { className: "detail-host" }, fav(b.url), h("span", { className: "ellipsis", textContent: b.host }),
      h("button", { className: "icon-btn", type: "button", "aria-label": "Close details", onclick: () => setFocus(b.id) }, icon("close"))),
    h("div", { style: "display: flex; flex-direction: column; gap: 6px" }, title, h("p", { className: "url", textContent: shortUrl(b.url) })),
    h("div", { className: "actions" }, h("a", { className: "btn btn-primary", href: b.url, target: "_blank", rel: "noopener" }, icon("arrow"), "Open page"), copy, more),
    m?.snippet && whereMatched(m, page),
    h("div", {}, h("label", { className: "label", for: "note", textContent: "Your note" }),
      h("textarea", { className: "field", id: "note", rows: 2, value: b.meta.note || "", placeholder: "Why did you save this?", onchange: (e) => update({ note: e.target.value.trim() }) })),
    h("div", {}, h("span", { className: "label", textContent: "Tags" }), tagInput([...(b.meta.tags || [])], (t) => update({ tags: [...t] }))),
    h("dl", { className: "facts" },
      fact("Folder", h("select", { "aria-label": "Folder", onchange: (e) => moveTo([b.id], e.target.value) }, lib.folders.map((f) => new Option(f.path, f.id, false, f.id === b.parentId)))),
      fact("Saved", fmtDate(b.dateAdded)),
      fact("Opened", b.opens?.count ? `${plural(b.opens.count, "time")}, last ${ago(b.opens.last)}` : "Not in Chrome's history"),
      fact("Link check", h("span", { className: lcClass, textContent: lcText })),
      b.copies > 1 && fact("Copies", h("button", { className: "link", type: "button", textContent: `Saved ${b.copies} times`, onclick: () => go("cleanup", { tab: "dupes" }) })),
      b.meta.remindAt > 0 && fact("Reminder", fmtDate(b.meta.remindAt))));
}

function whereMatched(m, page) {
  let quote = m.snippet, where = "From your note";
  if (m.where === "Page text" && page) {
    const lines = page.text.split("\n");
    const i = page.text.slice(0, m.snippet.at).split("\n").length - 1;
    quote = snippet(lines[i] || "", parseQuery(ui.q), 220);
    where = `Paragraph ${i + 1} of ${lines.length} in the copy saved ${fmtDate(page.fetchedAt)}`;
  }
  return h("div", { style: "display: flex; flex-direction: column; gap: 10px" },
    h("p", { className: "brand-text", style: "font-weight: 600", textContent: "Where it matched" }),
    h("div", { className: "hit" }, h("p", {}, quote.before, h("b", { textContent: quote.hit }), quote.after), h("p", { textContent: where })));
}

function popover(anchor, entries) {
  document.querySelector(".popover")?.remove();
  const r = anchor.getBoundingClientRect();
  const pop = h("div", { className: "popover", role: "menu", style: `top: ${r.bottom + scrollY + 6}px; left: ${Math.max(12, r.right + scrollX - 240)}px` },
    entries.map(([label, ic, fn]) => h("button", { type: "button", role: "menuitem", onclick: () => { pop.remove(); fn(); } }, icon(ic), label)));
  document.body.append(pop);
  pop.querySelector("button").focus();
  setTimeout(() => document.addEventListener("click", (e) => { if (!pop.contains(e.target)) pop.remove(); }, { once: true }));
}

/* Library views */

const SORTS = {
  newest: ["Newest first", (a, b) => b.dateAdded - a.dateAdded],
  oldest: ["Oldest first", (a, b) => a.dateAdded - b.dateAdded],
  opened: ["Recently opened", (a, b) => (b.opens?.last || 0) - (a.opens?.last || 0)],
  az: ["Name A to Z", (a, b) => a.title.localeCompare(b.title)],
  site: ["Website", (a, b) => a.host.localeCompare(b.host) || a.title.localeCompare(b.title)],
};

function renderLibrary() {
  const now = Date.now();
  const filters = { folder: (b) => b.folderIds.includes(ui.folder), inbox: (b) => b.inbox, favourites: (b) => b.meta.star, week: (b) => now - b.dateAdded < 7 * DAY };
  const items = lib.bookmarks.filter(filters[ui.view] || (() => true)).sort(SORTS[ui.mode === "timeline" ? "newest" : ui.sort][1]);
  current = { items };
  const f = folderById.get(ui.folder);
  const title = { inbox: "Inbox", favourites: "Favourites", week: "Saved this week", folder: f?.title }[ui.view] || "All bookmarks";
  const sub = {
    inbox: "Saved loose in Other bookmarks, plus reminders that are due. File them, or let them go.",
    favourites: "Links you starred in Rummage.",
    week: "Everything saved in the last 7 days.",
    folder: `${f?.path} · ${plural(items.length, "link")}`,
  }[ui.view] || `${n(lib.bookmarks.length)} saved since ${new Date(counts.oldest).getFullYear()} · ${n(counts.openedYear)} opened this year`;
  const empty = { inbox: "Nothing loose. Every link is filed.", favourites: "No favourites yet. Star a link from its details.", week: "Nothing saved in the last 7 days.", folder: "This folder is empty." }[ui.view] || "No bookmarks yet. Add a link or import a file.";

  const heading = h("div", { className: "heading" },
    h("div", {}, h("h1", { textContent: title }), h("p", { className: "sub", textContent: sub })),
    h("div", { className: "seg", role: "group", "aria-label": "Layout" }, ["list", "cards", "timeline"].map((m) =>
      h("button", { type: "button", "aria-pressed": String(ui.mode === m), textContent: m[0].toUpperCase() + m.slice(1), onclick: () => { ui.mode = m; render(); } }))));

  const list = h("ul", { className: ui.mode === "cards" ? "cards" : "list" });
  const card = h("section", { className: "card list-card" },
    h("div", { className: "list-head" },
      ui.mode !== "cards" && selectAllBox(),
      h("h3", { textContent: plural(items.length, "link") }),
      ui.mode !== "timeline" && h("select", { "aria-label": "Sort", onchange: (e) => { ui.sort = e.target.value; render(); } }, Object.entries(SORTS).map(([k, [label]]) => new Option(label, k, false, k === ui.sort)))),
    list,
    !items.length && h("p", { className: "empty", textContent: empty }));

  mount(heading, h("div", { className: "content" }, ui.view === "all" && gauge(), card));
  const month = (b) => new Date(b.dateAdded).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  renderRows(list, items, ui.mode === "cards" ? cardEl
    : ui.mode === "timeline" ? (b, i) => [(!i || month(items[i - 1]) !== month(b)) && h("li", { className: "group-label", textContent: month(b) }), row(b)]
    : (b) => row(b));
}

// The state of the pile: one bar that splits the whole library by what to do next.
function gauge() {
  const g = counts.gauge;
  const segs = [
    ["kept", "Opened and kept", () => go("all", { sort: "opened" })],
    ["inbox", "In the inbox", () => go("inbox")],
    ["never", "Never opened", () => go("cleanup", { tab: "never" })],
    ["twice", "Saved twice", () => go("cleanup", { tab: "dupes" })],
    ["dead", "Dead", () => go("cleanup", { tab: "dead" })],
  ];
  const first = settings.linkChecks ? `${plural(g.dead + g.twice, "link is", "links are")} dead or saved twice.` : `${plural(g.twice, "link is", "links are")} saved twice. Turn on link checks to find the dead ones.`;
  const near = lib.nodes > SYNC_LIMIT * 0.9;
  return h("section", { className: "card gauge" },
    h("div", { className: "gauge-head" },
      h("div", {}, h("h2", { textContent: "The state of the pile" }),
        h("p", { className: "muted" }, `${first} `, h("span", { className: near ? "danger-text" : "", textContent: `You are at ${n(lib.nodes)} of Chrome's ${n(SYNC_LIMIT)} sync limit.` }))),
      h("button", { className: "btn btn-primary", type: "button", onclick: () => go("cleanup", { tab: g.dead ? "dead" : "dupes" }) }, icon("refresh"), "Start clean-up")),
    h("div", { className: "gauge-bar" }, segs.filter(([k]) => g[k]).map(([k, label, fn]) =>
      h("button", { type: "button", className: k, style: `flex: ${g[k]} 1 0`, onclick: fn, "aria-label": `${n(g[k])} ${label}` }, h("b", { textContent: n(g[k]) }), h("span", { textContent: label })))));
}

/* Search */

function renderSearch() {
  if (settings.pageSearch && (!pages || Date.now() - pagesAt > 60000) && !pagesLoading) loadPages().then(() => ui.q && render());
  const q = parseQuery(ui.q);
  const now = Date.now();
  const since = { any: 0, week: now - 7 * DAY, month: now - 30 * DAY, year: now - 365 * DAY }[ui.time];
  const t0 = performance.now();
  const res = [];
  for (const b of lib.bookmarks) {
    if (b.dateAdded < since || (ui.hideDead && b.state === "dead")) continue;
    const m = matchBookmark(b, q, pages?.get(b.norm), ui.scope);
    if (m) res.push([b, m]);
  }
  const ms = Math.max(1, Math.round(performance.now() - t0));
  const rank = { Title: 0, Note: 1, "Page text": 2 };
  res.sort((a, b) => rank[a[1].where] - rank[b[1].where] || b[0].dateAdded - a[0].dateAdded);
  matches = new Map(res.map(([b, m]) => [b.id, m]));
  current = { items: res.map(([b]) => b) };
  if (ui.focus && !matches.has(ui.focus)) ui.focus = null;

  const count = (w) => res.filter((r) => r[1].where === w).length;
  const sub = h("p", { className: "sub" },
    `${n(count("Page text"))} matched inside the saved page text, ${n(count("Title"))} in titles, ${n(count("Note"))} in your notes. Searched ${plural(lib.bookmarks.length, "bookmark")} in ${ms} ms, offline. `,
    !settings.pageSearch && h("button", { className: "link", type: "button", textContent: "Turn on page search", onclick: () => setCrawl("pageSearch", true) }),
    settings.pageSearch && !pages && "Loading saved page text...");
  const chip = (label, pressed, fn) => h("button", { className: "chip", type: "button", "aria-pressed": String(pressed), textContent: label, onclick: fn });
  const times = { any: "Any time", week: "This week", month: "This month", year: "This year" };
  const order = Object.keys(times);
  const chips = h("div", { className: "chips", role: "group", "aria-label": "Filters" },
    [["all", "Everywhere"], ["text", "Page text"], ["title", "Titles"], ["note", "Notes"]].map(([k, label]) => chip(label, ui.scope === k, () => { ui.scope = k; render(); })),
    chip(times[ui.time], ui.time !== "any", () => { ui.time = order[(order.indexOf(ui.time) + 1) % order.length]; render(); }),
    chip("Hide dead links", ui.hideDead, () => { ui.hideDead = !ui.hideDead; render(); }));

  const list = h("ul", { className: "list" });
  const card = h("section", { className: "card list-card" }, list, !res.length && h("p", { className: "empty", textContent: q.terms.length ? "Nothing matches. Try fewer words, or search Everywhere." : "Type to search." }));
  mount([h("div", { className: "heading" }, h("div", {}, h("h1", { textContent: `${n(res.length)} found` }), sub)), chips], h("div", { className: "content" }, card));
  renderRows(list, res, ([b, m]) => row(b, { match: m, st: { text: m.where } }));
}

/* Clean up */

function cleanupItems(tab) {
  if (tab === "dead") return lib.bookmarks.filter((b) => b.state === "dead" || b.state === "suspect").sort((a, b) => (a.state === "dead" ? 0 : 1) - (b.state === "dead" ? 0 : 1) || (a.link.failedSince || 0) - (b.link.failedSince || 0));
  if (tab === "redirected") return lib.bookmarks.filter((b) => b.state === "redirected");
  if (tab === "never") return lib.bookmarks.filter((b) => b.stale).sort((a, b) => a.dateAdded - b.dateAdded);
  return groups.flat();
}

// Hard failures and redirects start ticked; "suspect" links (login walls, one-off timeouts) never do.
function preselect() {
  selected.clear();
  if (ui.tab === "dead") for (const b of cleanupItems("dead")) if (b.state === "dead") selected.add(b.id);
  if (ui.tab === "redirected") for (const b of cleanupItems("redirected")) selected.add(b.id);
}

const reasonOf = (l) => l.code === 404 || l.code === 410 ? "return 404 or 410" : l.error === "timeout" ? "timed out" : l.code === 0 ? "can't be reached" : l.code === 401 || l.code === 403 ? "sit behind a login" : l.code === 429 ? "turned the check away" : "have server errors";

function renderCleanup() {
  const tabs = [["dead", "Dead links", counts.dead + counts.suspect], ["dupes", "Duplicates", counts.twice], ["redirected", "Redirected", counts.redirected], ["never", "Never opened", counts.never]];
  const heading = h("div", { className: "heading" },
    h("div", {}, h("h1", { textContent: "Clean up" }), h("p", { className: "sub", textContent: `Nothing is deleted until you confirm. Removed links sit in the bin for ${BIN_DAYS} days.` })),
    h("div", { className: "seg", role: "group", "aria-label": "Clean-up lists" }, tabs.map(([k, label, c]) =>
      h("button", { type: "button", "aria-pressed": String(ui.tab === k), onclick: () => go("cleanup", { tab: k }) }, label, h("span", { className: "n", textContent: n(c) })))));

  if (["dead", "redirected"].includes(ui.tab) && !settings.linkChecks) {
    current = { items: [] };
    return mount(heading, h("div", { className: "content" }, offCard()), groups.length ? dupeCard(groups[0], 0) : null);
  }
  if (ui.tab === "dupes") return renderDupes(heading);

  const items = cleanupItems(ui.tab);
  const last = Math.max(0, ...items.map((b) => b.link?.checkedAt || 0));
  const notes = {
    dead: () => `${plural(items.length, "link")} failed a check${last ? `, the latest ${ago(last)}` : ""}. ${n(selected.size)} selected.`,
    redirected: () => `${plural(items.length, "link")} now land somewhere else. ${n(selected.size)} selected.`,
    never: () => `${plural(items.length, "link")} saved over a month ago and not opened since. ${n(selected.size)} selected.`,
  };
  const empty = {
    dead: "No dead links so far. Checks run in the background, a few links at a time.",
    redirected: "No redirects found so far.",
    never: "Nothing here. You open what you save.",
  };
  current = { items, note: notes[ui.tab] };
  const list = h("ul", { className: "list picking" });
  const card = h("section", { className: "card list-card" },
    h("div", { className: "list-head" }, selectAllBox(), h("p", { id: "pick-note", style: "flex: 1; font-weight: 600" })),
    list,
    !items.length && h("p", { className: "empty", textContent: empty[ui.tab] }));

  const opts = {
    dead: (b) => {
      const copy = b.hasText ? "Saved copy" : b.link?.wayback ? "Wayback copy" : "No copy";
      return { pick: true, where: copy, whereBrand: copy !== "No copy", st: { text: linkLabel(b.link), cls: "danger" } };
    },
    redirected: (b) => ({ pick: true, line: `Now at ${shortUrl(b.link.finalUrl)}`, st: { text: host(b.link.finalUrl), cls: "brand" } }),
    never: (b) => ({ pick: true, st: { text: `Saved ${ago(b.dateAdded)}` } }),
  }[ui.tab];

  const side = [h("section", { className: "dark-panel", id: "confirm" })];
  if (ui.tab === "never") side.push(rediscover(items));
  else if (groups.length) side.push(dupeCard(groups[0], 0));
  mount(heading, h("div", { className: "content" }, card), side);
  renderRows(list, items, (b) => row(b, opts(b)));
}

function offCard() {
  return h("section", { className: "card", style: "display: flex; flex-direction: column; gap: 14px; align-items: flex-start; padding: 28px" },
    h("h2", { textContent: "Link checks are off" }),
    h("p", { className: "muted", textContent: "Rummage can visit each saved address in the background, a few at a time, and flag the ones that fail. Healthy links are checked about once a month, failing ones nightly. Nothing is deleted on its own." }),
    h("button", { className: "btn btn-primary", type: "button", onclick: () => setCrawl("linkChecks", true) }, icon("refresh"), "Turn on link checks"));
}

// The one dark panel per screen: what is selected, and the button that acts on it.
function drawConfirm() {
  const panel = $("confirm");
  if (!panel) return;
  const sel = ui.view === "bin" ? current.items.filter((b) => selected.has(b.id)) : [...selected].map((id) => byId.get(id)).filter(Boolean);
  const tally = (fn) => { const m = new Map(); for (const b of sel) { const k = fn(b); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
  const age = (b) => { const y = (Date.now() - b.dateAdded) / (365 * DAY); return y > 5 ? "saved over 5 years ago" : y > 2 ? "saved 2 to 5 years ago" : "saved in the last 2 years"; };
  const s = {
    dead: { reasons: tally((b) => reasonOf(b.link)), text: `${n(sel.filter((b) => b.hasText || b.link?.wayback).length)} of them have a saved copy or a Wayback Machine snapshot. The bin keeps each link for ${BIN_DAYS} days.`, label: `Move ${n(sel.length)} to the bin`, ic: "trash", run: () => binIds(sel.map((b) => b.id)) },
    redirected: { reasons: [], text: "Each address is swapped for the one it lands on now. Titles, folders, tags and notes stay.", label: `Update ${plural(sel.length, "link")}`, ic: "refresh", run: () => fixRedirects(sel) },
    never: { reasons: tally(age), text: "Chrome keeps about 90 days of history, so a link you opened before that can show up here. Check before you bin.", label: `Move ${n(sel.length)} to the bin`, ic: "trash", run: () => binIds(sel.map((b) => b.id)) },
    bin: { reasons: [], text: "Restoring puts each link back in its old folder, with its tags and notes.", label: `Restore ${n(sel.length)}`, ic: "refresh", run: () => restore(sel.map((b) => b.id)) },
  }[ui.view === "bin" ? "bin" : ui.tab];
  if (!s) return;
  panel.replaceChildren(
    h("div", { className: "big" }, h("b", { textContent: n(sel.length) }), h("span", { textContent: "selected" })),
    s.reasons.length > 0 && h("div", { className: "reasons" }, s.reasons.map(([k, c]) => h("div", {}, h("b", { textContent: n(c) }), h("span", { textContent: k })))),
    h("p", { textContent: s.text }),
    h("div", {}, h("button", { className: "btn btn-accent", type: "button", disabled: !sel.length, onclick: s.run }, icon(s.ic), s.label)),
    ui.view === "bin" && current.items.length > 0 && emptyBinButton());
}

function renderDupes(heading) {
  current = { items: [] };
  const list = h("ul", { className: "list" });
  const extra = groups.reduce((s, g) => s + g.length - 1, 0);
  const sameFolder = groups.filter((g) => new Set(g.map((b) => b.parentId)).size < g.length).length;
  const panel = h("section", { className: "dark-panel" },
    h("div", { className: "big" }, h("b", { textContent: n(groups.length) }), h("span", { textContent: groups.length === 1 ? "group" : "groups" })),
    groups.length > 0 && h("div", { className: "reasons" },
      h("div", {}, h("b", { textContent: n(extra) }), h("span", { textContent: extra === 1 ? "extra copy" : "extra copies" })),
      sameFolder > 0 && h("div", {}, h("b", { textContent: n(sameFolder) }), h("span", { textContent: "sit twice in the same folder" }))),
    h("p", { textContent: "Addresses count as the same page when they only differ by tracking tags, www, a trailing slash or a #section. Merging keeps the oldest copy where it is, adds the others' tags and notes to it, and moves the rest to the bin." }),
    h("div", {}, h("button", { className: "btn btn-accent", type: "button", disabled: !groups.length, onclick: () => merge(groups) }, icon("merge"), `Merge all ${n(groups.length)}`)));
  const card = h("section", { className: "card list-card" }, list, !groups.length && h("p", { className: "empty", textContent: "No duplicates. Every page is saved once." }));
  mount(heading, h("div", { className: "content" }, card), [panel, groups.length > 0 && dupeCard(groups[0], 0)]);
  renderRows(list, groups, (g) => [
    h("li", { className: "group-label", textContent: `${shortUrl(g[0].url)} · saved ${g.length === 2 ? "twice" : `${g.length} times`}` }),
    ...g.map((b) => row(b, { where: b.path || "Top level", st: { text: `Added ${fmtDate(b.dateAdded)}` } })),
  ]);
}

function dupeCard(g, i) {
  return h("section", { className: "card dupe-card" },
    h("div", { className: "list-head", style: "padding: 0" }, h("h3", { textContent: `Next up: saved ${g.length === 2 ? "twice" : `${g.length} times`}` }), h("span", { className: "muted small", textContent: `${i + 1} of ${n(groups.length)}` })),
    g.map((b) => h("div", { className: "copy" }, fav(b.url), h("div", {}, h("b", { textContent: shortUrl(b.url) }), h("span", { textContent: `${b.path || "Top level"} · ${new Date(b.dateAdded).getFullYear()}` })))),
    h("div", { className: "actions" }, h("button", { className: "btn btn-primary", type: "button", onclick: () => merge([g]) }, icon("merge"), "Merge into one"), h("span", { className: "muted small", textContent: "Keeps all tags and notes" })));
}

function rediscover(items) {
  const pick = [...items].sort(() => Math.random() - 0.5).slice(0, 3);
  const card = h("section", { className: "card dupe-card" },
    h("div", { className: "list-head", style: "padding: 0" }, h("h3", { textContent: "Rediscover" }), h("button", { className: "link", type: "button", textContent: "Shuffle", onclick: () => card.replaceWith(rediscover(items)) })),
    pick.map((b) => h("a", { className: "copy", href: b.url, target: "_blank", rel: "noopener", style: "text-decoration: none" }, fav(b.url), h("div", {}, h("b", { textContent: b.title }), h("span", { textContent: `${b.host} · saved ${fmtDate(b.dateAdded)}` })))),
    !pick.length && h("p", { className: "muted", textContent: "Nothing old and unopened." }));
  return card;
}

/* Bin */

async function renderBin() {
  const recs = [...(await db.all("bin"))].sort((a, b) => b[1].deletedAt - a[1].deletedAt);
  const items = recs.map(([key, r]) => ({ ...r, id: key, bookmarkId: r.id, host: host(r.url), meta: r.meta || {}, copies: 1 }));
  current = { items, note: () => `${plural(items.length, "link")} in the bin. ${n(selected.size)} selected.` };
  const list = h("ul", { className: "list picking" });
  const heading = h("div", { className: "heading" }, h("div", {}, h("h1", { textContent: "Bin" }), h("p", { className: "sub", textContent: `Removed links stay here for ${BIN_DAYS} days, then go for good.` })));
  const card = h("section", { className: "card list-card" },
    h("div", { className: "list-head" }, selectAllBox(), h("p", { id: "pick-note", style: "flex: 1; font-weight: 600" })),
    list,
    !items.length && h("p", { className: "empty", textContent: "The bin is empty." }));
  mount(heading, h("div", { className: "content" }, card), h("section", { className: "dark-panel", id: "confirm" }));
  renderRows(list, items, (b) => row(b, { pick: true, where: b.path || "Top level", st: { text: `Removed ${ago(b.deletedAt)}` } }));
  updateBulk();
}

function emptyBinButton() {
  const btn = h("button", { className: "quiet-link", type: "button", textContent: "Empty the bin",
    onclick: async () => {
      if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = `Click again to delete ${plural(current.items.length, "link")} for good`; return; }
      for (const b of current.items) await db.del("bin", b.id);
      toast("The bin is empty");
      go("bin");
    } });
  return btn;
}

/* Actions */

async function moveTo(ids, parentId) {
  const prev = ids.map((id) => byId.get(id)).filter(Boolean).map((b) => ({ id: b.id, parentId: b.parentId, index: b.index })).sort((a, b) => a.index - b.index);
  let moved = 0;
  for (const id of ids) {
    try { await chrome.bookmarks.move(id, { parentId }); moved++; } catch (e) { console.warn("move failed", id, e); }
  }
  selected.clear();
  toast(`Moved ${plural(moved, "link")} to ${folderById.get(parentId)?.title}`, async () => {
    for (const p of prev) await chrome.bookmarks.move(p.id, { parentId: p.parentId, index: p.index }).catch(() => {});
  });
}

// Removing always goes through the bin, with an undo in the toast.
async function binIds(ids) {
  const batch = Date.now();
  const recs = ids.map((id) => byId.get(id)).filter(Boolean).map((b) => [`${batch}-${b.id}`,
    { id: b.id, title: b.title, url: b.url, parentId: b.parentId, index: b.index, path: b.path, dateAdded: b.dateAdded, meta: b.meta, deletedAt: batch }]);
  if (!recs.length) return;
  await db.putMany("bin", recs);
  for (const [, r] of recs) {
    await chrome.bookmarks.remove(r.id).catch(() => {});
    await db.del("meta", r.id);
  }
  selected.clear();
  if (ui.focus && ids.includes(ui.focus)) ui.focus = null;
  toast(`Moved ${plural(recs.length, "link")} to the bin`, () => restore(recs.map(([k]) => k)));
}

async function restore(keys) {
  const recs = (await Promise.all(keys.map(async (k) => [k, await db.get("bin", k)]))).filter(([, r]) => r).sort((a, b) => a[1].index - b[1].index);
  for (const [k, r] of recs) {
    const parent = await chrome.bookmarks.get(r.parentId).then(([p]) => p, () => null);
    const node = await chrome.bookmarks.create({ parentId: parent ? r.parentId : lib.defaultParent, index: parent ? r.index : undefined, title: r.title, url: r.url }).catch(() =>
      chrome.bookmarks.create({ parentId: parent ? r.parentId : lib.defaultParent, title: r.title, url: r.url }));
    await setMeta(node.id, { ...r.meta, addedAt: r.dateAdded });
    await db.del("bin", k);
  }
  selected.clear();
  toast(`Restored ${plural(recs.length, "link")}`);
  if (ui.view === "bin") go("bin");
}

async function merge(gs) {
  const drop = [];
  for (const g of gs) {
    const [keep, ...rest] = [...g].sort((a, b) => a.dateAdded - b.dateAdded);
    const tags = [...new Set(g.flatMap((b) => b.meta.tags || []))];
    const note = [...new Set(g.map((b) => b.meta.note).filter(Boolean))].join("\n\n");
    await setMeta(keep.id, { tags, note, star: g.some((b) => b.meta.star) });
    drop.push(...rest.map((b) => b.id));
  }
  await binIds(drop);
}

async function fixRedirects(sel) {
  const prev = sel.map((b) => [b.id, b.url]);
  for (const b of sel) {
    await chrome.bookmarks.update(b.id, { url: b.link.finalUrl }).catch(() => {});
    const page = await db.get("pages", b.norm);
    if (page) await db.put("pages", normUrl(b.link.finalUrl), page);
  }
  selected.clear();
  toast(`Updated ${plural(sel.length, "link")}`, async () => { for (const [id, url] of prev) await chrome.bookmarks.update(id, { url }).catch(() => {}); });
}

async function openGroup(ids) {
  const urls = ids.map((id) => byId.get(id)?.url).filter(Boolean).slice(0, 40);
  const tabIds = [];
  for (const url of urls) tabIds.push((await chrome.tabs.create({ url, active: false })).id);
  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, { title: folderById.get(ui.folder)?.title || "Rummage" });
  toast(ids.length > 40 ? "Opened the first 40 as a tab group" : `Opened ${plural(urls.length, "tab")} as a group`);
}

// Turning on either background job needs access to all sites. The request has to be
// the first thing the click does, or Chrome refuses it.
async function setCrawl(key, on) {
  if (on && !(await chrome.permissions.request(ALL))) return toast("Chrome did not grant access, so this stays off");
  settings = await saveSettings({ [key]: on });
  try { await chrome.runtime.sendMessage("crawl"); } catch {}
  render();
}

/* Settings */

async function renderSettings() {
  current = { items: [] };
  const web = new Set(lib.bookmarks.filter((b) => isWeb(b.url)).map((b) => b.norm)).size;
  const read = new Set(lib.bookmarks.filter((b) => b.hasText).map((b) => b.norm)).size;
  const checked = new Set(lib.bookmarks.filter((b) => b.link).map((b) => b.norm)).size;
  const { lastBackup } = await chrome.storage.local.get("lastBackup");
  const toggle = (key, title, text, status) => h("section", { className: "card" },
    h("div", { className: "setting-row" }, h("div", {}, h("h3", { textContent: title })),
      h("button", { className: "toggle", type: "button", role: "switch", "aria-checked": String(!!settings[key]), "aria-label": title, onclick: () => setCrawl(key, !settings[key]) })),
    h("p", { className: "muted", textContent: text }),
    h("p", { className: "small muted", textContent: status }));

  const matchIn = h("input", { className: "field", placeholder: "github.com or a word", "aria-label": "Address or word to match" });
  const folderIn = h("select", { className: "field", "aria-label": "Folder" }, new Option("Leave in place", ""), lib.folders.map((f) => new Option(f.path, f.id)));
  const tagIn = h("input", { className: "field", placeholder: "Tag (optional)", "aria-label": "Tag to add" });
  const ruleText = (r) => `"${r.match}" goes to ${folderById.get(r.folderId)?.path || "the same place"}${r.tag ? `, tagged ${r.tag}` : ""}`;

  const exportBtn = (label, fmt) => h("button", { className: "btn btn-sunken", type: "button", textContent: label, onclick: () => exportAll(fmt) });
  const keys = [["Alt S", "Save the page you are on"], ["Alt K", "Command bar on any page"], ["rm then a space", "Search from the address bar"], [isMac ? "⌘K" : "Ctrl K", "Command bar in Rummage"], ["/", "Jump to search"], ["↑ ↓ or j k", "Move through the list"], ["x", "Select the current link"], ["Delete", "Move to the bin"]];

  $("view").replaceChildren(
    h("div", { className: "heading" }, h("div", {}, h("h1", { textContent: "Settings" }), h("p", { className: "sub", textContent: "Everything Rummage stores stays in this browser profile." }))),
    h("div", { className: "settings" },
      toggle("pageSearch", "Page search", "Reads each saved page once and keeps its text on this computer, so search finds what a page said, not only its title. Each site sees one normal visit, without your cookies, so pages behind a login are read logged out.", `${n(read)} of ${n(web)} pages read`),
      toggle("linkChecks", "Link checks", "Visits saved addresses a few at a time: healthy links about once a month, failing ones nightly. Dead links get a Wayback Machine lookup. Nothing is deleted on its own.", `${n(checked)} of ${n(web)} checked · ${n(counts.dead)} dead, ${n(counts.suspect)} worth a look`),
      h("section", { className: "card" },
        h("h3", { textContent: "Backups" }),
        h("p", { className: "muted", textContent: "Saves a bookmarks file with your tags and notes to Downloads/Rummage backups. Any browser can import it." }),
        h("div", { className: "setting-row" },
          h("select", { className: "field", style: "flex: 1", "aria-label": "Backup schedule", onchange: async (e) => { settings = await saveSettings({ backup: e.target.value }); } },
            [["off", "Off"], ["daily", "Every day"], ["weekly", "Every week"]].map(([v, l]) => new Option(l, v, false, settings.backup === v))),
          h("button", { className: "btn btn-primary", type: "button", onclick: async () => { const r = await chrome.runtime.sendMessage("backup"); toast(r === true ? "Backup saved to Downloads" : `Backup failed: ${r}`); } }, "Back up now")),
        h("p", { className: "small muted", textContent: lastBackup ? `Last backup ${ago(lastBackup)}` : "No backup yet" })),
      h("section", { className: "card" },
        h("h3", { textContent: "Rules" }),
        h("p", { className: "muted", textContent: "When a new bookmark lands loose in Other bookmarks or the bookmarks bar, the first matching rule files it. A rule matches a site (github.com) or any word in the title or address." }),
        settings.rules.map((r, i) => h("div", { className: "rule" }, h("span", { textContent: ruleText(r) }),
          h("button", { className: "icon-btn", type: "button", "aria-label": `Delete the rule for ${r.match}`, onclick: async () => { settings = await saveSettings({ rules: settings.rules.filter((_, j) => j !== i) }); render(); } }, icon("close")))),
        h("div", { className: "rule-form" }, matchIn, folderIn, tagIn,
          h("button", { className: "btn btn-primary", type: "button", onclick: async () => {
            if (!matchIn.value.trim() || (!folderIn.value && !tagIn.value.trim())) return toast("A rule needs something to match and a folder or tag");
            settings = await saveSettings({ rules: [...settings.rules, { match: matchIn.value.trim(), folderId: folderIn.value, tag: tagIn.value.trim().toLowerCase() }] });
            render();
          } }, icon("plus"), "Add rule"))),
      h("section", { className: "card" },
        h("h3", { textContent: "Export" }),
        h("p", { className: "muted", textContent: "Everything, with folders, tags and notes. HTML imports into any browser and into Raindrop." }),
        h("div", { className: "actions" }, exportBtn("HTML", "html"), exportBtn("JSON", "json"), exportBtn("CSV", "csv"), exportBtn("Markdown", "md"))),
      h("section", { className: "card" },
        h("h3", { textContent: "Import" }),
        h("p", { className: "muted", textContent: "Bookmark HTML files from Firefox, Safari, Edge and Arc, Raindrop and Pocket exports (HTML or CSV), and Rummage JSON. Each import lands in its own folder." }),
        h("div", {}, h("button", { className: "btn btn-primary", type: "button", onclick: () => $("import-file").click() }, icon("import"), "Choose a file"))),
      h("section", { className: "card" },
        h("h3", { textContent: "Shortcuts" }),
        h("dl", { className: "facts" }, keys.map(([k, v]) => fact(v, h("span", { className: "kbd", textContent: k })))),
        h("div", {}, h("button", { className: "btn btn-sunken", type: "button", textContent: "Change shortcuts", onclick: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) })))));
  $("view").append(h("div", { className: "split no-side", id: "split" }, h("div"), h("aside", { className: "side", id: "side" })));
}

/* Import and export */

function cleanNode(node, meta) {
  if (node.url) {
    const m = meta.get(node.id) || {};
    return { title: node.title, url: node.url, dateAdded: node.dateAdded, ...(m.tags?.length && { tags: m.tags }), ...(m.note && { note: m.note }) };
  }
  return { title: node.title, children: (node.children || []).map((c) => cleanNode(c, meta)) };
}

async function exportAll(fmt) {
  const [root] = await chrome.bookmarks.getTree();
  const meta = await db.all("meta");
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `rummage-${stamp}`;
  if (fmt === "html") download(toNetscape(root, meta), `${name}.html`, "text/html");
  if (fmt === "json") download(JSON.stringify({ format: "rummage", exportedAt: new Date().toISOString(), title: "All bookmarks", children: root.children.map((c) => cleanNode(c, meta)) }, null, 2), `${name}.json`);
  if (fmt === "csv") {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["title", "url", "folder", "tags", "note", "added"], ...lib.bookmarks.map((b) => [b.title, b.url, b.path, (b.meta.tags || []).join(", "), b.meta.note, new Date(b.dateAdded).toISOString()])];
    download(rows.map((r) => r.map(q).join(",")).join("\n"), `${name}.csv`, "text/csv");
  }
  if (fmt === "md") {
    const byPath = new Map();
    for (const b of lib.bookmarks) byPath.set(b.path, [...(byPath.get(b.path) || []), b]);
    const md = (s) => s.replace(/([[\]\\])/g, "\\$1");
    const out = [...byPath].map(([path, bs]) => [`## ${path || "Top level"}`, "", ...bs.map((b) => `- [${md(b.title)}](${b.url.replace(/\)/g, "%29")})${b.meta.tags?.length ? " " + b.meta.tags.map((t) => `#${t}`).join(" ") : ""}${b.meta.note ? `\n  ${b.meta.note}` : ""}`), ""].join("\n"));
    download(`# Bookmarks\n\n${out.join("\n")}`, `${name}.md`, "text/markdown");
  }
  toast("Export downloaded");
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Raindrop (title, note, url, folder, tags, created) and Pocket (title, url, time_added, tags).
function fromCsv(text) {
  const [head = [], ...rows] = parseCsv(text);
  const col = (...names) => head.findIndex((x) => names.includes(x.trim().toLowerCase()));
  const [iu, it, ifo, ita, ino, ida] = [col("url", "link", "href"), col("title", "name"), col("folder", "collection"), col("tags"), col("note", "description", "excerpt"), col("created", "time_added", "added", "date")];
  if (iu < 0) throw new Error("No url column");
  const root = { children: [] };
  const folderFor = (path) => {
    let node = root;
    for (const part of path.split("/").map((s) => s.trim()).filter(Boolean)) {
      let f = node.children.find((c) => c.children && c.title === part);
      if (!f) node.children.push((f = { title: part, children: [] }));
      node = f;
    }
    return node;
  };
  for (const r of rows) {
    const url = r[iu]?.trim();
    if (!url) continue;
    const d = r[ida];
    const added = !d ? NaN : /^\d+$/.test(d) ? +d * 1000 : Date.parse(d);
    folderFor(ifo >= 0 ? r[ifo] || "" : "").children.push({
      title: r[it] || url, url,
      tags: ita >= 0 && r[ita] ? r[ita].split(/[|,]/).map((t) => t.trim()).filter(Boolean) : [],
      note: ino >= 0 ? r[ino] : "",
      dateAdded: Number.isFinite(added) ? added : undefined,
    });
  }
  return root.children;
}

// Netscape bookmark HTML, which every browser exports. Pocket's flat list of links works too.
function fromHtml(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const link = (a) => {
    const dd = a.parentElement?.nextElementSibling;
    const added = +a.getAttribute("add_date") || +a.getAttribute("time_added");
    return {
      title: a.textContent.trim(), url: a.getAttribute("href"),
      tags: (a.getAttribute("tags") || "").split(/[,|]/).map((t) => t.trim()).filter(Boolean),
      note: dd?.tagName === "DD" ? dd.textContent.trim() : "",
      dateAdded: added ? added * 1000 : undefined,
    };
  };
  const walk = (dl) => [...dl.querySelectorAll(":scope > dt, :scope > p > dt")].map((dt) => {
    const a = dt.querySelector(":scope > a"), h3 = dt.querySelector(":scope > h3");
    if (a) return link(a);
    if (!h3) return null;
    const sub = dt.querySelector(":scope > dl") || (dt.nextElementSibling?.tagName === "DL" ? dt.nextElementSibling : null);
    return { title: h3.textContent.trim(), children: sub ? walk(sub) : [] };
  }).filter(Boolean);
  const top = doc.querySelector("dl");
  return top ? walk(top) : [...doc.querySelectorAll("a[href]")].map(link);
}

// Skips anything that is not http(s), ftp or file, so javascript: bookmarklets are dropped.
async function importNodes(nodes, parentId) {
  let count = 0;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if (typeof node.url === "string" && /^(https?|ftp|file):/i.test(node.url)) {
      const b = await chrome.bookmarks.create({ parentId, title: String(node.title || node.url), url: node.url });
      const tags = Array.isArray(node.tags) ? node.tags.map(String) : [];
      if (tags.length || node.note || node.dateAdded) await setMeta(b.id, { ...(tags.length && { tags }), ...(node.note && { note: String(node.note) }), ...(node.dateAdded && { addedAt: +node.dateAdded }) });
      count++;
    } else if (Array.isArray(node.children)) {
      const f = await chrome.bookmarks.create({ parentId, title: String(node.title || "Untitled") });
      count += await importNodes(node.children, f.id);
    }
  }
  return count;
}

async function importFile(file) {
  const text = await file.text();
  let nodes;
  try {
    if (/\.csv$/i.test(file.name)) nodes = fromCsv(text);
    else if (/^\s*</.test(text)) nodes = fromHtml(text);
    else {
      const data = JSON.parse(text);
      nodes = Array.isArray(data) ? data : data.children || (data.url ? [data] : []);
    }
  } catch {
    return toast("Rummage could not read that file");
  }
  toast("Importing...");
  const folder = await chrome.bookmarks.create({ parentId: lib.defaultParent, title: `Imported ${fmtDate(Date.now())}` });
  const count = await importNodes(nodes, folder.id);
  if (!count) await chrome.bookmarks.removeTree(folder.id);
  toast(count ? `Imported ${plural(count, "link")} into "${folder.title}"` : "No bookmarks found in that file");
}


/* Overlays */

function openCommand() {
  if ($("overlay")) return;
  if (settings.pageSearch && !pages) loadPages();
  const close = () => $("overlay")?.remove();
  const bar = commandBar({
    lib, pages: () => pages, tabId: null, close,
    openUrl: (url, background) => { chrome.tabs.create({ url, active: !background }); if (!background) close(); },
    goTo: (hash) => { close(); applyHash(hash); },
  });
  const ov = h("div", { className: "overlay", id: "overlay" }, bar);
  ov.onclick = (e) => e.target === ov && close();
  document.body.append(ov);
}

function openAdd() {
  if ($("overlay")) return;
  const ov = h("div", { className: "overlay", id: "overlay" }, h("iframe", { className: "sheet", src: "popup.html?manual=1", title: "Add a link" }));
  ov.onclick = (e) => e.target === ov && ov.remove();
  document.body.append(ov);
}
window.addEventListener("message", (e) => { if (e.origin === location.origin && e.data === "rummage:close") $("overlay")?.remove(); });

/* Toast with undo */

let undoFn;
function toast(msg, undo) {
  $("toast-text").textContent = msg;
  undoFn = undo;
  $("toast-undo").hidden = !undo;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), undo ? 8000 : 3000);
}
$("toast-undo").onclick = async () => {
  $("toast").hidden = true;
  const fn = undoFn;
  undoFn = null;
  await fn?.();
};

/* Routing: #q=..&scope=.., #cleanup, #settings, #bin, #inbox */

function applyHash(hash) {
  const raw = hash.replace(/^#/, "");
  const p = new URLSearchParams(raw);
  if (p.has("q")) {
    Object.assign(ui, { q: p.get("q"), scope: p.get("scope") || "all", focus: null });
    $("search").value = ui.q;
    return render();
  }
  go(["cleanup", "settings", "bin", "inbox"].includes(raw) ? raw : "all");
}

/* Wiring */

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { ui.q = $("search").value.trim(); ui.focus = null; selected.clear(); render(); }, 120);
});
$("search-kbd").onclick = openCommand;
$("menu-btn").onclick = () => document.body.classList.toggle("menu-open");
$("settings-btn").onclick = () => go("settings");
$("add-btn").onclick = openAdd;
$("import-btn").onclick = () => $("import-file").click();
$("import-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) await importFile(file);
};

$("bulk-move").onchange = (e) => { if (e.target.value) moveTo([...selected], e.target.value); e.target.value = ""; };
$("bulk-tag").onkeydown = async (e) => {
  if (e.key !== "Enter" || !e.target.value.trim()) return;
  const tag = e.target.value.trim().toLowerCase();
  e.target.value = "";
  for (const id of selected) { const b = byId.get(id); if (b) await setMeta(id, { tags: [...new Set([...(b.meta.tags || []), tag])] }); }
  toast(`Tagged ${plural(selected.size, "link")} "${tag}"`);
  await load();
  render();
};
$("bulk-group").onclick = () => openGroup([...selected]);
$("bulk-export").onclick = () => {
  const items = [...selected].map((id) => byId.get(id)).filter(Boolean).map((b) => ({ title: b.title, url: b.url, dateAdded: b.dateAdded, folder: b.path, tags: b.meta.tags, note: b.meta.note }));
  download(JSON.stringify(items, null, 2), `rummage-selected-${new Date().toISOString().slice(0, 10)}.json`);
};
$("bulk-bin").onclick = () => binIds([...selected]);
$("bulk-clear").onclick = () => { selected.clear(); refreshBoxes(); };

function moveFocus(d) {
  const rows = [...document.querySelectorAll(".row[data-id]")];
  if (!rows.length) return;
  let i = rows.findIndex((r) => r.dataset.id === ui.focus);
  i = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + d));
  if (rows[i].dataset.id !== ui.focus) setFocus(rows[i].dataset.id);
  rows[i].scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input, textarea, select, [contenteditable='plaintext-only']");
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return openCommand(); }
  if ($("overlay")) { if (e.key === "Escape") $("overlay").remove(); return; }
  if (e.key === "Escape") {
    if (e.target === $("search") && $("search").value) { $("search").value = ""; ui.q = ""; render(); }
    else if (document.querySelector(".popover")) document.querySelector(".popover").remove();
    else if (ui.focus) setFocus(ui.focus);
    else if (selected.size) { selected.clear(); refreshBoxes(); }
    return;
  }
  if (typing) return;
  const listView = ui.q || !["cleanup", "bin", "settings"].includes(ui.view);
  if (e.key === "/") { e.preventDefault(); $("search").focus(); }
  else if (listView && (e.key === "ArrowDown" || e.key === "j")) { e.preventDefault(); moveFocus(1); }
  else if (listView && (e.key === "ArrowUp" || e.key === "k")) { e.preventDefault(); moveFocus(-1); }
  else if (e.key === "Enter" && ui.focus && byId.has(ui.focus)) chrome.tabs.create({ url: byId.get(ui.focus).url });
  else if (e.key === "x" && ui.focus) toggleSelect(ui.focus);
  else if ((e.key === "Delete" || e.key === "Backspace") && listView && (selected.size || ui.focus)) binIds(selected.size ? [...selected] : [ui.focus]);
});

for (const ev of ["onCreated", "onRemoved", "onChanged", "onMoved", "onImportEnded"]) chrome.bookmarks[ev].addListener(scheduleLoad);
chrome.storage.onChanged.addListener((c) => { if (c.settings) settings = { ...settings, ...c.settings.newValue }; });
setInterval(() => { $("sync-note").textContent = `Both ways, updated ${sinceText(loadedAt)}`; }, 30000);

(async () => {
  await load();
  $("search-kbd").textContent = isMac ? "⌘K" : "Ctrl K";
  $("bulk-move").replaceChildren(new Option("Move to folder", ""), ...lib.folders.map((f) => new Option(f.path, f.id)));
  if (location.hash) {
    const hash = location.hash;
    history.replaceState(null, "", location.href.split("#")[0]);
    applyHash(hash);
  } else render();
})();
