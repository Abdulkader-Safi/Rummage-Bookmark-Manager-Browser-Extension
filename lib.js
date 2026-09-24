// Shared by the manager page, the popup, the command bar and the service worker.
// No DOM use here, because background.js imports it too.

export const DAY = 24 * 60 * 60 * 1000;
export const SYNC_LIMIT = 100000; // Chrome stops syncing past this many nodes, folders included
export const BIN_DAYS = 30;

export function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Shows a URL without the scheme, the way the design writes them.
export function shortUrl(url) {
  return url.replace(/^[a-z]+:\/\/(www\.)?/i, "").replace(/\/$/, "");
}

const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|si|ref|ref_src|ref_url|_hsenc|_hsmi|yclid|spm|__s)$/i;

// Two bookmarks are the same page when this matches: scheme, www, tracking
// parameters, trailing slash and the #fragment are ignored. SPA routes (#/ and #!) are kept.
export function normUrl(url) {
  let u;
  try { u = new URL(url); } catch { return url.trim().toLowerCase(); }
  if (!/^https?:$/.test(u.protocol)) return url;
  const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const search = params.length ? "?" + new URLSearchParams(params) : "";
  const hash = /^#[/!]/.test(u.hash) ? u.hash : "";
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.port ? ":" + u.port : ""}${path}${search}${hash}`;
}

export const isWeb = (url) => /^https?:/i.test(url);

/* IndexedDB: meta (by bookmark id), pages and links and opens (by normUrl), bin (by key) */

let dbp;
function open() {
  return (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("rummage", 1);
    r.onupgradeneeded = () => { for (const s of ["meta", "pages", "links", "opens", "bin"]) r.result.createObjectStore(s); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

async function run(store, mode, fn) {
  const t = (await open()).transaction(store, mode);
  const out = fn(t.objectStore(store));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  get: (s, k) => run(s, "readonly", (o) => o.get(k)),
  put: (s, k, v) => run(s, "readwrite", (o) => o.put(v, k)),
  del: (s, k) => run(s, "readwrite", (o) => o.delete(k)),
  keys: (s) => run(s, "readonly", (o) => o.getAllKeys()),
  async all(s) {
    let keys, vals;
    await run(s, "readonly", (o) => {
      const k = o.getAllKeys(), v = o.getAll();
      k.onsuccess = () => (keys = k.result);
      v.onsuccess = () => (vals = v.result);
    });
    return new Map(keys.map((k, i) => [k, vals[i]]));
  },
  async putMany(s, entries) {
    await run(s, "readwrite", (o) => { for (const [k, v] of entries) o.put(v, k); });
  },
};

export async function setMeta(id, patch) {
  const m = { ...((await db.get("meta", id)) || {}), ...patch };
  await db.put("meta", id, m);
  return m;
}

// A rule is a domain ("github.com") or any other word matched against title and address.
export function matchesRule(rule, node) {
  const p = (rule.match || "").trim().toLowerCase();
  if (!p) return false;
  if (/^[\w-]+(\.[\w-]+)+$/.test(p)) { const h = host(node.url); return h === p || h.endsWith("." + p); }
  return `${node.title} ${node.url}`.toLowerCase().includes(p);
}

export const getSettings = async () => ({
  pageSearch: false, linkChecks: false, backup: "weekly", rules: [],
  ...(await chrome.storage.local.get("settings")).settings,
});
export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: s });
  return s;
}

// Where a new save should go: a matching rule, else the folder most links from
// this site already sit in, else where the last save went.
export async function guessFolder(lib, url) {
  const byId = new Map(lib.folders.map((f) => [f.id, f]));
  const rule = (await getSettings()).rules.find((r) => matchesRule(r, { url, title: "" }));
  if (rule?.folderId && byId.has(rule.folderId)) return { id: rule.folderId, why: `Your rule for "${rule.match}"` };
  const h = host(url), tally = new Map();
  for (const b of lib.bookmarks) if (b.host === h) tally.set(b.parentId, (tally.get(b.parentId) || 0) + 1);
  const [best, count] = [...tally].sort((a, b) => b[1] - a[1])[0] || [];
  if (best && byId.has(best)) return { id: best, why: `You filed ${plural(count, `${h} link`)} here` };
  const { lastFolder } = await chrome.storage.local.get("lastFolder");
  if (lastFolder && byId.has(lastFolder)) return { id: lastFolder, why: "Where your last save went" };
  return { id: lib.defaultParent, why: "" };
}

/* Library: the native tree flattened, with Rummage's own data attached */

export async function loadLibrary() {
  const [root] = await chrome.bookmarks.getTree();
  const bookmarks = [], folders = [];
  const roots = root.children.map((c) => c.id);
  (function walk(node, depth, path, folderIds) {
    let count = 0;
    for (const c of node.children || []) {
      if (c.url) {
        bookmarks.push({ id: c.id, parentId: c.parentId, index: c.index, title: c.title || shortUrl(c.url), url: c.url, host: host(c.url), norm: normUrl(c.url), dateAdded: c.dateAdded || 0, path: path.join(" / "), folderIds });
        count++;
      } else {
        const f = { id: c.id, parentId: c.parentId, title: c.title || "Untitled", path: [...path, c.title].join(" / "), depth, count: 0, hasKids: (c.children || []).some((k) => !k.url) };
        folders.push(f);
        f.count = walk(c, depth + 1, [...path, f.title], [...folderIds, c.id]);
        count += f.count;
      }
    }
    return count;
  })(root, 0, [], []);

  const [meta, links, opens, pageKeys] = await Promise.all([db.all("meta"), db.all("links"), db.all("opens"), db.keys("pages")]);
  const saved = new Set(pageKeys);
  const byNorm = new Map();
  for (const b of bookmarks) {
    b.meta = meta.get(b.id) || {};
    if (b.meta.addedAt) b.dateAdded = b.meta.addedAt;
    b.link = links.get(b.norm);
    b.state = linkState(b.link, b.norm);
    b.opens = opens.get(b.norm);
    b.hasText = saved.has(b.norm);
    if (!byNorm.has(b.norm)) byNorm.set(b.norm, []);
    byNorm.get(b.norm).push(b);
  }
  for (const b of bookmarks) b.copies = byNorm.get(b.norm).length;
  return { bookmarks, folders, roots, byNorm, defaultParent: roots[1] || roots[0], nodes: bookmarks.length + folders.length };
}

// Inbox: saved loose in "Other bookmarks" or "Mobile bookmarks" (never filed), or a reminder that is due.
export const inInbox = (b, lib) => (b.parentId !== lib.roots[0] && lib.roots.includes(b.parentId)) || (b.meta.remindAt && b.meta.remindAt <= Date.now());

/* Link health */

export function linkState(l, norm) {
  if (!l) return "unchecked";
  if (l.code === 404 || l.code === 410) return "dead";
  if (l.code === 0 || l.code >= 500) return l.fails >= 3 ? "dead" : "suspect";
  if ([401, 403, 429, 451].includes(l.code)) return "suspect";
  if (l.finalUrl && normUrl(l.finalUrl) !== norm) return "redirected";
  return "ok";
}

export function linkLabel(l) {
  if (!l) return "Not checked yet";
  const since = l.failedSince ? ` since ${fmtDate(l.failedSince, false)}` : "";
  if (l.code === 404) return `404${since}`;
  if (l.code === 410) return "410 Gone";
  if (l.error === "timeout") return l.fails > 1 ? `Timed out ${l.fails} times` : "Timed out";
  if (l.code === 0) return l.fails > 1 ? `Can't connect, ${l.fails} tries` : "Can't connect";
  if (l.code === 401 || l.code === 403) return "Login wall";
  if (l.code === 429) return "Rate limited";
  if (l.code >= 500) return `Server error ${l.code}`;
  return `${l.code} OK`;
}

/* Dates */

const startOfDay = (t) => new Date(t).setHours(0, 0, 0, 0);
export function ago(t) {
  const d = Math.round((startOfDay(Date.now()) - startOfDay(t)) / DAY);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  if (d < 14) return "last week";
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `on ${fmtDate(t)}`;
}
export function fmtDate(t, year = true) {
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year && { year: "numeric" }) });
}
export const n = (x) => x.toLocaleString("en-US");

// The right-hand status on a row: last open, a fresh save, or never opened.
export function activity(b) {
  if (b.opens?.count) return `Opened ${ago(b.opens.last)}`;
  if (Date.now() - b.dateAdded < 7 * DAY) return `Saved ${ago(b.dateAdded)}`;
  return "Never opened";
}
export const plural = (x, one, many = one + "s") => `${n(x)} ${x === 1 ? one : many}`;

/* Search */

// "site:github.com tag:css some words" -> filters plus free text
export function parseQuery(q) {
  const out = { text: "", terms: [], site: "", tag: "" };
  const rest = [];
  for (const part of q.trim().split(/\s+/)) {
    const m = part.match(/^(site|tag):(.+)$/i);
    if (m) out[m[1].toLowerCase()] = m[2].toLowerCase();
    else if (part) rest.push(part);
  }
  out.text = rest.join(" ").toLowerCase();
  out.terms = rest.map((t) => t.toLowerCase());
  return out;
}

// Every term appears in at least one of the haystacks.
const hasAll = (terms, ...hays) => terms.every((t) => hays.some((h) => h && h.includes(t)));

// Where the query matched, and a quoted sentence around it.
// scope: "all" | "text" | "title" | "note"; page is { text, low } from the pages store, or undefined.
export function matchBookmark(b, q, page, scope = "all") {
  if (q.site && !b.host.includes(q.site)) return null;
  if (q.tag && !(b.meta.tags || []).some((t) => t.toLowerCase() === q.tag)) return null;
  if (!q.terms.length) return { where: "Title" };
  const head = (b.head ??= `${b.title} ${shortUrl(b.url)} ${b.path} ${(b.meta.tags || []).join(" ")}`.toLowerCase());
  if ((scope === "all" || scope === "title") && hasAll(q.terms, head)) return { where: "Title" };
  const note = b.meta.note || "";
  const noteLow = note.toLowerCase();
  if ((scope === "all" || scope === "note") && note && hasAll(q.terms, head, noteLow) && q.terms.some((t) => noteLow.includes(t))) {
    return { where: "Note", snippet: snippet(note, q, 90, noteLow), prefix: "Your note: " };
  }
  if ((scope === "all" || scope === "text") && page?.text && hasAll(q.terms, head, page.low)) {
    return { where: "Page text", snippet: snippet(page.text, q, 90, page.low) };
  }
  return null;
}

// Cuts about 90 characters either side of the first hit, on word boundaries.
export function snippet(source, q, pad = 90, low = source.toLowerCase()) {
  let at = low.indexOf(q.text), len = q.text.length;
  if (at < 0) {
    const t = q.terms.find((x) => low.includes(x)) || "";
    at = low.indexOf(t);
    len = t.length;
  }
  if (at < 0) return { before: source.slice(0, pad * 2), hit: "", after: "" };
  let s = Math.max(0, at - pad), e = Math.min(source.length, at + len + pad);
  if (s > 0) s = source.indexOf(" ", s) + 1 || s;
  const sp = source.lastIndexOf(" ", e);
  if (e < source.length && sp > at + len) e = sp;
  return {
    before: (s > 0 ? "... " : "") + source.slice(s, at).replace(/\n/g, " "),
    hit: source.slice(at, at + len),
    after: source.slice(at + len, e).replace(/\n/g, " ") + (e < source.length ? " ..." : ""),
    at,
  };
}

/* Page text, without a DOM (the service worker has none) */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-", hellip: "...", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m);

// ponytail: regex extraction, not Readability; good enough for search, swap in an offscreen DOMParser if snippets read badly
export function htmlToText(html) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim());
  let body = html.replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form|aside|button|select)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const main = body.match(/<(article|main)\b[\s\S]*<\/\1>/i)?.[0];
  if (main && main.length > 1500) body = main;
  const paras = body
    .split(/<\/?(?:p|div|li|h[1-6]|br|tr|td|section|article|blockquote|pre|dd|dt|figcaption)\b[^>]*>/i)
    .map((s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 2);
  return { title, text: paras.join("\n").slice(0, 200000) };
}

export const wordCount = (text) => (text.match(/\S+/g) || []).length;

/* Export formats */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Netscape bookmark file: every browser and Raindrop can import it.
export function toNetscape(node, meta = new Map()) {
  const lines = ["<!DOCTYPE NETSCAPE-Bookmark-file-1>", '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>", "<DL><p>"];
  (function walk(n, pad) {
    for (const c of n.children || []) {
      const added = Math.floor((c.dateAdded || 0) / 1000);
      if (c.url) {
        const m = meta.get(c.id) || {};
        const tags = m.tags?.length ? ` TAGS="${esc(m.tags.join(","))}"` : "";
        lines.push(`${pad}<DT><A HREF="${esc(c.url)}" ADD_DATE="${added}"${tags}>${esc(c.title)}</A>`);
        if (m.note) lines.push(`${pad}<DD>${esc(m.note)}`);
      } else {
        lines.push(`${pad}<DT><H3 ADD_DATE="${added}">${esc(c.title)}</H3>`, `${pad}<DL><p>`);
        walk(c, pad + "    ");
        lines.push(`${pad}</DL><p>`);
      }
    }
  })(node, "    ");
  lines.push("</DL><p>");
  return lines.join("\n");
}
