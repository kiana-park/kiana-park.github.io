// Upload: publishes an HTML file from your computer as a new shared page,
// docs/s/<random id>/index.html. One commit adds the page and, if you put it
// in a project, a second one updates shared-links.json.
//
// Before publishing you pick its project, whether search engines may list it
// and, when it has speaker notes, whether to keep them. Those choices change
// the file's own text: notes are cut out and the robots tag is added or
// removed in place, so the rest of the file is published byte for byte.
//
// links/ only. Runs after links.js and uses its gh(), toBase64(), el(),
// linkButtons(), changeProjects(), renderLinks(), signOut() and state.

(() => {
  // Elements that hold speaker notes, by class: reveal.js and most HTML decks
  // use <aside class="notes">
  const NOTE_CLASSES = ["notes", "speaker-notes", "speaker-note", "presenter-notes", "presenter-note", "slide-notes"];
  const NOTES = NOTE_CLASSES.map((name) => "." + name).join(", ");
  const RAW = new Set(["script", "style", "textarea", "title"]);
  const LAST_PROJECT_KEY = "links:upload-project";
  const MAX_BYTES = 100 * 1024 * 1024;   // the largest file GitHub accepts

  const card = document.querySelector(".card--links");
  const fileInput = document.getElementById("upload-file");
  const panel = document.getElementById("upload");
  const titleText = document.getElementById("upload-title");
  const metaText = document.getElementById("upload-meta");
  const rows = panel.querySelector(".upload__rows");
  const projectSelect = document.getElementById("upload-project");
  const noindexInput = document.getElementById("upload-noindex");
  const notesRow = document.getElementById("upload-notes");
  const notesHelp = document.getElementById("upload-notes-help");
  const notesList = document.getElementById("upload-notes-list");
  const warning = document.getElementById("upload-warning");
  const publishButton = document.getElementById("upload-publish");
  const status = document.getElementById("upload-status");
  const done = document.getElementById("upload-done");
  const doneTitle = document.getElementById("upload-done-title");
  const doneMeta = document.getElementById("upload-done-meta");
  const doneStatus = document.getElementById("upload-done-status");
  const doneActions = document.getElementById("upload-done-actions");

  const noProject = new Option(NO_PROJECT, "");
  const newProject = new Option("New project…");
  let project = "";        // the menu's choice before "New project…"
  let chosen = null;       // { name, html, doc, title, hasTitle }
  let publishing = false;
  let run = 0;             // goes up when the panel changes, to stop a stale live check
  let shownId = null;      // the page on show once published

  // Tags with their offsets in the file. Comments and the insides of script,
  // style, textarea and title are skipped, as in edit.js.
  function scanTags(html) {
    const tags = [];
    const tag = /<(\/?)([a-zA-Z][^\t\n\f\r />]*)(?:[^>"']|"[^"]*"|'[^']*')*>/y;
    let i = 0;
    while ((i = html.indexOf("<", i)) !== -1) {
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        i = end < 0 ? html.length : end + 3;
      } else if (/^<(?:[!?]|\/[^a-zA-Z])/.test(html.slice(i, i + 3))) {
        const end = html.indexOf(">", i);   // doctype, <?…>, </ followed by no name
        i = end < 0 ? html.length : end + 1;
      } else {
        tag.lastIndex = i;
        const m = tag.exec(html);
        if (!m) {
          i++;
          continue;
        }
        const name = m[2].toLowerCase();
        tags.push({ name, close: Boolean(m[1]), start: i, end: tag.lastIndex, text: m[0] });
        i = tag.lastIndex;
        if (!m[1] && RAW.has(name)) {
          const close = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "ig");
          close.lastIndex = i;
          i = close.exec(html)?.index ?? html.length;
        }
      }
    }
    return tags;
  }

  // An attribute's value in a tag's text, or null
  function attr(tag, name) {
    const m = new RegExp(`[\\s"'/]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    return m ? m[1] ?? m[2] ?? m[3] : null;
  }

  const isNote = (tag) => (attr(tag, "class") || "").split(/[\t\n\f\r ]+/).some((name) => NOTE_CLASSES.includes(name));

  // Replaces [start, end) ranges with text; an insertion and a cut at the same
  // place come out in that order
  function splice(html, edits) {
    edits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let out = "";
    let at = 0;
    for (const [start, end, text] of edits) {
      out += html.slice(at, start) + text;
      at = end;
    }
    return out + html.slice(at);
  }

  // Something alone on its line takes the line with it when it's cut
  function wholeLine(html, start, end) {
    const from = html.lastIndexOf("\n", start - 1) + 1;
    const next = html.indexOf("\n", end);
    const to = next < 0 ? html.length : next + 1;
    const alone = /^[ \t]*$/.test(html.slice(from, start)) && /^[ \t\r]*\n?$/.test(html.slice(end, to));
    return alone ? [from, to] : [start, end];
  }

  const squash = (text) => text.replace(/\s+/g, "");
  const serialize = (doc) => (doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : "") + doc.documentElement.outerHTML + "\n";

  // Cuts every notes element out of the file. The result is checked against
  // the parsed page with its notes removed; if they differ (markup the scan
  // can't follow), that parsed page is published instead.
  function withoutNotes(html, doc) {
    const expected = doc.cloneNode(true);
    expected.querySelectorAll(NOTES).forEach((node) => node.remove());

    const tags = scanTags(html);
    const edits = [];
    let after = 0;
    for (let i = 0; i < tags.length; i++) {
      const open = tags[i];
      if (open.close || open.start < after || !isNote(open.text)) continue;
      let depth = 0;
      let end = -1;
      for (let j = i; j < tags.length && end < 0; j++) {
        if (tags[j].name !== open.name) continue;
        depth += tags[j].close ? -1 : 1;
        if (!depth) end = tags[j].end;
      }
      if (end < 0) return serialize(expected);
      edits.push([...wholeLine(html, open.start, end), ""]);
      after = end;
    }

    const result = splice(html, edits);
    const got = new DOMParser().parseFromString(result, "text/html");
    const same = !got.querySelector(NOTES)
      && got.getElementsByTagName("*").length === expected.getElementsByTagName("*").length
      && squash(got.documentElement.textContent) === squash(expected.documentElement.textContent);
    return same ? result : serialize(expected);
  }

  // Adds noindex (and no-referrer, so links out of the page don't pass on its
  // address) or removes the robots tag, and adds a missing title. A file that
  // already says noindex keeps its own tag. New tags go after <meta charset>
  // (or <head>, <html>, the doctype), each on its own line when the file has lines.
  function withHead(html, { noindex, title }) {
    const tags = scanTags(html);
    const metas = tags.filter((tag) => !tag.close && tag.name === "meta");
    const named = (tag, name) => (attr(tag.text, "name") || "").toLowerCase() === name;
    const robots = metas.filter((tag) => named(tag, "robots"));
    const hasNoindex = robots.length === 1 && /noindex/i.test(attr(robots[0].text, "content") || "");
    const edits = noindex && hasNoindex ? [] : robots.map((tag) => [...wholeLine(html, tag.start, tag.end), ""]);

    const add = [];
    if (title) add.push(`<title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>`);
    if (noindex) {
      if (!hasNoindex) add.push('<meta name="robots" content="noindex, nofollow">');
      if (!metas.some((tag) => named(tag, "referrer"))) add.push('<meta name="referrer" content="no-referrer">');
    }
    if (add.length) {
      const anchor = metas.find((tag) => attr(tag.text, "charset") != null)
        || tags.find((tag) => !tag.close && tag.name === "head")
        || tags.find((tag) => !tag.close && tag.name === "html");
      const at = anchor ? anchor.end : /^\s*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0;
      const sep = /^\r?\n[ \t]*/.exec(html.slice(at, at + 200))?.[0] ?? "";
      edits.push([at, at, add.map((text) => sep + text).join("")]);
    }
    return splice(html, edits);
  }

  // Relative addresses the page loads or links to: those files aren't uploaded
  function localFiles(doc) {
    if (doc.querySelector("base[href]")) return [];
    const found = new Set();
    const add = (url) => {
      url = (url || "").trim();
      if (!/^(?:[a-z][a-z\d+.-]*:|\/\/|#|$)/i.test(url)) found.add(url.split(/[?#]/)[0]);
    };
    for (const node of doc.querySelectorAll("[src], [poster], link[href], a[href]")) {
      add(node.getAttribute("src") ?? node.getAttribute("poster") ?? node.getAttribute("href"));
    }
    for (const node of doc.querySelectorAll("[srcset]")) {
      for (const part of node.getAttribute("srcset").split(",")) add(part.trim().split(/\s+/)[0]);
    }
    const css = [...doc.querySelectorAll("style")].map((node) => node.textContent)
      .concat([...doc.querySelectorAll("[style]")].map((node) => node.getAttribute("style")))
      .join("\n");
    for (const m of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(['"])(.*?)\3/g)) add(m[2] ?? m[4]);
    found.delete("");
    return [...found];
  }

  const formatSize = (bytes) => bytes < 1024 * 1024
    ? Math.max(1, Math.round(bytes / 1024)) + " KB"
    : (bytes / 1024 / 1024).toFixed(1) + " MB";

  function fillProjects() {
    const names = [...new Set(pages.map((page) => projects[page.id]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    let last = "";
    try {
      last = localStorage.getItem(LAST_PROJECT_KEY) || "";
    } catch {}
    projectSelect.replaceChildren(...names.map((name) => new Option(name, name)), noProject, newProject);
    projectSelect.value = project = names.includes(last) ? last : "";
  }

  async function choose(file) {
    if (!file || !token || publishing) return;
    const mine = ++run;
    chosen = null;
    done.hidden = true;
    panel.hidden = false;
    status.textContent = "";
    titleText.textContent = file.name;
    metaText.textContent = formatSize(file.size);
    rows.hidden = warning.hidden = publishButton.disabled = true;

    let html = null;
    if (!/\.html?$/i.test(file.name) && file.type !== "text/html") {
      status.textContent = "Choose an HTML file (.html).";
    } else if (file.size > MAX_BYTES) {
      status.textContent = "This file is over 100 MB, more than GitHub accepts.";
    } else {
      try {
        html = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        status.textContent = "This file isn't UTF-8 text. Save it as UTF-8 and try again.";
      }
      if (mine !== run) return;   // closed, or another file chosen meanwhile
    }
    if (html == null) return titleText.focus();

    const doc = new DOMParser().parseFromString(html, "text/html");
    const name = file.name.replace(/\.html?$/i, "");
    chosen = {
      name: file.name,
      html,
      doc,
      title: doc.title.trim() || name,
      hasTitle: [...doc.getElementsByTagName("title")].some((node) => node.namespaceURI === "http://www.w3.org/1999/xhtml"),
    };
    titleText.textContent = chosen.title;
    metaText.textContent = `${file.name} · ${formatSize(file.size)}`;

    fillProjects();
    noindexInput.checked = true;

    const notes = [...doc.querySelectorAll(NOTES)]
      .filter((node) => !node.parentElement?.closest(NOTES))
      .map((node) => node.textContent.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    notesRow.hidden = !notes.length;
    panel.elements.notes.value = "remove";
    notesRow.querySelector("details").open = false;
    notesHelp.textContent = `Found ${notes.length === 1 ? "one note" : notes.length + " notes"}. Kept notes stay in the page's source, where anyone can read them.`;
    notesList.replaceChildren(...notes.map((text) => el("li", null, text.length > 240 ? text.slice(0, 239) + "…" : text)));

    const files = localFiles(doc);
    const n = files.length;
    warning.hidden = !n;
    warning.textContent = `This page uses ${n === 1 ? "a file" : n + " files"} that won't be uploaded with it, so ${n === 1 ? "it" : "they"} won't load: `
      + files.slice(0, 3).join(", ") + (n > 3 ? ` and ${n - 3} more` : "")
      + ". Put them in the HTML file itself or link to them with a full https:// address.";

    rows.hidden = publishButton.disabled = false;
    titleText.focus();
  }

  function close() {
    run++;
    chosen = null;
    panel.hidden = done.hidden = true;
  }
  window.closeUpload = close;     // links.js closes the panel on sign-out
  // and, once a page is deleted, takes its "Published" panel away
  window.forgetUpload = (id) => {
    if (!done.hidden && id === shownId) close();
  };

  function setPublishing(on) {
    publishing = on;
    for (const control of panel.elements) control.disabled = on;
    uploadButton.disabled = on;
    publishButton.textContent = on ? "Publishing…" : "Publish";
    panel.setAttribute("aria-busy", on);
  }

  // A new random id like the others (10 letters and digits); GitHub answers
  // 422 if the path is taken, and the next try picks another
  async function create(html, title) {
    const content = toBase64(html);
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (let tries = 1; ; tries++) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => chars[byte % chars.length]).join("");
      try {
        await gh(`${BASE}/contents/${REPO.dir}/${id}/index.html`, {
          method: "PUT",
          body: { message: `Add shared page "${title}"`, content, branch: REPO.branch },
        });
        return id;
      } catch (error) {
        if (error.status !== 422 || tries === 3) throw error;
      }
    }
  }

  // The link works once GitHub Pages has rebuilt the site, usually in a
  // minute or two. A new query string each time gets past any cache.
  async function watchLive(page) {
    const mine = run;
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (mine !== run) return;
      const res = await fetch(page.url + "?" + Date.now(), { method: "HEAD", cache: "no-store" }).catch(() => null);
      if (mine !== run) return;
      if (res?.ok) {
        doneStatus.textContent = "Published. The link works now.";
        return;
      }
    }
  }

  function showDone(page) {
    run++;
    panel.hidden = true;
    done.hidden = false;
    shownId = page.id;
    doneTitle.textContent = page.title;
    doneMeta.textContent = page.url;
    doneStatus.textContent = "Published. The link starts working in a minute or two.";
    const closeButton = el("button", "button button--sm", "Close");
    closeButton.type = "button";
    closeButton.addEventListener("click", () => {
      close();
      uploadButton.focus();
    });
    doneActions.replaceChildren(...linkButtons(page), closeButton);
    doneTitle.focus();
    watchLive(page);
  }

  panel.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!chosen || publishing) return;
    const { html, doc, title, hasTitle } = chosen;
    const name = projectSelect.value;
    const noindex = noindexInput.checked;
    const removeNotes = !notesRow.hidden && panel.elements.notes.value === "remove";

    let text = removeNotes ? withoutNotes(html, doc) : html;
    text = withHead(text, { noindex, title: hasTitle ? "" : title });

    setPublishing(true);
    status.textContent = "";
    let id;
    try {
      id = await create(text, title);
    } catch (error) {
      setPublishing(false);
      if (error.status === 401) return signOut("Your sign-in has expired. Sign in again to see your links.");
      status.textContent = "Couldn't publish the page (" + error.message + ").";
      return;
    }
    setPublishing(false);

    try {
      localStorage.setItem(LAST_PROJECT_KEY, name);
    } catch {}
    const page = {
      id,
      url: `${SITE}/s/${id}/`,
      title,
      noindex,
      ownEditor: doc.querySelector('meta[name="editor"]')?.content === "self",
      updated: new Date(),
    };
    pages.unshift(page);
    count.textContent = pages.length;
    note.hidden = true;
    collapsed.delete(name || NO_PROJECT);   // so the new page is in view
    saveCollapsed();
    showDone(page);
    if (name) changeProjects((map) => { map[id] = name; }, `Shared links: put "${title}" in "${name}"`);
    else renderLinks();
  });

  uploadButton.addEventListener("click", () => fileInput.click());
  document.getElementById("upload-change").addEventListener("click", () => fileInput.click());
  document.getElementById("upload-cancel").addEventListener("click", () => {
    close();
    uploadButton.focus();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    fileInput.value = "";   // so picking the same file again still counts
    choose(file);
  });

  projectSelect.addEventListener("change", () => {
    if (!newProject.selected) {
      project = projectSelect.value;
      return;
    }
    const name = (window.prompt("Name of the new project:") || "").trim();
    if (name && ![...projectSelect.options].some((option) => option.value === name)) {
      projectSelect.add(new Option(name, name), noProject);
    }
    projectSelect.value = project = name || project;
  });

  // Drop a file anywhere on the page
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragover", (event) => {
    if (!token || !hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = publishing ? "none" : "copy";
    card.classList.add("is-dropping");
  });
  document.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) card.classList.remove("is-dropping");   // left the window
  });
  document.addEventListener("drop", (event) => {
    card.classList.remove("is-dropping");
    if (!token || !hasFiles(event)) return;
    event.preventDefault();
    choose(event.dataTransfer.files[0]);
  });
})();
