// Toolbar popup (Alt+S): save the current page, or say where it is already saved.
// With ?manual=1 it is the "Add link" sheet inside the manager, with the address typed in.
import { db, DAY, loadLibrary, normUrl, shortUrl, isWeb, setMeta, guessFolder, fmtDate, ago, plural, n, wordCount } from "./lib.js";
import { h, icon, fav, tagInput, captureText } from "./ui.js";

const manual = new URLSearchParams(location.search).has("manual");
const pop = document.getElementById("pop");
const close = () => (manual ? parent.postMessage("rummage:close", location.origin) : window.close());
const openPage = (hash = "") => { chrome.tabs.create({ url: chrome.runtime.getURL(`page.html${hash}`) }); close(); };

document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

function head(title) {
  return h("div", { className: "pop-head" },
    h("img", { className: "mark", src: "icons/brand-mark.svg", alt: "" }),
    h("span", { textContent: title }),
    h("button", { className: "icon-btn", type: "button", title: "Settings", "aria-label": "Open settings", onclick: () => openPage("#settings") }, icon("sliders")));
}

const fact = (k, v) => h("div", {}, h("dt", { textContent: k }), h("dd", { textContent: v }));

async function main() {
  const lib = await loadLibrary();
  const [tab] = manual ? [] : await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  if (!manual && !isWeb(url)) {
    pop.replaceChildren(head("Rummage"),
      h("p", { className: "muted", textContent: "This page can't be bookmarked from here. Open a web page and press Alt+S, or search your bookmarks." }),
      h("div", { className: "pop-foot" }, h("span"), h("button", { className: "btn btn-primary", type: "button", onclick: () => openPage() }, icon("library"), "Open Rummage")));
    return;
  }

  const saved = !manual && lib.byNorm.get(normUrl(url));
  if (saved) return already(saved[0], url, lib);
  save(lib, tab);
}

// Already saved, maybe under a slightly different address.
function already(b, url, lib) {
  const same = b.url === url;
  pop.replaceChildren(
    head("Already in your pile"),
    h("div", { className: "pop-page" }, fav(b.url), h("div", {}, h("h3", { textContent: b.title }), h("p", { className: "muted small", textContent: shortUrl(url) }))),
    h("div", { className: "notice" }, icon("duplicate"), h("p", { textContent: `You saved this page on ${fmtDate(b.dateAdded)}.${same ? "" : " The address only differs by a tracking tag or its ending, so Rummage treats it as the same page."}` })),
    h("dl", { className: "facts" },
      fact("Folder", b.path || "Top level"),
      (b.meta.tags || []).length > 0 && fact("Tags", b.meta.tags.join(", ")),
      fact("Opened", b.opens?.count ? `${plural(b.opens.count, "time")}, last ${ago(b.opens.last)}` : "Not in Chrome's history"),
      b.meta.note && fact("Your note", b.meta.note)),
    h("div", { className: "pop-foot" },
      h("button", { className: "link", type: "button", textContent: "Save a second copy", onclick: () => save(lib, null, true) }),
      b.hasText
        ? h("button", { className: "btn btn-primary", type: "button", onclick: () => { chrome.tabs.create({ url: `reader.html?u=${encodeURIComponent(b.norm)}` }); close(); } }, icon("arrow"), "Open saved copy")
        : h("button", { className: "btn btn-primary", type: "button", onclick: () => openPage(`#q=${encodeURIComponent(b.url)}`) }, icon("arrow"), "Show in Rummage")));
}

async function save(lib, tabArg, second) {
  const [tab] = tabArg ? [tabArg] : manual ? [] : await chrome.tabs.query({ active: true, currentWindow: true });
  let url = tab?.url || "", title = tab?.title || "";
  const tags = [];

  // Text is read while the popup is open, so a later "Save" stores exactly what you saw.
  const textP = tab ? captureText(tab.id) : Promise.resolve("");
  const textNote = h("p", { className: "pop-note" }, icon("reader"), h("span", { textContent: "Reading the page text..." }));
  (async () => {
    const words = wordCount(await textP);
    textNote.lastChild.textContent = words > 20 ? `Page text saved: ${n(words)} words, searchable offline` : "This page's text can't be read, so only its title and address are saved";
  })();

  const folderSel = h("select", { className: "field", id: "folder", "aria-label": "Folder" }, lib.folders.map((f) => new Option(f.path, f.id)));
  const why = h("p", { className: "muted small" });
  const setGuess = async () => {
    if (!isWeb(url)) return;
    const g = await guessFolder(lib, url);
    folderSel.value = g.id;
    why.textContent = g.why;
  };
  folderSel.onchange = () => (why.textContent = "");

  const note = h("textarea", { className: "field", id: "note", rows: 3, placeholder: "One line is enough" });
  const remind = h("button", { className: "toggle", type: "button", role: "switch", "aria-checked": "false", "aria-label": "Bring it back in a week", onclick: () => remind.setAttribute("aria-checked", String(remind.getAttribute("aria-checked") !== "true")) });
  const inWeek = new Date(Date.now() + 7 * DAY).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  const urlIn = manual && h("input", { className: "field", type: "url", placeholder: "https://", "aria-label": "Address", required: true, onchange: (e) => { url = e.target.value.trim(); setGuess(); } });
  const titleIn = manual && h("input", { className: "field", placeholder: "Title (optional)", "aria-label": "Title" });
  const saveBtn = h("button", { className: "btn btn-primary", type: "submit" }, icon("ribbon"), "Save");

  const form = h("form", { className: "pop", style: "padding: 0" },
    manual
      ? h("div", { style: "display: flex; flex-direction: column; gap: 8px" }, h("label", { className: "label", textContent: "Address" }), urlIn, titleIn)
      : h("div", { className: "pop-page" }, fav(url), h("div", {}, h("h3", { textContent: title }), h("p", { className: "muted small", textContent: shortUrl(url) }))),
    !manual && textNote,
    h("div", {}, h("label", { className: "label", for: "folder", textContent: "Folder" }),
      h("div", { className: "select-wrap" }, icon("folder"), folderSel, icon("chevron")), h("div", { style: "margin-top: 8px" }, why)),
    h("div", {}, h("span", { className: "label", textContent: "Tags" }), tagInput(tags, () => {})),
    h("div", {}, h("label", { className: "label", for: "note", textContent: "Why are you saving it?" }), note),
    h("div", { className: "setting-row" }, h("div", {}, h("p", { style: "font-weight: 500", textContent: "Bring it back in a week" }), h("p", { className: "muted small", textContent: `Shows up in Inbox on ${inWeek}` })), remind),
    h("div", { className: "pop-foot" }, h("p", { className: "muted small", textContent: "Also added to Chrome bookmarks" }), saveBtn));

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (manual) {
      url = urlIn.value.trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      title = titleIn.value.trim() || shortUrl(url);
    }
    if (!isWeb(url)) return urlIn?.focus();
    saveBtn.disabled = true;
    const text = await textP;
    await chrome.storage.session.set({ saving: url }); // tells the rules in the service worker to leave this one alone
    const node = await chrome.bookmarks.create({ parentId: folderSel.value, title, url });
    await setMeta(node.id, { tags, note: note.value.trim(), remindAt: remind.getAttribute("aria-checked") === "true" ? Date.now() + 7 * DAY : 0 });
    await chrome.storage.local.set({ lastFolder: folderSel.value });
    if (wordCount(text) > 20) await db.put("pages", normUrl(url), { text, words: wordCount(text), title, fetchedAt: Date.now(), via: "save" });
    saveBtn.replaceChildren(icon("check"), second ? "Saved again" : "Saved");
    setTimeout(close, 600);
  };

  pop.replaceChildren(head(manual ? "Add a link" : "Save this page"), form);
  await setGuess();
  (urlIn || note).focus();
}

main();
