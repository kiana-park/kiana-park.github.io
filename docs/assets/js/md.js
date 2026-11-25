// Markdown pages: a shared page (docs/s/<id>/index.html) that keeps its text
// as Markdown in <script type="text/markdown" id="md"> and loads this script
// to show it. Upload (upload.js) makes such a page from a .md file.
//
// Everyone gets the rendered page: contents on the side, copy buttons on code,
// checklists that remember their ticks in this browser. Marked
// (vendor/marked.min.js) does the rendering.
//
// The signed-in owner (the same GitHub token as links/ and the CV editor)
// also gets "Edit", which turns the text into a block editor, Milkdown Crepe,
// loaded from a CDN only then: type "/" for a block, select text for
// formatting, drag blocks by their handle. "Markdown" switches to the source.
// Save commits the page's index.html with the new Markdown and title; the
// page says so with <meta name="editor" content="self">, so links/ sends
// "Edit" here. Opening the page with #edit starts editing straight away.

(() => {
  const REPO = { owner: "kiana-park", repo: "kiana-park.github.io", branch: "main", dir: "docs/s" };
  const TOKEN_KEY = "gh:token";       // shared with links/ and the CV editor
  const CREPE = "7.23.0";
  const CREPE_JS = `https://esm.sh/@milkdown/crepe@${CREPE}`;
  const CREPE_CSS = `https://cdn.jsdelivr.net/npm/@milkdown/crepe@${CREPE}/lib/theme/common/style.css`;
  const SAVED_FOR = 10 * 60 * 1000;   // how long a save stands in for the page GitHub Pages hasn't rebuilt yet
  const MAX_IMAGE = 700 * 1024;

  const source = document.getElementById("md");
  const root = document.getElementById("doc");
  if (!source || !root || !window.marked) return;

  const id = /\/s\/([^/]+)/.exec(location.pathname)?.[1] || "";
  const filePath = `${REPO.dir}/${id}/index.html`;
  const api = `/repos/${REPO.owner}/${REPO.repo}/contents/${filePath}`;
  const checksKey = "md:checks:" + id;
  const savedKey = "md:saved:" + id;
  const ko = /^ko\b/i.test(document.documentElement.lang);
  const t = (korean, english) => (ko ? korean : english);

  // "</script" and "<!--" can't appear as they are inside a script element
  const unescape = (text) => text.replace(/<\\\/script/gi, "</script").replace(/<\\!--/g, "<!--");
  const escape = (text) => text.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  // A single "~" is text ("1~2GB"), not the start of struck-out text as GitHub's
  // Markdown has it: outside code it's written "\~". "~~" still strikes out.
  function plainTildes(text) {
    let fence = "";
    return text.split("\n").map((line) => {
      const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (mark && mark[0] === fence[0] && mark.length >= fence.length && !line.trim().slice(mark.length).trim()) fence = "";
        return line;
      }
      if (mark) {
        fence = mark;
        return line;
      }
      if (/^(?: {4}|\t)/.test(line)) return line;
      return line.split(/((`+)[^`][\s\S]*?\2(?!`))/).map((part, i) => (i % 3 ? (i % 3 === 1 ? part : "") : part.replace(/(?<![~\\])~(?!~)/g, "\\~"))).join("");
    }).join("\n");
  }
  const clean = (text) => plainTildes(text.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "")) + "\n";

  let markdown = clean(unescape(source.textContent));
  let token = readToken();
  let editor = null;        // { crepe, textarea, mode: "blocks" | "source", sha, original, dirty }
  let toastTimer = 0;

  function readToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---- The rendered page ----

  const layout = el("div", "md-layout");
  const toc = el("nav", "md-toc");
  const body = el("article", "md-body md-view");
  toc.setAttribute("aria-label", t("목차", "Contents"));
  layout.append(toc, body);
  root.replaceChildren(layout);

  const titleOf = (text) => {
    const line = /^#[ \t]+(.+)$/m.exec(text)?.[1] || "";
    return line.replace(/[*_`~]|\\(?=[^\w\s])/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+#*\s*$/, "").trim();
  };

  // Shell comments are dimmed: a # at the start of a line or after a space,
  // outside quotes
  function dimComments(code) {
    const lines = code.textContent.split("\n");
    code.replaceChildren();
    lines.forEach((line, n) => {
      let quote = "";
      let at = -1;
      for (let i = 0; i < line.length && at < 0; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) at = i;
      }
      if (at < 0) code.append(line);
      else code.append(line.slice(0, at), el("span", "c", line.slice(at)));
      if (n < lines.length - 1) code.append("\n");
    });
  }

  function readChecks() {
    try {
      return JSON.parse(localStorage.getItem(checksKey)) || {};
    } catch {
      return {};
    }
  }

  function render() {
    body.className = "md-body md-view";
    body.innerHTML = window.marked.parse(markdown, { gfm: true });

    for (const link of body.querySelectorAll("a[href]")) {
      if (/^https?:/i.test(link.getAttribute("href"))) {
        link.target = "_blank";
        link.rel = "noopener";
      }
    }

    for (const table of body.querySelectorAll("table")) {
      const wrap = el("div", "md-table");
      table.replaceWith(wrap);
      wrap.append(table);
    }

    for (const pre of body.querySelectorAll("pre")) {
      const code = pre.querySelector("code");
      if (!code) continue;
      const lang = /language-(\S+)/.exec(code.className)?.[1] || "";
      code.textContent = code.textContent.replace(/\n$/, "");
      const text = code.textContent;
      if (/^(|bash|sh|shell|zsh|console)$/.test(lang)) dimComments(code);
      const wrap = el("div", "md-code");
      const tools = el("div", "md-code__tools");
      const copy = el("button", "md-code__copy", t("복사", "Copy"));
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = t("복사됨", "Copied");
        } catch {
          copy.textContent = t("복사 실패", "Couldn't copy");
        }
        setTimeout(() => { copy.textContent = t("복사", "Copy"); }, 1600);
      });
      if (lang) tools.append(el("span", "md-code__lang", lang));
      tools.append(copy);
      pre.replaceWith(wrap);
      wrap.append(pre, tools);
    }

    // Checklists can be ticked; the ticks stay in this browser
    const checks = readChecks();
    [...body.querySelectorAll('li > input[type="checkbox"], li > p:first-child > input[type="checkbox"]')].forEach((box, n) => {
      const item = box.closest("li");
      const holder = box.parentElement;
      const label = el("label");
      const text = el("span");
      box.remove();
      while (holder.firstChild && !/^(UL|OL)$/.test(holder.firstChild.nodeName)) text.append(holder.firstChild);
      label.append(box, text);
      holder.prepend(label);
      item.classList.add("md-task");
      box.disabled = false;
      if (n in checks) box.checked = checks[n];
      item.classList.toggle("is-done", box.checked);
      box.addEventListener("change", () => {
        item.classList.toggle("is-done", box.checked);
        const next = readChecks();
        next[n] = box.checked;
        try {
          localStorage.setItem(checksKey, JSON.stringify(next));
        } catch {}
      });
    });

    // Headings get an address, and h2/h3 go in the contents
    const used = new Set();
    const entries = [];
    for (const heading of body.querySelectorAll("h1, h2, h3, h4")) {
      const base = heading.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section";
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
      used.add(slug);
      heading.id = slug;
      if (heading.matches("h2, h3")) {
        entries.push({ heading, slug, text: heading.textContent.trim(), sub: heading.matches("h3") });
        const anchor = el("a", "md-anchor", "#");
        anchor.href = "#" + slug;
        anchor.setAttribute("aria-label", t("이 제목의 링크", "Link to this heading"));
        heading.prepend(anchor);
      }
    }
    buildToc(entries);

    const title = titleOf(markdown);
    if (title) document.title = title;
  }

  let spy = null;
  function buildToc(entries) {
    spy?.disconnect();
    const tops = entries.filter((entry) => !entry.sub);
    const shown = tops.length >= 3;
    layout.classList.toggle("has-toc", shown);
    toc.hidden = !shown;
    toc.replaceChildren();
    if (!shown) return;

    const list = el("ol", "md-toc__list");
    const links = new Map();
    let subs = null;
    for (const entry of entries) {
      const item = el("li");
      const link = el("a", null, entry.text);
      link.href = "#" + entry.slug;
      links.set(entry.heading, link);
      item.append(link);
      if (!entry.sub) {
        list.append(item);
        subs = null;
      } else {
        if (!subs) {
          subs = el("ol");
          (list.lastElementChild || list).append(subs);
        }
        subs.append(item);
      }
    }
    // A folding box on narrow screens, a plain list beside the text on wide ones
    const box = el("details");
    const wide = matchMedia("(min-width: 1080px)");
    const fit = () => { box.open = wide.matches; };
    wide.addEventListener("change", fit);
    fit();
    box.append(el("summary", null, t("목차", "Contents")), el("p", "md-toc__label", t("목차", "Contents")), list);
    toc.append(box);
    list.addEventListener("click", (event) => {
      if (event.target.closest("a") && !wide.matches) box.open = false;
    });

    // The current section: the last heading above the upper part of the window
    const mark = () => {
      let current = entries[0].heading;
      for (const { heading } of entries) if (heading.getBoundingClientRect().top < 120) current = heading;
      for (const [heading, link] of links) link.classList.toggle("is-current", heading === current);
    };
    spy = new IntersectionObserver(mark, { rootMargin: "0px 0px -70% 0px", threshold: [0, 1] });
    entries.forEach(({ heading }) => spy.observe(heading));
    mark();
  }

  function toast(text) {
    document.querySelector(".md-toast")?.remove();
    const note = el("div", "md-toast", text);
    note.setAttribute("role", "status");
    document.body.append(note);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => note.remove(), 6000);
  }

  // GitHub Pages takes a minute or two to rebuild after a save. Until then
  // this browser shows what it saved rather than the old page.
  try {
    const saved = JSON.parse(sessionStorage.getItem(savedKey));
    if (saved && saved.markdown !== markdown && Date.now() - saved.time < SAVED_FOR) markdown = saved.markdown;
    else if (saved) sessionStorage.removeItem(savedKey);
  } catch {}

  render();
  if (location.hash.length > 1 && location.hash !== "#edit") {
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }

  // ---- The owner's editor ----

  if (!token || !id) return;

  const bar = el("div", "md-bar");
  const status = el("span", "md-bar__status");
  status.setAttribute("role", "status");
  const button = (label, solid) => {
    const node = el("button", "md-button" + (solid ? " md-button--solid" : ""), label);
    node.type = "button";
    return node;
  };
  const editButton = button(t("편집", "Edit"));
  const sourceButton = button("Markdown");
  const cancelButton = button(t("취소", "Cancel"));
  const saveButton = button(t("저장", "Save"), true);
  sourceButton.setAttribute("aria-pressed", "false");
  sourceButton.title = t("마크다운 원문으로 편집", "Edit the Markdown source");
  saveButton.title = (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+") + "S";
  document.body.append(bar);

  function showBar() {
    status.classList.remove("is-error");
    if (!editor) {
      status.textContent = "";
      bar.replaceChildren(editButton);
    } else {
      bar.replaceChildren(status, sourceButton, cancelButton, saveButton);
      showDirty();
    }
  }

  function showDirty() {
    if (!editor || status.classList.contains("is-error")) return;
    status.textContent = editor.dirty ? t("저장 안 된 변경 있음", "Unsaved changes") : t("편집 중", "Editing");
  }

  function fail(message) {
    status.classList.add("is-error");
    status.textContent = message;
  }

  async function gh(path, { method = "GET", body: data, raw = false } = {}) {
    const res = await fetch("https://api.github.com" + path, {
      method,
      cache: "no-store",
      headers: { Authorization: "Bearer " + token, Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json" },
      body: data && JSON.stringify(data),
    });
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      const error = new Error(info.message || res.statusText);
      error.status = res.status;
      throw error;
    }
    return raw ? res.text() : res.json();
  }

  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  const SCRIPT = /(<script type="text\/markdown" id="md">\n)[\s\S]*?(\n<\/script>)/;
  const markdownIn = (html) => {
    const text = /<script type="text\/markdown" id="md">\n([\s\S]*?)\n<\/script>/.exec(html)?.[1];
    return text == null ? null : clean(unescape(text));
  };

  // The page as it is in the repository: newer than this copy if it was saved
  // a moment ago, missing if the page hasn't been committed yet
  async function latest() {
    try {
      const file = await gh(`${api}?ref=${REPO.branch}`);
      const html = await gh(`${api}?ref=${REPO.branch}`, { raw: true });
      return { sha: file.sha, html, markdown: markdownIn(html) };
    } catch (error) {
      if (error.status === 404) return { sha: null, html: null, markdown: null };
      throw error;
    }
  }

  function loadStyle(href) {
    if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
    return new Promise((resolve) => {
      const link = el("link");
      link.rel = "stylesheet";
      link.href = href;
      link.onload = link.onerror = resolve;
      document.head.append(link);
    });
  }

  const asDataUrl = (file) => new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE) {
      toast(t("이미지가 너무 큽니다(700KB 이하). 줄여서 넣거나 주소로 넣어 주세요.", "That image is over 700 KB. Shrink it or use its address."));
      return reject(new Error("too large"));
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  async function mountBlocks(text) {
    const [{ Crepe }] = await Promise.all([import(CREPE_JS), loadStyle(CREPE_CSS)]);
    const holder = el("div", "md-blocks");
    body.append(holder);
    const F = Crepe.Feature;
    const crepe = new Crepe({
      root: holder,
      defaultValue: text,
      features: { [F.Latex]: false },
      featureConfigs: {
        [F.Placeholder]: { text: t("내용을 입력하세요. ‘/’ 를 누르면 블록을 고를 수 있습니다", "Type here, or press “/” for blocks") },
        [F.ImageBlock]: { onUpload: asDataUrl, inlineOnUpload: asDataUrl, blockOnUpload: asDataUrl },
      },
    });
    await crepe.create();
    crepe.on((listener) => listener.markdownUpdated(() => {
      if (!editor) return;
      editor.dirty = clean(crepe.getMarkdown()) !== editor.original;
      showDirty();
    }));
    return { crepe, holder };
  }

  function mountSource(text) {
    const textarea = el("textarea", "md-source");
    textarea.spellcheck = false;
    textarea.value = text;
    textarea.setAttribute("aria-label", "Markdown");
    textarea.addEventListener("input", () => {
      editor.dirty = clean(textarea.value) !== editor.original;
      showDirty();
    });
    // Tab indents rather than leaving the box
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Tab" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      textarea.setRangeText("  ", textarea.selectionStart, textarea.selectionEnd, "end");
      textarea.dispatchEvent(new Event("input"));
    });
    body.append(textarea);
    return textarea;
  }

  const current = () => clean(editor.mode === "source" ? editor.textarea.value : editor.crepe.getMarkdown());

  async function startEdit() {
    if (editor) return;
    editButton.disabled = true;
    editButton.textContent = t("불러오는 중…", "Loading…");
    try {
      const file = await latest();
      const text = file.markdown ?? markdown;
      spy?.disconnect();
      body.className = "md-body";
      const hint = el("p", "md-hint");
      hint.innerHTML = t(
        "<kbd>/</kbd> 블록 추가 · 글자를 선택하면 서식 · 블록 왼쪽 손잡이로 이동 · <kbd>#</kbd> <kbd>-</kbd> <kbd>&gt;</kbd> <kbd>```</kbd> 같은 마크다운 입력도 됩니다",
        "<kbd>/</kbd> adds a block · select text to format it · drag a block by its handle · Markdown like <kbd>#</kbd> <kbd>-</kbd> <kbd>&gt;</kbd> <kbd>```</kbd> works too",
      );
      body.replaceChildren(hint);
      editor = { crepe: null, holder: null, textarea: null, mode: "blocks", sha: file.sha, original: text, dirty: false };
      document.body.classList.add("md-editing");
      try {
        Object.assign(editor, await mountBlocks(text));
        // What the block editor writes back for unchanged text is the baseline
        editor.original = clean(editor.crepe.getMarkdown());
      } catch {
        // The block editor didn't load (offline, CDN blocked): the source still works
        editor.mode = "source";
        editor.textarea = mountSource(text);
        hint.textContent = t("블록 편집기를 불러오지 못해 마크다운 원문으로 편집합니다.", "The block editor didn't load, so this is the Markdown source.");
      }
      sourceButton.setAttribute("aria-pressed", editor.mode === "source");
      sourceButton.disabled = !editor.crepe;
      showBar();
      scrollTo(0, 0);
    } catch (error) {
      editor = null;
      document.body.classList.remove("md-editing");
      render();
      showBar();
      toast(error.status === 401
        ? t("로그인이 만료됐습니다. Shared links 에서 다시 로그인해 주세요.", "Your sign-in has expired. Sign in again on Shared links.")
        : t("편집을 시작하지 못했습니다", "Couldn't start editing") + ` (${error.message}).`);
    } finally {
      editButton.disabled = false;
      editButton.textContent = t("편집", "Edit");
    }
  }

  async function toggleSource() {
    if (!editor || !editor.crepe && editor.mode === "source") return;
    const text = current();
    sourceButton.disabled = true;
    try {
      if (editor.mode === "blocks") {
        editor.holder.hidden = true;
        editor.textarea = mountSource(text);
        editor.mode = "source";
      } else {
        // The block editor starts again from the edited source
        await editor.crepe.destroy();
        editor.holder.remove();
        Object.assign(editor, await mountBlocks(text));
        editor.textarea.remove();
        editor.textarea = null;
        editor.mode = "blocks";
      }
    } finally {
      sourceButton.disabled = false;
    }
    sourceButton.setAttribute("aria-pressed", editor.mode === "source");
  }

  function stopEdit() {
    editor?.crepe?.destroy();
    editor = null;
    document.body.classList.remove("md-editing");
    render();
    showBar();
    scrollTo(0, 0);
  }

  async function save() {
    if (!editor || saveButton.disabled) return;
    const text = current();
    const title = titleOf(text) || document.title;
    status.classList.remove("is-error");
    status.textContent = t("저장 중…", "Saving…");
    saveButton.disabled = cancelButton.disabled = true;
    try {
      const file = await latest();
      if (!file.html || file.markdown == null) throw new Error(t("저장소에서 이 페이지를 찾지 못했습니다", "this page isn't in the repository"));
      if (editor.sha && file.sha !== editor.sha
        && !confirm(t("편집을 시작한 뒤 다른 곳에서 이 페이지가 수정됐습니다. 지금 내용으로 덮어쓸까요?", "This page was changed elsewhere after you started editing. Overwrite it with your version?"))) {
        showDirty();
        return;
      }
      const html = file.html
        .replace(SCRIPT, (all, open, close) => open + escape(text.replace(/\n$/, "")) + close)
        .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>`);
      await gh(api, {
        method: "PUT",
        body: { message: `Edit "${title}"`, content: toBase64(html), sha: file.sha, branch: REPO.branch },
      });
      markdown = text;
      try {
        sessionStorage.setItem(savedKey, JSON.stringify({ markdown, time: Date.now() }));
      } catch {}
      stopEdit();
      toast(t("저장했습니다. 다른 사람에게는 1~2분 뒤 반영됩니다.", "Saved. Everyone else sees it in a minute or two."));
    } catch (error) {
      fail(error.status === 401
        ? t("로그인이 만료됐습니다. 내용을 복사해 두고 Shared links 에서 다시 로그인해 주세요.", "Your sign-in has expired. Copy your text, then sign in again on Shared links.")
        : t("저장하지 못했습니다", "Couldn't save") + ` (${error.message}).`);
    } finally {
      saveButton.disabled = cancelButton.disabled = false;
    }
  }

  editButton.addEventListener("click", startEdit);
  sourceButton.addEventListener("click", toggleSource);
  saveButton.addEventListener("click", save);
  cancelButton.addEventListener("click", () => {
    if (editor.dirty && !confirm(t("저장하지 않은 변경을 버릴까요?", "Discard your unsaved changes?"))) return;
    stopEdit();
  });
  addEventListener("keydown", (event) => {
    if (editor && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  });
  addEventListener("beforeunload", (event) => {
    if (!editor?.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  showBar();
  if (location.hash === "#edit") {
    history.replaceState(null, "", location.pathname + location.search);
    startEdit();
  }
})();
