# Chrome Web Store listing: Rummage

Last updated: 24 September 2026. Everything here goes into the Chrome Developer Dashboard. Upload `dist/rummage-0.2.0.zip`.

## Store listing

### Name

Rummage

### Short description (127 of 132 characters, matches manifest.json)

Find and clean up thousands of Chrome bookmarks. Search saved page text, catch dead links and duplicates, all on your computer.

### Detailed description (paste as plain text, the store strips Markdown)

```
Rummage replaces Chrome's bookmark manager with one built for people who have saved thousands of links and can't find any of them.

It works on Chrome's own bookmarks. Nothing to import, no account, and Chrome sync keeps working. Uninstall it and your bookmarks are exactly where they were.

FIND THINGS AGAIN
• Search titles, addresses, folders, tags and your own notes at once
• Turn on page search and Rummage keeps the text of every saved page, so you can find a link by what it said, not what it was called
• Every result shows where it matched and quotes the sentence
• Press Alt+K on any page for a command bar that searches bookmarks and open tabs together
• Type rm and a space in the address bar to search without opening anything

CLEAN UP THE PILE
• Dead links: Rummage checks your links in the background and lists the ones that fail, with a Wayback Machine copy when there is one
• Duplicates: finds the same page saved twice, even when the addresses differ by tracking tags or a trailing slash, and merges them while keeping every tag and note
• Redirects: updates links that now land somewhere else
• Never opened: lists what you saved and never came back to
• Nothing is deleted until you confirm, and removed links stay in a bin for 30 days

SAVE WITH CONTEXT
• Alt+S saves the page you are on, keeps its text, and suggests a folder based on where you filed that site before
• Add tags, a note on why you saved it, and a reminder to bring it back in a week
• Rules can file new bookmarks by site or keyword

KEEP IT SAFE
• Scheduled backups to your Downloads folder, every day or week
• Export to HTML, JSON, CSV or Markdown
• Import from other browsers' bookmark files, Raindrop and Pocket

PRIVACY
Everything Rummage stores stays on your computer. There is no server, no account and no analytics. Page search and link checks are off until you turn them on, and Chrome asks for your permission first. Rummage reads your browsing history only to count how often you opened each bookmark.

HOW TO START
1. Click the Rummage icon in the toolbar, or go to chrome://bookmarks.
2. Open Settings and turn on page search and link checks if you want them.
3. Press Start clean-up on the home page.

Developed by Abdulkader Safi (abdulkadersafi.com). Support the work at ko-fi.com/abdulkadersafi.
```

### Category

Productivity

### Single purpose

Search and clean up the browser's bookmarks in one full-page manager.

### Language

English

## Graphics

| Asset | Size | Status | File |
|---|---|---|---|
| Store icon | 128×128 PNG | Ready | `icons/rummage-128.png` |
| Screenshot 1 | 1280×800 | Not created | Library with the pile gauge |
| Screenshot 2 | 1280×800 | Not created | Search matching page text, with the detail panel open |
| Screenshot 3 | 1280×800 | Not created | Clean up, dead links tab with the dark confirm panel |
| Screenshot 4 | 1280×800 | Not created | Alt+S save popup over a web page |
| Small promo tile | 440×280 | Not created | Crop of `assets/Cover.png` |
| Marquee | 1400×560 | Not created | Crop of `assets/Cover.png` |

Take screenshots from a real library with test bookmarks, at a browser window of 1280×800. Use made-up or public links only, and no personal titles.

## Permissions justification

Paste each line into the matching field in the dashboard.

| Permission | Justification |
|---|---|
| `bookmarks` | Rummage is a bookmark manager. It reads the bookmark tree to list and search it, and edits or removes bookmarks when the user asks. |
| `favicon` | Shows each bookmark's site icon next to it in lists, using Chrome's own icon cache instead of contacting the sites. |
| `storage` | Keeps the user's settings and filing rules. |
| `unlimitedStorage` | With page search on, Rummage stores the text of each bookmarked page on the user's computer so search can match it. Large libraries exceed the default quota. |
| `history` | Counts how often and how recently each bookmark was opened, for the "Never opened" clean-up list and the "Opened 3 days ago" labels. Visits to pages that are not bookmarked are ignored and nothing leaves the device. |
| `alarms` | Runs link checks and page reading in small batches in the background, runs scheduled backups, and empties the 30-day bin. |
| `tabs` | The command bar lists the user's open tabs that match a search so they can switch to one, and needs tab titles and addresses to do it. Also opens bookmarks in new tabs. |
| `tabGroups` | "Open as tab group" opens a set of selected bookmarks together as one named tab group. |
| `scripting` | When the user saves a page with the save popup, Rummage reads that page's visible text once so it can be searched later. Only on the page the user is saving. |
| `activeTab` | Grants the save popup and the Alt+K command bar access to the current tab only when the user presses the shortcut or clicks. |
| `downloads` | Saves scheduled backups of the bookmarks to the user's Downloads folder. |
| `<all_urls>` (optional host permission) | Off by default and requested only when the user turns on page search or link checks. Rummage then visits the user's own bookmarked addresses to read their text or check they still load, and asks archive.org for a saved copy of links that fail. It never reads or changes the pages the user is browsing. |

### Remote code

No. All code is in the package. The pages load font files and their CSS from Google Fonts, and no scripts.

## Privacy and data use

### Data collection form

Rummage sends no user data to its developer or any third party, because there is no server. It does handle two kinds of data on the device, so declare them to match the privacy policy:

| Data type | Handled | Leaves the device | Purpose |
|---|---|---|---|
| Web history | Yes | No | Counts opens of bookmarked pages |
| Website content | Yes | No | Saved page text for search |
| Everything else | No | No | |

Tick all three certifications: data is not sold, not used for anything unrelated to bookmarks, and not used for credit or lending.

### Privacy policy URL

https://github.com/Abdulkader-Safi/Rummage-Bookmark-Manager-Browser-Extension/blob/main/PRIVACY.md

Open it in a private window before submitting to confirm it loads.

## Distribution

Visibility: public. Regions: all.

## Developer info

- Publisher: Abdulkader Safi
- Contact email: safi.abdulkader@gmail.com (shown publicly, change it if you prefer a support address)
- Homepage: https://github.com/Abdulkader-Safi/Rummage-Bookmark-Manager-Browser-Extension
- Support: https://github.com/Abdulkader-Safi/Rummage-Bookmark-Manager-Browser-Extension/issues

## Version history

| Version | Date | Changes | Status |
|---|---|---|---|
| 0.2.0 | 24 Sep 2026 | First store release: library, page text search, clean-up, bin, save popup, command bar, rules, backups, import, export | Draft |

## Review notes

### Things a reviewer may ask about

- `<all_urls>` is optional and only requested from the Settings switches, with an explanation next to each switch. Point to this if a reviewer flags broad host access.
- The extension replaces `chrome://bookmarks`. That is its single purpose, so it fits the override policy.

### Known limits

- "Never opened" relies on Chrome's history, which covers about 90 days before install.
- Pages behind a login are read logged out.
- Only tested in Chrome.

### Rejection history

None yet.
