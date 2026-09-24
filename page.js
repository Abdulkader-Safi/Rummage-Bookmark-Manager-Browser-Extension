const $ = (id) => document.getElementById(id);
const DAY = 24 * 60 * 60 * 1000;
const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ARROW = '<svg class="arrow" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M6 14 14 6M7 6h7v7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let bookmarks = [];     // { id, title, url, host, dateAdded, path, folderIds }
let folders = [];       // { id, title, path, depth, count }
let defaultParent = ""; // "Other bookmarks", where imports and top-level folders go
let current = null;     // selected folder id, null = all
let filter = "all";
const selected = new Set();

const favicon = (url) => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
const shortDate = (t, opts) => new Date(t).toLocaleDateString(undefined, opts);
const normUrl = (url) => url.replace(/\/$/, "");

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

// Flattens the tree; returns the bookmark count under node.
function walk(node, depth, path, folderIds) {
  let count = 0;
  for (const child of node.children || []) {
    if (child.url) {
      bookmarks.push({ id: child.id, title: child.title || child.url, url: child.url, host: host(child.url), dateAdded: child.dateAdded || 0, path: path.join(" / "), folderIds });
      count++;
    } else {
      const entry = { id: child.id, title: child.title || "Untitled", path: path.join(" / "), depth, count: 0 };
      folders.push(entry);
      entry.count = walk(child, depth + 1, [...path, entry.title], [...folderIds, child.id]);
      count += entry.count;
    }
  }
  return count;
}

async function load() {
  const [root] = await chrome.bookmarks.getTree();
  bookmarks = [];
  folders = [];
  walk(root, 0, [], []);
  defaultParent = (root.children[1] || root.children[0]).id;
  if (current && !folders.some((f) => f.id === current)) current = null;
  const ids = new Set(bookmarks.map((b) => b.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);

  const seen = new Map();
  for (const b of bookmarks) seen.set(normUrl(b.url), (seen.get(normUrl(b.url)) || 0) + 1);
  for (const b of bookmarks) b.dupe = seen.get(normUrl(b.url)) > 1;

  const dupes = bookmarks.filter((b) => b.dupe).length;
  $("dupe-count").textContent = dupes ? `(${dupes})` : "";

  $("move-to").replaceChildren(new Option("Choose folder", ""), ...folders.map((f) => new Option(`${"  ".repeat(f.depth)}${f.title}`, f.id)));
  renderFolders();
  renderList();
}

// Bulk imports fire hundreds of change events; redraw once they settle.
let loadTimer;
const scheduleLoad = () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 150); };

/* Sidebar */

function folderButton(id, title, count, depth) {
  const b = document.createElement("button");
  b.className = "folder";
  b.style.paddingLeft = `${14 + depth * 16}px`;
  b.setAttribute("aria-current", String(current === id));
  b.innerHTML = `${FOLDER_ICON}<span class="name"></span><span class="n">${count}</span>`;
  b.querySelector(".name").textContent = title;
  b.onclick = () => { current = id; renderFolders(); renderList(); };
  if (id) {
    b.ondragover = (e) => { e.preventDefault(); b.classList.add("drop"); };
    b.ondragleave = () => b.classList.remove("drop");
    b.ondrop = (e) => {
      e.preventDefault();
      b.classList.remove("drop");
      const dragged = e.dataTransfer.getData("text/bookmark-id");
      moveTo(selected.has(dragged) ? [...selected] : [dragged], id);
    };
  }
  return b;
}

function renderFolders() {
  $("folders").replaceChildren(
    folderButton(null, "All bookmarks", bookmarks.length, 0),
    ...folders.map((f) => folderButton(f.id, f.title, f.count, f.depth))
  );
}

/* List */

function visible() {
  const query = $("search").value.trim().toLowerCase();
  const now = Date.now();
  const byFilter = {
    all: () => true,
    week: (b) => now - b.dateAdded < 7 * DAY,
    month: (b) => now - b.dateAdded < 30 * DAY,
    older: (b) => now - b.dateAdded > 365 * DAY,
    dupes: (b) => b.dupe,
  }[filter];
  const bySort = {
    newest: (a, b) => b.dateAdded - a.dateAdded,
    oldest: (a, b) => a.dateAdded - b.dateAdded,
    az: (a, b) => a.title.localeCompare(b.title),
    za: (a, b) => b.title.localeCompare(a.title),
    site: (a, b) => a.host.localeCompare(b.host) || a.title.localeCompare(b.title),
  }[$("sort").value];
  const sort = filter === "dupes" ? (a, b) => normUrl(a.url).localeCompare(normUrl(b.url)) || bySort(a, b) : bySort;

  return bookmarks
    .filter((b) => !current || b.folderIds.includes(current))
    .filter(byFilter)
    .filter((b) => !query || `${b.title} ${b.url}`.toLowerCase().includes(query))
    .sort(sort);
}

function row(b) {
  const li = document.createElement("li");
  li.className = "row";
  li.draggable = true;
  li.classList.toggle("is-selected", selected.has(b.id));
  li.innerHTML = `<input type="checkbox" aria-label="Select"><a class="row-link"><span class="fav"><img alt=""></span><span class="text"><div class="title"></div><div class="sub"></div></span><span class="date"></span>${ARROW}</a>`;
  const box = li.querySelector("input");
  box.checked = selected.has(b.id);
  box.onchange = () => { box.checked ? selected.add(b.id) : selected.delete(b.id); li.classList.toggle("is-selected", box.checked); updateBulk(); };
  const a = li.querySelector("a");
  a.href = b.url;
  a.title = b.url;
  a.draggable = false;
  li.ondragstart = (e) => e.dataTransfer.setData("text/bookmark-id", b.id);
  li.querySelector("img").src = favicon(b.url);
  li.querySelector(".title").textContent = b.title;
  li.querySelector(".sub").textContent = b.path ? `${b.host} · ${b.path}` : b.host;
  li.querySelector(".date").textContent = b.dateAdded ? shortDate(b.dateAdded, { day: "numeric", month: "short", year: "numeric" }) : "";
  return li;
}

function renderList() {
  const items = visible();
  const query = $("search").value.trim();
  const folder = current && folders.find((f) => f.id === current);

  $("list-title").textContent = query ? `Results for "${query}"` : folder ? folder.title : "All bookmarks";
  $("crumbs").textContent = folder?.path || "";
  $("list-count").textContent = `${items.length.toLocaleString()} ${items.length === 1 ? "link" : "links"}`;
  $("empty").hidden = items.length > 0;
  for (const c of $("filters").children) c.setAttribute("aria-pressed", String(c.dataset.filter === filter));

  // ponytail: renders every row; add windowing if a library passes ~20k links
  $("list").replaceChildren(...items.map(row));
  updateBulk(items);
}

function updateBulk(items = visible()) {
  $("bulk").hidden = selected.size === 0;
  $("bulk-count").textContent = `${selected.size} selected`;
  const all = $("select-all");
  const inView = items.filter((b) => selected.has(b.id)).length;
  all.checked = items.length > 0 && inView === items.length;
  all.indeterminate = inView > 0 && inView < items.length;
}

/* Actions */

async function moveTo(ids, parentId) {
  let moved = 0;
  for (const id of ids) {
    try { await chrome.bookmarks.move(id, { parentId }); moved++; } catch (e) { console.warn("move failed", id, e); }
  }
  selected.clear();
  toast(`Moved ${moved} ${moved === 1 ? "link" : "links"} to ${folders.find((f) => f.id === parentId)?.title}`);
}

function download(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Keeps only what import needs, so exports round-trip.
function clean(node) {
  if (node.url) return { title: node.title, url: node.url, dateAdded: node.dateAdded };
  return { title: node.title, children: (node.children || []).map(clean) };
}

async function exportCurrent() {
  const [node] = current ? await chrome.bookmarks.getSubTree(current) : await chrome.bookmarks.getTree();
  const stamp = new Date().toISOString().slice(0, 10);
  download({ format: "bookmark-manager", exportedAt: new Date().toISOString(), ...clean(node), title: node.title || "All bookmarks" }, `bookmarks-${stamp}.json`);
  toast("Export downloaded");
}

// Accepts our export, a Chrome getTree dump, or a flat array of { title, url }.
async function importNodes(nodes, parentId) {
  let n = 0;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if (typeof node.url === "string" && /^(https?|ftp|file):/i.test(node.url)) {
      await chrome.bookmarks.create({ parentId, title: String(node.title || node.url), url: node.url });
      n++;
    } else if (Array.isArray(node.children)) {
      const folder = await chrome.bookmarks.create({ parentId, title: String(node.title || "Untitled") });
      n += await importNodes(node.children, folder.id);
    }
  }
  return n;
}

async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("That file is not valid JSON"); }
  const nodes = Array.isArray(data) ? data : data.children || (data.url ? [data] : []);
  const folder = await chrome.bookmarks.create({ parentId: defaultParent, title: `Imported ${new Date().toLocaleDateString()}` });
  const n = await importNodes(nodes, folder.id);
  if (!n) await chrome.bookmarks.removeTree(folder.id);
  toast(n ? `Imported ${n} ${n === 1 ? "link" : "links"} into "${folder.title}"` : "No bookmarks found in that file");
}

/* Wiring */

$("search").addEventListener("input", () => renderList());
$("sort").addEventListener("change", () => renderList());
$("filters").addEventListener("click", (e) => {
  if (!e.target.dataset.filter) return;
  filter = e.target.dataset.filter;
  renderList();
});

$("select-all").addEventListener("change", (e) => {
  for (const b of visible()) e.target.checked ? selected.add(b.id) : selected.delete(b.id);
  renderList();
});
$("bulk-clear").onclick = () => { selected.clear(); renderList(); };
$("move-to").onchange = (e) => { if (e.target.value) moveTo([...selected], e.target.value); };
$("bulk-export").onclick = () => {
  const items = bookmarks.filter((b) => selected.has(b.id)).map(({ title, url, dateAdded, path }) => ({ title, url, dateAdded, folder: path }));
  download(items, `bookmarks-selected-${new Date().toISOString().slice(0, 10)}.json`);
};
$("bulk-delete").onclick = async () => {
  const n = selected.size;
  if (!confirm(`Delete ${n} ${n === 1 ? "bookmark" : "bookmarks"}? This can't be undone.`)) return;
  for (const id of selected) await chrome.bookmarks.remove(id).catch(() => {});
  selected.clear();
  toast(`Deleted ${n} ${n === 1 ? "bookmark" : "bookmarks"}`);
};

$("export-btn").onclick = exportCurrent;
$("import-btn").onclick = () => $("import-file").click();
$("import-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) await importFile(file);
};

$("new-folder").onsubmit = async (e) => {
  e.preventDefault();
  const title = $("new-folder-name").value.trim();
  if (!title) return;
  const folder = await chrome.bookmarks.create({ parentId: current || defaultParent, title });
  $("new-folder-name").value = "";
  current = folder.id;
  toast(`Created "${title}"`);
};

for (const e of ["onCreated", "onRemoved", "onChanged", "onMoved"]) chrome.bookmarks[e].addListener(scheduleLoad);
load();
