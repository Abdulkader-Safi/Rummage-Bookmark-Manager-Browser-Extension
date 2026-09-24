// Shows the page text Rummage kept, so a link still reads after the site is gone.
import { db, fmtDate, n } from "./lib.js";
import { h } from "./ui.js";

const key = new URLSearchParams(location.search).get("u") || "";

(async () => {
  const page = await db.get("pages", key);
  const root = document.getElementById("reader");
  if (!page) {
    root.replaceChildren(h("h1", { textContent: "No saved copy" }), h("p", { className: "sub", textContent: "Rummage has not kept the text of this page." }));
    return;
  }
  document.title = page.title || key;
  root.replaceChildren(
    h("header", {},
      h("h1", { style: "font-size: 36px", textContent: page.title || key }),
      h("a", { className: "muted", href: `https://${key}`, textContent: key }),
      h("p", { className: "muted small", textContent: `Text saved ${fmtDate(page.fetchedAt)}, ${n(page.words)} words. Images and layout are not kept.` })),
    h("article", {}, page.text.split("\n").map((p) => h("p", { textContent: p }))));
})();
