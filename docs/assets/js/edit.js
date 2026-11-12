// Editor for the unlisted pages in docs/s/, opened with "Edit" on links/.
// Shows the page as it is, lets you change its wording in place and
// download, copy or replace its images, and commits docs/s/<id>/index.html
// with the GitHub token links/ signs in with.
//
// A save rewrites only what you changed. Each piece of text on the page, and
// each editable block, is matched to its place in the file, so a save
// replaces just the changed text, or the content of a block whose markup
// changed too (say, you deleted a bold word), and the rest of the file stays
// byte for byte the same. Only if a block can't be found in the file is the
// whole page written out again from its parsed form: it looks and works the
// same, but its markup gets reformatted.
//
// An image can be replaced if the file holds it as a data: URL, in an <img>,
// a style or a script's table of images. The new image goes in as a data:
// URL everywhere the old one's was, so every copy of it on the page changes.

const REPO = { owner: "kiana-park", repo: "kiana-park.github.io", branch: "main", dir: "docs/s" };
const BASE = `/repos/${REPO.owner}/${REPO.repo}`;
const SITE = "https://kiana-park.github.io";
const TOKEN_KEY = "gh:token";       // shared with links/ and the CV editor
const MARK = "data-kp-edit";        // only in the frame, never saved
const CHANGED = "data-kp-changed";
const POINTED = "data-kp-image";    // the image the image bar is by
const SWAPPED = "data-kp-swapped";  // an image you replaced
const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/;

// Never editable, and the inline elements a block of text may contain
const SKIP = new Set(["audio", "button", "canvas", "iframe", "input", "math", "noscript", "object", "script", "select", "style", "svg", "template", "textarea", "video"]);
const IN_SKIP = [...SKIP].join();
const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "i", "img", "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr"]);
// Their text isn't page text: code, styles, form values and the tab title
const RAW = new Set(["script", "style", "textarea", "title"]);
const NOT_BLANK = /[^ \t\n\f\r]/;   // HTML's whitespace, which doesn't include &nbsp;

const FRAME_CSS = `
  [${MARK}] { cursor: text; -webkit-user-select: text !important; user-select: text !important; }
  [${MARK}]:hover { outline: 1px dashed rgb(46 91 212 / 0.6) !important; outline-offset: 2px; }
  [${MARK}]:focus { outline: 2px solid #2e5bd4 !important; outline-offset: 2px; }
  [${CHANGED}] { background-color: rgb(250 204 21 / 0.3) !important; }
  [${SWAPPED}] { outline: 2px solid rgb(250 204 21) !important; outline-offset: 2px; }
  [${POINTED}] { outline: 1px dashed rgb(46 91 212 / 0.6) !important; outline-offset: 2px; }
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
const tools = document.getElementById("edit-tools");
const sizeText = document.getElementById("edit-size");
const downloadButton = document.getElementById("edit-download");
const copyButton = document.getElementById("edit-copy");
const replaceButton = document.getElementById("edit-replace");
const pasteButton = document.getElementById("edit-paste");
const fileInput = document.getElementById("edit-file");

const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
const HINT = "Click any text to change it, Enter or Esc when you're done. Point at an image to download, copy or replace it.";
const PASTE_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘V" : "Ctrl+V";

let source = "";                    // the file as last committed
let sha = null;
let doc = null;                     // source, parsed
let blocks = [];                    // editable elements of doc; [MARK="n"] in the frame is blocks[n]
let places = null;                  // text node of doc → [start, end] in source; null if unmatched
let ranges = new Map();             // block → [start, end] of its content in source
const changed = new Set();          // n of each block you edited
const swaps = new Map();            // data: URL of each image you replaced → the new image's
const pictures = new Map();         // image URL → the image, decoded
let shown = null;                   // { el, url } of the image the image bar is by
let pointed = null;                 // the element under the pointer
let hideTimer = 0;
let picking = null;                 // URL of the image Replace is picking a file for
let flashTimer = 0;
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
  swaps.clear();
  hideTools();
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
    point(event.target);                                                // a tap shows the image bar
  }, true);
  win.addEventListener("pointermove", (event) => point(event.target), true);
  win.addEventListener("pointerout", (event) => {
    if (!event.relatedTarget && event.pointerType !== "touch") leave();   // out of the frame
  }, true);
  win.addEventListener("scroll", place, true);
  win.addEventListener("input", (event) => {
    const block = editableOf(event.target);
    if (!block) return;
    block.setAttribute(CHANGED, "");
    changed.add(block.getAttribute(MARK));
    update();
  }, true);
  win.addEventListener("paste", pasteImage, true);
  win.addEventListener("paste", (event) => {
    if (!editableOf(event.target)) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain").replace(/\s+/g, " ");
    page.execCommand("insertText", false, text);
  }, true);
  // Nothing can be dropped into the text, and a file dropped anywhere but on
  // an image would open in the frame; dropped on an image, it replaces it
  win.addEventListener("dragover", (event) => {
    const file = event.dataTransfer.types.includes("Files");
    if (!file && !editableOf(event.target)) return;
    event.preventDefault();
    if (file) event.dataTransfer.dropEffect = imageAt(event.target) ? "copy" : "none";
  }, true);
  win.addEventListener("drop", (event) => {
    const [file] = event.dataTransfer.files;
    if (!file && !editableOf(event.target)) return;
    event.preventDefault();
    const url = file && imageAt(event.target);
    if (url) replace(url, file);
  }, true);
});

const editableOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.(`[${MARK}]`);

function onKey(event) {
  if (!event.metaKey && !event.ctrlKey) hideTools();   // but keep it for a paste over the image
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
  for (const el of copy.querySelectorAll(`[${POINTED}], [${SWAPPED}]`)) {
    el.removeAttribute(POINTED);
    el.removeAttribute(SWAPPED);
  }
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

// The file with your changes in it: the text, then the images
function nextSource() {
  let text = withText();
  for (const [from, to] of swaps) text = text.replaceAll(from, () => to);
  return text;
}

function withText() {
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

function summary() {
  const title = `"${titleText.textContent}"`;
  const images = swaps.size > 1 ? swaps.size + " images" : "an image";
  if (!swaps.size) return "Edit the text of " + title;
  return (changed.size ? `Edit the text and replace ${images} in ` : `Replace ${images} in `) + title;
}

async function save() {
  if (saving || !changed.size && !swaps.size) return;
  saving = true;
  update();
  const page = frame.contentDocument;
  try {
    const text = nextSource();
    note = "Nothing to save: the page is as it was.";
    if (text !== source) {
      const res = await gh(`${BASE}/contents/${path}`, {
        method: "PUT",
        body: { message: summary(), content: toBase64(text), branch: REPO.branch, sha },
      });
      const count = blocks.length;
      setSource(text, res.content.sha);
      note = "Saved. The live page updates in a minute or two.";
      // Emptying a block, or a rewrite, can change which elements are
      // blocks; then the frame has to be marked again
      if (blocks.length !== count) show();
    }
    for (const el of page.querySelectorAll(`[${CHANGED}], [${SWAPPED}]`)) {
      el.removeAttribute(CHANGED);
      el.removeAttribute(SWAPPED);
    }
    changed.clear();
    swaps.clear();
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

// The image bar: over the frame, by the image you point at

// The image an element shows, an <img>'s or its own background image,
// unless it's the page's background or part of its controls
function imageAt(node) {
  const el = node?.nodeType === 1 ? node : null;
  const page = el?.ownerDocument;
  if (!el || el === page.documentElement || el === page.body || el.closest(IN_SKIP)) return null;
  return imageOf(el);
}

const imageOf = (el) => el.localName === "img"
  ? el.src || el.currentSrc || null
  : /url\("((?:[^"\\]|\\.)*)"\)/.exec(el.ownerDocument.defaultView.getComputedStyle(el).backgroundImage)?.[1].replace(/\\(.)/g, "$1") ?? null;

// The data: URL in the file behind an image in the frame: its own, or the
// one of the image it replaced. Null if the file doesn't have it.
function embedded(url) {
  const from = [...swaps].find(([, to]) => to === url)?.[0] ?? url;
  return from.startsWith("data:") && source.includes(from) ? from : null;
}

// The image at a URL, loaded and decoded, once per URL
function picture(url) {
  if (!pictures.has(url)) {
    const img = new Image();
    img.src = url;
    pictures.set(url, img.decode().then(() => img));
  }
  return pictures.get(url);
}

function point(target) {
  if (target !== pointed) {
    pointed = target;
    const url = imageAt(target);
    if (url) return showTools(target, url);
  }
  if (shown?.el === target) keep();
  else leave();
}

const keep = () => {
  clearTimeout(hideTimer);
  hideTimer = 0;
};

// A moment to reach the bar before it goes
const leave = () => {
  if (shown && !hideTimer) hideTimer = setTimeout(hideTools, 400);
};

function showTools(el, url) {
  keep();
  shown?.el.removeAttribute(POINTED);
  el.setAttribute(POINTED, "");
  shown = { el, url };
  const stored = embedded(url);
  replaceButton.disabled = pasteButton.disabled = !stored;
  replaceButton.title = stored ? "Pick an image file, or drop one on the image" : "Only images stored in the page itself can be replaced";
  pasteButton.title = stored ? `Replace it with the image you copied, or point at it and press ${PASTE_KEY}` : replaceButton.title;
  sizeText.textContent = "";
  tools.hidden = false;
  place();
  picture(url).then((img) => {
    if (shown?.url !== url || !img.naturalWidth) return;
    sizeText.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
    place();
  }, () => {});
}

function hideTools() {
  keep();
  shown?.el.removeAttribute(POINTED);
  shown = pointed = null;
  tools.hidden = true;
}

// In the image's top right corner, or above or below it if it's too small
function place() {
  if (!shown) return;
  const box = shown.el.getBoundingClientRect();
  const width = frame.clientWidth;
  const height = frame.clientHeight;
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, height);
  const left = Math.max(box.left, 0);
  const right = Math.min(box.right, width);
  if (bottom - top < 1 || right - left < 1) return hideTools();   // hidden, or scrolled out of sight
  const w = tools.offsetWidth;
  const h = tools.offsetHeight;
  const inside = right - left >= w + 16 && bottom - top >= h + 16;
  const x = inside ? right - 8 - w : (left + right - w) / 2;
  let y = inside ? top + 8 : box.top - 6 - h;
  if (!inside && y < 0) y = box.bottom + 6;
  const view = frame.getBoundingClientRect();
  tools.style.left = view.left + Math.max(4, Math.min(x, width - w - 4)) + "px";
  tools.style.top = view.top + Math.max(4, Math.min(y, height - h - 4)) + "px";
}

// A note in place of the status for a few seconds
function flash(text) {
  clearTimeout(flashTimer);
  statusText.textContent = text;
  flashTimer = setTimeout(update, 6000);
}

// Named for its key in a script's table of images, the file it's from, or
// which of the file's images it is
function fileName(el, url, type) {
  if (!url.startsWith("data:")) return decodeURIComponent(new URL(url).pathname.split("/").pop()) || "image";
  const mime = type.split(";")[0];
  const ext = { "image/jpeg": "jpg", "image/svg+xml": "svg" }[mime] ?? mime.split("/")[1] ?? "png";
  const from = embedded(url);
  const n = from ? source.slice(0, source.indexOf(from)).split("data:image/").length : 0;
  return `${el.dataset.img || (n ? "image-" + n : "image")}.${ext}`;
}

async function download({ el, url }) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.statusText);
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName(el, url, blob.type);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  } catch (error) {
    flash("Couldn't download the image (" + error.message + ").");
  }
}

// As a PNG, the one type every clipboard takes. Safari wants the item made
// in the click itself, with the image still to come.
function copy({ url }) {
  const png = picture(url).then((img) => new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("it has no size"))), "image/png");
  }));
  navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(() => {
    copyButton.textContent = "Copied";
    setTimeout(() => (copyButton.textContent = "Copy"), 1500);
  }, (error) => flash("Couldn't copy the image (" + error.message + ")."));
}

async function replace(url, file) {
  const from = embedded(url);
  if (!from) return flash("Only images stored in the page itself can be replaced.");
  if (!IMAGE_TYPES.test(file.type)) return flash("That isn't an image file. Pick a PNG, JPEG, GIF, WebP, AVIF or SVG.");
  const to = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  const [before, after] = await Promise.all([picture(url).catch(() => null), to && picture(to).catch(() => null)]);
  if (!after) return flash("Couldn't open that image.");

  if (to === from) swaps.delete(from);
  else swaps.set(from, to);
  const spots = swapShown(url, to);
  for (const el of spots) el.toggleAttribute(SWAPPED, to !== from);
  hideTools();
  update();

  const size = (img) => `${img.naturalWidth}×${img.naturalHeight}`;
  const ratio = (img) => img.naturalWidth / img.naturalHeight;
  const reshaped = before && ratio(before) && ratio(after) && Math.abs(ratio(after) / ratio(before) - 1) > 0.02;
  flash(`Replaced${spots.length > 1 ? ` in ${spots.length} places` : ""}.` +
    (reshaped ? ` It's ${size(after)} and the old one ${size(before)}, so it may look stretched or cut off.` : ""));
}

// ⌘V or Ctrl+V, with the image bar up and an image copied, replaces that image
function pasteImage(event) {
  const file = [...event.clipboardData.files].find((f) => IMAGE_TYPES.test(f.type));
  if (!shown || !file) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  replace(shown.url, file);
}

// The Paste button reads the clipboard itself, which the browser may ask you to allow
async function pasteFromClipboard({ url }) {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => IMAGE_TYPES.test(t));
      if (type) return replace(url, await item.getType(type));
    }
    flash("There's no image on the clipboard to paste.");
  } catch {
    flash(`Couldn't read the clipboard. Point at the image and press ${PASTE_KEY} instead.`);
  }
}

// Shows the new image in the frame wherever the old one was: in <img>s,
// style attributes and the page's style sheets. Returns where it is now.
function swapShown(from, to) {
  const page = frame.contentDocument;
  const swapIn = (style) => {
    if (style?.backgroundImage?.includes(from)) style.backgroundImage = style.backgroundImage.replaceAll(from, () => to);
  };
  const walk = (rules) => {
    for (const rule of rules) {
      swapIn(rule.style);
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const img of page.images) if (imageOf(img) === from) img.src = to;
  for (const el of page.querySelectorAll("[style]")) swapIn(el.style);
  for (const sheet of page.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {}                        // another site's style sheet can't be read
  }
  return [...page.querySelectorAll("*")].filter((el) => imageAt(el) === to);
}

function update() {
  const count = changed.size + swaps.size;
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
tools.addEventListener("pointerenter", keep);
tools.addEventListener("pointerleave", (event) => { if (event.pointerType !== "touch") leave(); });
downloadButton.addEventListener("click", () => shown && download(shown));
copyButton.addEventListener("click", () => shown && copy(shown));
copyButton.hidden = !window.ClipboardItem;
replaceButton.addEventListener("click", () => {
  picking = shown?.url;
  fileInput.click();
});
fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  fileInput.value = "";
  if (file && picking) replace(picking, file);
});
pasteButton.addEventListener("click", () => shown && pasteFromClipboard(shown));
pasteButton.hidden = !navigator.clipboard?.read;
addEventListener("paste", pasteImage);
addEventListener("resize", hideTools);
addEventListener("beforeunload", (event) => {
  if (!changed.size && !swaps.size) return;
  event.preventDefault();
  event.returnValue = "";             // older Safari
});

load();
