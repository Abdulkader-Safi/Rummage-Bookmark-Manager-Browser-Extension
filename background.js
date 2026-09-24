// page.html replaces chrome://bookmarks (see manifest), so open it by that address.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "chrome://bookmarks" });
});
