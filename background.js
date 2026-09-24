import { db, normUrl, isWeb, host, shortUrl, htmlToText, wordCount, getSettings, toNetscape, loadLibrary, parseQuery, matchBookmark, matchesRule, DAY, BIN_DAYS } from "./lib.js";

const ALL = { origins: ["<all_urls>"] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureAlarms() {
  if (!(await chrome.alarms.get("crawl"))) chrome.alarms.create("crawl", { periodInMinutes: 1 });
  if (!(await chrome.alarms.get("hourly"))) chrome.alarms.create("hourly", { periodInMinutes: 60 });
}
ensureAlarms();

chrome.runtime.onInstalled.addListener(async () => {
  // Also on update: reloading an unpacked copy counts as one, and older installs had no opens yet.
  if (!(await db.keys("opens")).length) await seedOpens();
});

chrome.alarms.onAlarm.addListener((a) => (a.name === "crawl" ? crawl() : hourly()));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === "crawl") crawl();
  if (msg !== "backup") return false;
  (async () => {
    try { await backup(); reply(true); } catch (e) { reply(String(e)); }
  })();
  return true; // keeps the channel open for the async reply
});

chrome.storage.onChanged.addListener((c) => { if (c.settings) crawl(); });

/* Bookmark URLs, cached until the tree changes */

// A memo only: rebuilt whenever the worker restarts or the tree changes.
let urlCache;
async function buildUrls() {
  const [root] = await chrome.bookmarks.getTree();
  const m = new Map();
  (function walk(node) { for (const c of node.children || []) c.url ? m.set(normUrl(c.url), c.url) : walk(c); })(root);
  return m;
}
const bookmarkUrls = () => (urlCache ??= buildUrls());
for (const e of ["onRemoved", "onChanged", "onMoved", "onImportEnded"]) chrome.bookmarks[e].addListener(() => { urlCache = null; libCache = null; });

/* Opens: seeded from history on install, then counted as visits happen */

async function seedOpens() {
  const urls = await bookmarkUrls();
  // ponytail: Chrome keeps about 90 days of history, so older opens are unknown at install
  const items = await chrome.history.search({ text: "", startTime: 0, maxResults: 100000 });
  const acc = new Map();
  for (const h of items) {
    const k = normUrl(h.url);
    if (!urls.has(k)) continue;
    const a = acc.get(k) || { count: 0, last: 0 };
    acc.set(k, { count: a.count + (h.visitCount || 0), last: Math.max(a.last, h.lastVisitTime || 0) });
  }
  await db.putMany("opens", acc);
}

chrome.history.onVisited.addListener(async (h) => {
  const k = normUrl(h.url);
  if (!(await bookmarkUrls()).has(k)) return;
  const o = (await db.get("opens", k)) || { count: 0 };
  await db.put("opens", k, { count: o.count + 1, last: h.lastVisitTime || Date.now() });
});

/* Rules: file new saves that land loose in a root folder */

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  urlCache = null;
  libCache = null;
  if (!node.url) return;
  const { saving } = await chrome.storage.session.get("saving");
  const roots = (await chrome.bookmarks.getChildren("0")).map((r) => r.id);
  if (saving !== node.url && roots.includes(node.parentId)) {
    const rule = (await getSettings()).rules.find((r) => matchesRule(r, node));
    if (rule?.folderId) await chrome.bookmarks.move(id, { parentId: rule.folderId }).catch(() => {});
    if (rule?.tag) {
      const m = (await db.get("meta", id)) || {};
      await db.put("meta", id, { ...m, tags: [...new Set([...(m.tags || []), rule.tag])] });
    }
  }
  crawl();
});

/* Crawl: reads page text and checks links in small, polite batches */

// The lock lives in session storage, so a restarted worker sees it too.
// It expires on its own in case a worker dies mid-run.
async function crawl() {
  const { crawlUntil = 0 } = await chrome.storage.session.get("crawlUntil");
  if (crawlUntil > Date.now()) return;
  const s = await getSettings();
  if (!(s.pageSearch || s.linkChecks) || !(await chrome.permissions.contains(ALL))) return;
  await chrome.storage.session.set({ crawlUntil: Date.now() + 5 * 60 * 1000 });
  try {
    const [urls, pages, links] = await Promise.all([bookmarkUrls(), db.keys("pages"), db.all("links")]);
    const haveText = new Set(pages);
    const now = Date.now();
    const byHost = new Map();
    for (const [k, url] of urls) {
      if (!isWeb(url)) continue;
      const l = links.get(k);
      const healthy = l && l.code >= 200 && l.code < 400;
      const needText = s.pageSearch && !haveText.has(k) && !l?.noText && (!l || healthy);
      // healthy links are rechecked monthly, failing ones nightly
      const due = s.linkChecks && (!l || now - l.checkedAt > (healthy ? 30 : 1) * DAY - 3600e3);
      if (!needText && !due) continue;
      const h = host(url);
      if (!byHost.has(h)) byHost.set(h, []);
      byHost.get(h).push({ k, url, needText, prev: l, linkChecks: s.linkChecks });
    }
    // Round-robin across sites, so no single site gets a burst of requests.
    const queues = [...byHost.values()];
    const todo = [];
    for (let i = 0; todo.length < 100000 && queues.some((q) => q.length > i); i++) for (const q of queues) if (q[i]) todo.push(q[i]);

    const stop = Date.now() + 4 * 60 * 1000; // a service worker event may run 5 minutes at most
    const lastHit = new Map();
    let next = 0;
    const worker = async () => {
      while (next < todo.length && Date.now() < stop) {
        const job = todo[next++];
        const h = host(job.url);
        const slot = Math.max(Date.now(), (lastHit.get(h) || 0) + 2000);
        lastHit.set(h, slot);
        await sleep(slot - Date.now());
        await visit(job);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  } finally {
    await chrome.storage.session.set({ crawlUntil: 0 });
  }
}

async function visit(job) {
  const rec = { checkedAt: Date.now() };
  let res;
  const opts = { credentials: "omit", redirect: "follow", signal: AbortSignal.timeout(20000) };
  try {
    res = await fetch(job.url, { ...opts, method: job.needText ? "GET" : "HEAD" });
    if (!job.needText && [403, 405, 501].includes(res.status)) res = await fetch(job.url, { ...opts, signal: AbortSignal.timeout(20000) });
    rec.code = res.status;
    rec.finalUrl = res.url;
  } catch (e) {
    rec.code = 0;
    rec.error = e.name === "TimeoutError" ? "timeout" : "network";
  }

  const p = job.prev;
  const bad = rec.code === 0 || rec.code >= 400;
  if (bad) {
    const sameDay = p?.checkedAt && new Date(p.checkedAt).toDateString() === new Date().toDateString();
    rec.fails = p?.fails ? p.fails + (sameDay ? 0 : 1) : 1;
    rec.failedSince = p?.failedSince || rec.checkedAt;
    rec.wayback = p?.wayback ?? (job.linkChecks ? await wayback(job.url) : undefined);
  }

  let words = 0;
  if (job.needText && res?.ok && /html|text\/plain/.test(res.headers.get("content-type") || "")) {
    const { title, text } = htmlToText(await res.text());
    words = wordCount(text);
    if (words > 20) await db.put("pages", job.k, { text, words, title, fetchedAt: Date.now(), via: "fetch" });
    else rec.noText = true;
  } else {
    res?.body?.cancel().catch(() => {});
    if (job.needText && res?.ok) rec.noText = true;
  }
  await db.put("links", job.k, { noText: p?.noText, ...rec });

  // A storage write per page keeps the worker awake through a long run.
  await chrome.storage.local.set({ lastCrawl: Date.now() });
}

async function wayback(url) {
  try {
    const r = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { credentials: "omit", signal: AbortSignal.timeout(15000) });
    return (await r.json()).archived_snapshots?.closest?.url || "";
  } catch {
    return undefined;
  }
}

/* Hourly: scheduled backups and emptying the bin */

async function hourly() {
  const s = await getSettings();
  const { lastBackup = 0 } = await chrome.storage.local.get("lastBackup");
  const every = { daily: 1, weekly: 7 }[s.backup];
  if (every && Date.now() - lastBackup > every * DAY - 3600e3) await backup().catch((e) => console.warn("backup failed", e));
  for (const [k, v] of await db.all("bin")) if (Date.now() - v.deletedAt > BIN_DAYS * DAY) await db.del("bin", k);
}

async function backup() {
  const [root] = await chrome.bookmarks.getTree();
  const html = toNetscape(root, await db.all("meta"));
  const stamp = new Date().toISOString().slice(0, 10);
  // ponytail: data URL, since service workers have no Blob URLs; move to an offscreen document if very large trees fail
  await chrome.downloads.download({ url: "data:text/html;charset=utf-8," + encodeURIComponent(html), filename: `Rummage backups/rummage-${stamp}.html`, conflictAction: "overwrite", saveAs: false });
  await chrome.storage.local.set({ lastBackup: Date.now() });
}

/* Address bar: type rm, a space, then the query */

let libCache;
const xml = (s) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

chrome.omnibox.setDefaultSuggestion({ description: "Search Rummage for %s" });
chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  libCache ??= loadLibrary();
  const q = parseQuery(text);
  const hits = [];
  for (const b of (await libCache).bookmarks) {
    if (matchBookmark(b, q)) hits.push(b);
    if (hits.length === 6) break;
  }
  suggest(hits.map((b) => ({ content: b.url, description: `${xml(b.title)} <dim>${xml(shortUrl(b.url))}</dim>` })));
});
chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  const url = /^(https?|ftp|file):/i.test(text) ? text : `chrome://bookmarks/#q=${encodeURIComponent(text)}`;
  if (disposition === "currentTab") chrome.tabs.update({ url });
  else chrome.tabs.create({ url, active: disposition === "newForegroundTab" });
});

/* Toolbar button: the full-page manager, which replaces chrome://bookmarks */

chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({ url: "chrome://bookmarks" });
});

/* Keyboard: Alt+S saves the page in a popup, Alt+K opens the command bar over it */

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === "save-page") {
    // The button itself opens the manager, so the save popup is attached only for this press.
    await chrome.action.setPopup({ popup: "popup.html" });
    try { await chrome.action.openPopup(); } finally { await chrome.action.setPopup({ popup: "" }); }
    return;
  }
  if (cmd !== "command-bar") return;
  await chrome.storage.session.set({ cmdTab: tab?.id });
  const w = await chrome.windows.getLastFocused();
  const width = 720, height = 660;
  chrome.windows.create({ url: "command.html", type: "popup", width, height, left: Math.round(w.left + (w.width - width) / 2), top: w.top + 80, focused: true });
});
