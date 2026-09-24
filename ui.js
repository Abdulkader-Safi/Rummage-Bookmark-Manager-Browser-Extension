// DOM helpers for the extension pages. Titles and URLs only ever go in as text.

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (/^(aria-|data-|role$|for$)/.test(k)) el.setAttribute(k, v);
    else if (k === "style") el.style.cssText = v;
    else el[k] = v;
  }
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

export const icon = (name, extra = "") => h("span", { className: `i i-${name}${extra ? " " + extra : ""}`, "aria-hidden": "true" });

export const favicon = (url) => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
export const fav = (url) => h("img", { className: "fav", src: favicon(url), alt: "", loading: "lazy" });

// Chips with a remove button, plus a text box: Enter or a comma adds, Backspace on empty removes.
export function tagInput(tags, onChange) {
  const wrap = h("div", { className: "tag-input" });
  const input = h("input", { placeholder: "Add a tag", "aria-label": "Add a tag" });
  const draw = () => wrap.replaceChildren(
    ...tags.map((t, i) => h("span", { className: "tag" }, t, h("button", { type: "button", "aria-label": `Remove ${t}`, textContent: "×", onclick: () => { tags.splice(i, 1); draw(); onChange(tags); } }))),
    input,
  );
  const add = (refocus) => {
    const t = input.value.trim().replace(/,$/, "").toLowerCase();
    input.value = "";
    if (t && !tags.includes(t)) { tags.push(t); draw(); onChange(tags); }
    if (refocus) input.focus();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(true); }
    else if (e.key === "Backspace" && !input.value && tags.length) { tags.pop(); draw(); onChange(tags); input.focus(); }
  };
  input.onblur = () => input.value.trim() && add(false);
  wrap.onclick = (e) => e.target === wrap && input.focus();
  draw();
  return wrap;
}

export function download(text, name, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const isMac = /Mac/.test(navigator.platform);

// Reads the visible text of a tab at save time. Needs activeTab (popup or keyboard shortcut).
export async function captureText(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const main = document.querySelector("article, main, [role=main]");
        return (main && main.innerText.length > 500 ? main : document.body)?.innerText || "";
      },
    });
    return result.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 200000);
  } catch {
    return ""; // chrome:// pages, the Web Store and PDFs can't be read
  }
}
