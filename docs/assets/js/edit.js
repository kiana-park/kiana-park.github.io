// Text editor for the unlisted pages in docs/s/, opened with "Edit" on links/.
// Shows the page as it is, lets you change its wording in place, and commits
// docs/s/<id>/index.html with the GitHub token links/ signs in with.
//
// A save rewrites only what you changed. Each piece of text on the page, and
// each editable block, is matched to its place in the file, so a save
// replaces just the changed text, or the content of a block whose markup
// changed too (say, you deleted a bold word), and the rest of the file stays
// byte for byte the same. Only if a block can't be found in the file is the
// whole page written out again from its parsed form: it looks and works the
// same, but its markup gets reformatted.

const REPO = { owner: "kiana-park", repo: "kiana-park.github.io", branch: "main", dir: "docs/s" };
const BASE = `/repos/${REPO.owner}/${REPO.repo}`;
const SITE = "https://kiana-park.github.io";
const TOKEN_KEY = "gh:token";       // shared with links/ and the CV editor
const MARK = "data-kp-edit";        // only in the frame, never saved
const CHANGED = "data-kp-changed";

// Never editable, and the inline elements a block of text may contain
const SKIP = new Set(["audio", "button", "canvas", "iframe", "input", "math", "noscript", "object", "script", "select", "style", "svg", "template", "textarea", "video"]);
const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "i", "img", "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr"]);
// Their text isn't page text: code, styles, form values and the tab title
const RAW = new Set(["script", "style", "textarea", "title"]);
const NOT_BLANK = /[^ \t\n\f\r]/;   // HTML's whitespace, which doesn't include &nbsp;

const FRAME_CSS = `
  [${MARK}] { cursor: text; -webkit-user-select: text !important; user-select: text !important; }
  [${MARK}]:hover { outline: 1px dashed rgb(46 91 212 / 0.6) !important; outline-offset: 2px; }
  [${MARK}]:focus { outline: 2px solid #2e5bd4 !important; outline-offset: 2px; }
  [${CHANGED}] { background-color: rgb(250 204 21 / 0.3) !important; }
`;

const id = new URLSearchParams(location.search).get("id") || "";
const path = `${REPO.dir}/${id}/index.html`;
const frame = document.getElementById("edit-frame");
const titleText = document.getElementById("edit-title");
const statusText = document.getElementById("edit-status");
const message = document.getElementById("edit-message");
const actions = document.getElementById("edit-actions");
const openLink = document.getElementById("edit-open");
const discardButton = document.getElementById("edit-discard");
const saveButton = document.getElementById("edit-save");

const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
const HINT = "Click any text to change it. Enter or Esc when you're done.";

let source = "";                    // the file as last committed
let sha = null;
let doc = null;                     // source, parsed
let blocks = [];                    // editable elements of doc; [MARK="n"] in the frame is blocks[n]
let places = null;                  // text node of doc → [start, end] in source; null if unmatched
let ranges = new Map();             // block → [start, end] of its content in source
const changed = new Set();          // n of each block you edited
let saving = false;
let note = HINT;

async function gh(path, { accept = "application/vnd.github+json", method = "GET", body } = {}) {
  const res = await fetch("https://api.github.com" + path, {
    method,
    cache: "no-store",
    headers: { Authorization: "Bearer " + token, Accept: accept },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const error = new Error(data.message || res.statusText);
    error.status = res.status;
    throw error;
  }
  return accept.endsWith(".raw") ? res.text() : res.json();
}

// In slices: a deck with images is too long to spread into one call
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const escapeText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");

// The file's tags and the runs of text between them, with their offsets.
// Comments and the doctype are neither, and what's inside script, style,
// textarea and title isn't page text.
function tokenize(html) {
  const runs = [];
  const tags = [];
  const tag = /<(\/?)([a-zA-Z][^\t\n\f\r />]*)(?:[^>"']|"[^"]*"|'[^']*')*>/y;
  let start = 0;
  let i = 0;
  while ((i = html.indexOf("<", i)) !== -1) {
    let next;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      next = end < 0 ? html.length : end + 3;
    } else if (/^<(?:[!?]|\/[^a-zA-Z])/.test(html.slice(i, i + 3))) {
      const end = html.indexOf(">", i);   // doctype, <?…>, </ followed by no name
      next = end < 0 ? html.length : end + 1;
    } else {
      tag.lastIndex = i;
      const m = tag.exec(html);
      if (!m) {                           // a "<" that starts no tag is text
        i++;
        continue;
      }
      next = tag.lastIndex;
      tags.push({ name: m[2].toLowerCase(), close: Boolean(m[1]), start: i, end: next });
      if (!m[1] && RAW.has(m[2].toLowerCase())) {
        const close = new RegExp(`</${m[2]}[\\t\\n\\f\\r />]`, "ig");
        close.lastIndex = next;
        next = close.exec(html)?.index ?? html.length;
      }
    }
    if (i > start) runs.push([start, i]);
    start = i = next;
  }
  if (html.length > start) runs.push([start, html.length]);
  return { runs, tags };
}

const pageTexts = (root) => {
  const nodes = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
};

// Pairs the parsed page's text nodes with the file's text runs, in order.
// Returns null when they don't line up (the parser moved or merged text).
function matchTexts(parsed, html, textRuns) {
  const nodes = pageTexts(parsed.documentElement).filter((node) => !RAW.has(node.parentNode.localName) && NOT_BLANK.test(node.data));
  const decoder = parsed.createElement("div");
  const runs = [];
  for (const [start, end] of textRuns) {
    decoder.innerHTML = html.slice(start, end);   // only text and character references
    const text = decoder.textContent;
    if (NOT_BLANK.test(text)) runs.push([start, end, text]);
  }
  if (runs.length !== nodes.length) return null;

  const map = new Map();
  for (const [k, node] of nodes.entries()) {
    let [start, end, text] = runs[k];
    // The parser drops a newline right after <pre> and <listing>
    if (text !== node.data && text === "\n" + node.data) start += html[start] === "\r" ? 2 : 1;
    else if (text !== node.data) return null;
    map.set(node, [start, end]);
  }
  return map;
}

// Each block's content as a range in the file: from the end of its start tag
// to the start of its end tag (or of the tag that closed it). The file's tags
// are paired with the parsed elements in order, skipping elements the parser
// added, like <tbody>. A range is kept only if parsing it gives back exactly
// the block's content.
function matchBlocks(parsed, html, tags, list) {
  const elements = [parsed.documentElement, ...parsed.documentElement.querySelectorAll("*")];
  const nameOf = (el) => el.localName.toLowerCase();
  const opened = new Map();
  const found = new Map();
  const open = [];
  const close = (el, at) => found.set(el, [opened.get(el), at]);
  let next = 0;
  for (const tag of tags) {
    if (tag.close) {
      const i = open.findLastIndex((el) => nameOf(el) === tag.name);
      if (i >= 0) while (open.length > i) close(open.pop(), tag.start);
      continue;
    }
    while (next < elements.length && nameOf(elements[next]) !== tag.name) next++;
    const el = elements[next++];
    if (!el) break;
    while (open.length && !open.at(-1).contains(el)) close(open.pop(), tag.start);
    open.push(el);
    opened.set(el, tag.end);
  }

  const checked = new Map();
  for (const block of list) {
    const range = found.get(block);
    if (!range) continue;
    const probe = parsed.createElement(block.localName);
    probe.innerHTML = html.slice(...range);
    if (probe.innerHTML === block.innerHTML) checked.set(block, range);
  }
  return checked;
}

// A block is the largest element that holds text and nothing but inline
// elements: a heading, a paragraph, a list item, a table cell, a label
function findBlocks(root) {
  const found = [];
  (function walk(el) {
    for (const child of el.children) {
      if (SKIP.has(child.localName)) continue;
      if (NOT_BLANK.test(child.textContent) && [...child.querySelectorAll("*")].every((e) => INLINE.has(e.localName))) {
        found.push(child);
      } else {
        walk(child);
      }
    }
  })(root);
  return found;
}

function setSource(text, newSha) {
  source = text;
  sha = newSha;
  doc = new DOMParser().parseFromString(text, "text/html");
  blocks = findBlocks(doc.body);
  const { runs, tags } = tokenize(text);
  places = matchTexts(doc, text, runs);
  ranges = matchBlocks(doc, text, tags, blocks);
  const title = doc.title.trim() || `/s/${id}/`;
  titleText.textContent = title;
  document.title = "Edit · " + title;
}

const doctype = () => (doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : "");

// The page in the frame, with its blocks marked and its links and images
// resolving against its real address
function show() {
  blocks.forEach((el, n) => el.setAttribute(MARK, n));
  const base = doc.createElement("base");
  base.href = `${SITE}/s/${id}/`;
  doc.head.prepend(base);
  frame.srcdoc = doctype() + doc.documentElement.outerHTML;
  base.remove();
  blocks.forEach((el) => el.removeAttribute(MARK));
  changed.clear();
  update();
}

frame.addEventListener("load", () => {
  if (!frame.srcdoc) return;
  const page = frame.contentDocument;
  const style = page.createElement("style");
  style.textContent = FRAME_CSS;
  page.head.append(style);
  for (const el of page.querySelectorAll(`[${MARK}]`)) {
    try {
      el.contentEditable = "plaintext-only";
    } catch {
      el.contentEditable = "true";   // browsers without plaintext-only
    }
    el.spellcheck = false;
  }

  // Capture on the frame's window, so these run before the page's own handlers
  const win = frame.contentWindow;
  win.addEventListener("keydown", onKey, true);
  for (const type of ["keyup", "keypress"]) {
    win.addEventListener(type, (event) => { if (editableOf(event.target)) event.stopImmediatePropagation(); }, true);
  }
  win.addEventListener("click", (event) => {
    if (event.target.closest?.("a[href]")) event.preventDefault();       // stay in the editor
    if (editableOf(event.target)) event.stopImmediatePropagation();     // e.g. a deck's click-to-advance
  }, true);
  win.addEventListener("input", (event) => {
    const block = editableOf(event.target);
    if (!block) return;
    block.setAttribute(CHANGED, "");
    changed.add(block.getAttribute(MARK));
    update();
  }, true);
  win.addEventListener("paste", (event) => {
    if (!editableOf(event.target)) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain").replace(/\s+/g, " ");
    page.execCommand("insertText", false, text);
  }, true);
  for (const type of ["dragover", "drop"]) {
    win.addEventListener(type, (event) => { if (editableOf(event.target)) event.preventDefault(); }, true);
  }
});

const editableOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.(`[${MARK}]`);

function onKey(event) {
  if (isSaveKey(event)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    save();
    return;
  }
  const block = editableOf(event.target);
  if (!block) return;
  event.stopImmediatePropagation();   // keep the page's shortcuts (arrows, space) out of the text
  if (event.isComposing || event.keyCode === 229) return;   // Korean and other input methods
  if (event.key === "Enter" || event.key === "Escape") {
    event.preventDefault();
    block.blur();
  }
}

const isSaveKey = (event) => (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";

const sameShape = (a, b) =>
  a.childNodes.length === b.childNodes.length &&
  [...a.childNodes].every((node, i) => {
    const other = b.childNodes[i];
    return node.nodeType === other.nodeType && (node.nodeType !== 1 || (node.localName === other.localName && sameShape(node, other)));
  });

// A block as you left it in the frame, minus what the browser adds as you
// type: a <br> to hold an emptied element open, and &nbsp; for a space next
// to other text (kept if the block had &nbsp; to begin with)
function edited(n) {
  const copy = frame.contentDocument.querySelector(`[${MARK}="${n}"]`).cloneNode(true);
  for (const br of copy.querySelectorAll("br")) if (!br.parentNode.textContent) br.remove();
  if (!blocks[n].textContent.includes("\u00a0")) {
    for (const node of pageTexts(copy)) node.data = node.data.replace(/\u00a0/g, " ");
  }
  copy.normalize();
  return copy;
}

// Edits that swap in each changed piece of text, or null if the block's
// markup changed or a piece isn't in the file
function textEdits(after, block) {
  if (!places || !sameShape(after, block)) return null;
  const now = pageTexts(after);
  const edits = [];
  for (const [k, node] of pageTexts(block).entries()) {
    if (now[k].data === node.data) continue;
    const place = places.get(node);
    if (!place) return null;
    edits.push([...place, escapeText(now[k].data)]);
  }
  return edits;
}

// The file with your changes in it
function nextSource() {
  const edits = [];
  for (const n of changed) {
    const after = edited(n);
    const texts = textEdits(after, blocks[n]);
    if (texts) edits.push(...texts);
    else if (ranges.has(blocks[n])) edits.push([...ranges.get(blocks[n]), after.innerHTML]);
    else return rewrite();
  }
  let text = source;
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + value + text.slice(end);
  return text;
}

// Fallback: the parsed page with the changed blocks' content swapped in
function rewrite() {
  const copy = doc.cloneNode(true);
  const copies = findBlocks(copy.body);
  for (const n of changed) copies[n].innerHTML = edited(n).innerHTML;
  return doctype() + copy.documentElement.outerHTML + "\n";
}

async function save() {
  if (saving || !changed.size) return;
  saving = true;
  update();
  const page = frame.contentDocument;
  try {
    const text = nextSource();
    note = "Nothing to save: the text is as it was.";
    if (text !== source) {
      const res = await gh(`${BASE}/contents/${path}`, {
        method: "PUT",
        body: { message: `Edit the text of "${titleText.textContent}"`, content: toBase64(text), branch: REPO.branch, sha },
      });
      const count = blocks.length;
      setSource(text, res.content.sha);
      note = "Saved. The live page updates in a minute or two.";
      // Emptying a block, or a rewrite, can change which elements are
      // blocks; then the frame has to be marked again
      if (blocks.length !== count) show();
    }
    for (const el of page.querySelectorAll(`[${CHANGED}]`)) el.removeAttribute(CHANGED);
    changed.clear();
  } catch (error) {
    note = error.status === 409
      ? "Not saved: this page changed somewhere else after you opened it. Reload to get that version."
      : error.status === 401
        ? "Not saved: your sign-in has expired. Sign in again on Shared links."
        : "Not saved (" + error.message + ").";
  }
  saving = false;
  update();
}

function update() {
  const count = changed.size;
  statusText.textContent = saving ? "Saving…" : count ? `${count} unsaved change${count > 1 ? "s" : ""}` : note;
  saveButton.disabled = saving || !count;
  discardButton.disabled = saving || !count;
}

function fail(text, signIn) {
  message.textContent = text + " ";
  if (signIn) {
    const link = document.createElement("a");
    link.href = "../";
    link.textContent = "Go to Shared links";
    message.append(link);
  }
  message.hidden = false;
  frame.hidden = true;
  actions.hidden = true;
  titleText.textContent = "Can't edit this page";
  statusText.textContent = "";
}

async function load() {
  if (!token) return fail("Sign in on Shared links to edit your pages.", true);
  if (!/^\w+$/.test(id)) return fail("There's no page to edit here.", true);
  openLink.href = `${SITE}/s/${id}/`;
  try {
    // The blob read gets exactly that version, at any size
    const file = await gh(`${BASE}/contents/${path}?ref=${REPO.branch}`);
    setSource(await gh(`${BASE}/git/blobs/${file.sha}`, { accept: "application/vnd.github.raw" }), file.sha);
    frame.hidden = false;
    show();
  } catch (error) {
    if (error.status === 401) fail("Your sign-in has expired.", true);
    else if (error.status === 404) fail(`There's no page at /s/${id}/.`, true);
    else fail("Couldn't load the page (" + error.message + ").");
  }
}

saveButton.addEventListener("click", save);
discardButton.addEventListener("click", () => {
  if (window.confirm("Discard your unsaved changes?")) {
    note = HINT;
    show();
  }
});
addEventListener("keydown", (event) => {
  if (isSaveKey(event)) {
    event.preventDefault();
    save();
  }
});
addEventListener("beforeunload", (event) => {
  if (!changed.size) return;
  event.preventDefault();
  event.returnValue = "";             // older Safari
});

load();
