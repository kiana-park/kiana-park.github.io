// Owner sign-in and the list of unlisted pages in docs/s/.
// Home page: the footer's "Sign in" link becomes "Shared links" plus "Sign out"
// once you're signed in. links/: takes a GitHub token, the same one the CV
// editor uses, and fetches the list from the GitHub API, so the list never
// ships in the page.
//
// Pages are grouped by project. Which page belongs to which project, and the
// order projects and their pages are shown in, is kept in shared-links.json
// at the repository root, outside docs/ so the site never serves it.
// "Organize" edits it from this page: a project menu for each page, Rename,
// and arrows that move pages and projects up and down. A change is committed
// as soon as you make it, a move a moment later, so a run of moves is one
// commit. "Upload" (upload.js, links/ only) publishes a new page from an HTML
// file; each page's trash button deletes it.
// Its format, projects in order, each with its page ids in order:
//   { "projects": [{ "name": "Project name", "pages": ["bxz5thwyhn", "ms6fqkcbqu"] }] }
// The first format, { "projects": { "Project name": [ids] } }, had no order.
// It's read newest first, as it used to be shown, and the next change writes
// it out in this one.

const REPO = { owner: "kiana-park", repo: "kiana-park.github.io", branch: "main", dir: "docs/s" };
const BASE = `/repos/${REPO.owner}/${REPO.repo}`;
const PROJECTS_FILE = "shared-links.json";
const SITE = "https://kiana-park.github.io";
const TOKEN_KEY = "gh:token";       // shared with docs/s/s4htpheix3 (CV editor)
const OLD_TOKEN_KEYS = ["cv:token"];
const COLLAPSED_KEY = "links:collapsed";
const NO_PROJECT = "No project";
const MOVE_WAIT = 1000;             // ms after the last move before it's saved
const ICON = (path) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const TRASH_ICON = ICON("M2.5 4h11M6 4V2.75A.75.75 0 0 1 6.75 2h2.5a.75.75 0 0 1 .75.75V4M3.75 4l.6 9.1a1.5 1.5 0 0 0 1.5 1.4h4.3a1.5 1.5 0 0 0 1.5-1.4l.6-9.1M6.5 7v4.5M9.5 7v4.5");
const UP_ICON = ICON("M8 13V3M4 7l4-4 4 4");
const DOWN_ICON = ICON("M8 3v10M4 9l4 4 4-4");

// Footer, on both pages
const ownerLink = document.getElementById("owner-link");   // home page only
const signoutButton = document.getElementById("signout");

// links/ only
const heading = document.getElementById("links-title");
const list = document.getElementById("links-list");
const count = document.getElementById("links-count");
const note = document.getElementById("links-status");
const tools = document.getElementById("links-tools");
const uploadButton = document.getElementById("links-upload");
const organizeButton = document.getElementById("links-organize");
const refreshButton = document.getElementById("links-refresh");
const hint = document.getElementById("links-hint");
const savingText = document.getElementById("links-saving");
const form = document.getElementById("signin-form");
const tokenInput = document.getElementById("signin-token");
const rememberInput = document.getElementById("signin-remember");
const errorText = document.getElementById("signin-error");

let token = readToken();
let pages = [];                     // newest first, from describe()
let order = [];                     // projects as shown, [{ name, ids }], with the changes not saved yet
let saved = { list: [], sha: null };   // shared-links.json as last read or written; sha null until it exists
const pending = [];                 // changes shown but not saved yet, [{ change, message }]
let saveTimer = 0;
let writing = null;                 // the save under way
let organizing = false;
let confirming = null;              // the open "Delete this page?" strip and its trash button
const collapsed = new Set(readCollapsed());

function readToken() {
  for (const store of [localStorage, sessionStorage]) {
    const saved = store.getItem(TOKEN_KEY);
    if (saved) return saved;
    for (const key of OLD_TOKEN_KEYS) {
      const old = store.getItem(key);
      if (old) {
        store.setItem(TOKEN_KEY, old);
        store.removeItem(key);
        return old;
      }
    }
  }
  return null;
}

function readCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || [];
  } catch {
    return [];
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {}
}

async function gh(path, { accept = "application/vnd.github+json", auth = token, method = "GET", body } = {}) {
  const res = await fetch("https://api.github.com" + path, {
    method,
    cache: "no-store",
    headers: { Authorization: "Bearer " + auth, Accept: accept },
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

// In slices: spreading a whole large file into one call overflows the stack
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const fromBase64 = (data) => new TextDecoder().decode(Uint8Array.from(atob(data.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

// Reads the file in the first format by when pages were updated, so it needs
// the pages loaded
async function readProjects(ref = REPO.branch) {
  try {
    const file = await gh(`${BASE}/contents/${PROJECTS_FILE}?ref=${ref}`);
    return { list: listOf(JSON.parse(fromBase64(file.content)).projects || []), sha: file.sha };
  } catch (error) {
    if (error.status === 404) return { list: [], sha: null };
    throw error;
  }
}

function listOf(projects) {
  if (Array.isArray(projects)) return projects.map(({ name, pages: ids }) => ({ name, ids: [...ids] }));
  const rank = new Map(pages.map((page, i) => [page.id, i]));
  const at = (id) => rank.get(id) ?? Infinity;
  return Object.entries(projects)
    .map(([name, ids]) => ({ name, ids: [...ids].sort((a, b) => at(a) - at(b)) }))
    .sort((a, b) => at(a.ids[0]) - at(b.ids[0]));
}

const projectsText = (list) =>
  JSON.stringify({ projects: list.filter(({ ids }) => ids.length).map(({ name, ids }) => ({ name, pages: ids })) }, null, 2) + "\n";

async function writeProjects(list, sha, message) {
  const res = await gh(`${BASE}/contents/${PROJECTS_FILE}`, {
    method: "PUT",
    body: { message, content: toBase64(projectsText(list)), branch: REPO.branch, ...(sha && { sha }) },
  });
  return res.content.sha;
}

const copyList = (list) => list.map(({ name, ids }) => ({ name, ids: [...ids] }));
const projectOf = (id) => order.find(({ ids }) => ids.includes(id))?.name || "";
const isShown = (id) => pages.some((page) => page.id === id);

// Changes to the list. A page put in a project goes at its top, and a new
// project at the top of the list.
function putIn(list, id, name) {
  for (const project of list) project.ids = project.ids.filter((other) => other !== id);
  if (!name) return;
  const project = list.find((other) => other.name === name);
  if (project) project.ids.unshift(id);
  else list.unshift({ name, ids: [id] });
}

// Renamed to another project's name, it joins that project's end
function renameProject(list, name, next) {
  const project = list.find((other) => other.name === name);
  const target = list.find((other) => other.name === next);
  if (!project) return;
  if (!target) project.name = next;
  else {
    target.ids.push(...project.ids);
    list.splice(list.indexOf(project), 1);
  }
}

// Swaps items[i] with the nearest shown item above (step -1) or below (+1) it
function swap(items, i, step, shown) {
  let j = i + step;
  while (j >= 0 && j < items.length && !shown(items[j])) j += step;
  if (i >= 0 && j >= 0 && j < items.length) [items[i], items[j]] = [items[j], items[i]];
}

function movePage(list, id, step) {
  const ids = list.find((project) => project.ids.includes(id))?.ids;
  if (ids) swap(ids, ids.indexOf(id), step, isShown);
}

const moveProject = (list, name, step) =>
  swap(list, list.findIndex((project) => project.name === name), step, (project) => project.ids.some(isShown));

// One commit removes every file in the page's folder and, if it's in a
// project, its id from shared-links.json. The contents API deletes one file
// per commit, so the commit is built with the Git database API instead.
async function deletePage(page) {
  const folder = `${REPO.dir}/${page.id}/`;
  await flush();
  for (let tries = 1; ; tries++) {
    const head = (await gh(`${BASE}/git/ref/heads/${REPO.branch}`)).object.sha;
    const { tree } = await gh(`${BASE}/git/commits/${head}`);
    const [files, latest] = await Promise.all([
      gh(`${BASE}/git/trees/${tree.sha}?recursive=1`),
      readProjects(head),
    ]);
    const changes = files.tree
      .filter((file) => file.type === "blob" && file.path.startsWith(folder))
      .map((file) => ({ path: file.path, mode: file.mode, type: "blob", sha: null }));
    if (latest.list.some(({ ids }) => ids.includes(page.id))) {
      putIn(latest.list, page.id, "");
      changes.push({ path: PROJECTS_FILE, mode: "100644", type: "blob", content: projectsText(latest.list) });
    }
    let projectsBlob = latest.sha;
    if (changes.length) {
      const next = await gh(`${BASE}/git/trees`, { method: "POST", body: { base_tree: tree.sha, tree: changes } });
      const commit = await gh(`${BASE}/git/commits`, {
        method: "POST",
        body: { message: `Delete shared page "${page.title}"`, tree: next.sha, parents: [head] },
      });
      try {
        await gh(`${BASE}/git/refs/heads/${REPO.branch}`, { method: "PATCH", body: { sha: commit.sha } });
      } catch (error) {
        // Someone committed meanwhile (an upload, a project change): start again on top of it
        if (error.status === 422 && tries < 3) continue;
        throw error;
      }
      projectsBlob = next.tree.find((entry) => entry.path === PROJECTS_FILE)?.sha ?? null;
    }
    saved = { list: latest.list, sha: projectsBlob };
    order = copyList(saved.list);
    return;
  }
}

// Shows a change at once and saves it after `wait` ms, together with any
// other change made by then. Focus goes back to the control that made the
// change, or to focusKey's.
function changeProjects(change, message, focusKey = document.activeElement?.dataset.focusKey, wait = 0) {
  change(order);
  pending.push({ change, message });
  showSaving();
  renderLinks(focusKey);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, wait);
}

// Saves what's pending, then what was changed while it saved, until nothing
// is left. Resolves when it's all saved, or failed.
async function flush() {
  clearTimeout(saveTimer);
  if (writing) return writing;
  writing = (async () => {
    while (pending.length) {
      let failure = null;
      try {
        await save(pending.splice(0));
      } catch (error) {
        failure = error;
      }
      if (failure?.status === 401) {
        pending.length = 0;
        return signOut("Your sign-in has expired. Sign in again to see your links.");
      }
      note.textContent = failure ? "Couldn't save the change (" + failure.message + ")." : "";
      note.hidden = !failure;
      // What's saved plus what's still pending is what's shown, unless the
      // save failed or had to go on top of someone else's change
      const next = copyList(saved.list);
      for (const { change } of pending) change(next);
      if (JSON.stringify(next) !== JSON.stringify(order)) {
        order = next;
        renderLinks(document.activeElement?.dataset.focusKey);
      }
    }
  })();
  try {
    await writing;
  } finally {
    writing = null;
    showSaving();
  }
}

// If the file changed since it was read (GitHub answers 409, or 422 when it
// was created meanwhile), the changes are made again on top of the latest copy
async function save(batch) {
  const messages = [...new Set(batch.map(({ message }) => message))];
  const message = messages.length > 1 ? `Shared links: ${messages.length} changes\n\n${messages.join("\n")}` : messages[0];
  let { list, sha } = saved;
  for (let tries = 1; ; tries++) {
    const next = copyList(list);
    for (const { change } of batch) change(next);
    try {
      saved = { list: next, sha: await writeProjects(next, sha, message) };
      return;
    } catch (error) {
      if ((error.status !== 409 && error.status !== 422) || tries === 3) throw error;
      ({ list, sha } = await readProjects());
    }
  }
}

function showSaving() {
  savingText.hidden = !pending.length && !writing;
}

// An arrow at the end of its list stays disabled
function setBusy(busy) {
  list.setAttribute("aria-busy", busy);
  for (const control of [uploadButton, organizeButton, refreshButton, ...list.querySelectorAll("button, select")]) {
    control.disabled = busy || "end" in control.dataset;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const formatDate = (date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// Title and robots tag come from the page's own HTML; "updated" is its latest commit.
// A page with an editor of its own (the CV) says so with <meta name="editor" content="self">.
async function describe(entry) {
  const [html, commits] = await Promise.all([
    gh(`${BASE}/contents/${entry.path}/index.html?ref=${REPO.branch}`, { accept: "application/vnd.github.raw" }).catch(() => ""),
    gh(`${BASE}/commits?path=${encodeURIComponent(entry.path)}&sha=${REPO.branch}&per_page=1`).catch(() => []),
  ]);
  const doc = new DOMParser().parseFromString(html, "text/html");
  return {
    id: entry.name,
    url: `${SITE}/s/${entry.name}/`,
    title: doc.title.trim() || entry.name,
    noindex: /noindex/i.test(doc.querySelector('meta[name="robots"]')?.content || ""),
    ownEditor: doc.querySelector('meta[name="editor"]')?.content === "self",
    updated: commits[0] ? new Date(commits[0].commit.committer.date) : null,
  };
}

// place: { first, last } in its project, for the arrows; none with no project
function row(page, projectNames, place) {
  const item = el("li", "link");
  const title = el("a", "link__title", page.title);
  title.href = page.url;
  title.target = "_blank";
  title.rel = "noopener";

  const meta = el("p", "link__meta");
  meta.append(el("span", null, `/s/${page.id}/`));
  if (page.updated) meta.append(el("span", null, "Updated " + formatDate(page.updated)));
  if (page.noindex) meta.append(el("span", null, "noindex"));

  const actions = el("div", "link__actions");
  if (!organizing) actions.append(...linkButtons(page), deleteButton(page, item));
  else {
    actions.append(projectPicker(page, projectNames));
    if (place) {
      actions.append(moveButtons(`"${page.title}"`, "page:" + page.id, place, (step) => changeProjects(
        (list) => movePage(list, page.id, step),
        `Shared links: move "${page.title}" ${step < 0 ? "up" : "down"}`,
        undefined,
        MOVE_WAIT,
      )));
    }
  }
  item.append(title, meta, actions);
  return item;
}

// Up and down arrows for a page or a project
function moveButtons(label, key, { first, last }, move) {
  const arrows = el("span", "order");
  for (const [step, way, icon, end] of [[-1, "up", UP_ICON, first], [1, "down", DOWN_ICON, last]]) {
    const button = el("button", "button button--sm order__button");
    button.type = "button";
    button.innerHTML = icon;
    button.dataset.focusKey = `${key}:${way}`;
    if (end) button.dataset.end = "";
    button.disabled = end;
    button.setAttribute("aria-label", `Move ${label} ${way}`);
    button.addEventListener("click", () => move(step));
    arrows.append(button);
  }
  return arrows;
}

// The trash button opens a strip under the row that asks once more
function deleteButton(page, item) {
  const button = el("button", "button button--sm link__delete");
  button.type = "button";
  button.innerHTML = TRASH_ICON;
  button.dataset.focusKey = "delete:" + page.id;
  button.setAttribute("aria-label", "Delete " + page.title);
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "confirm-" + page.id);
  button.addEventListener("click", () => {
    const wasOpen = confirming?.button === button;
    closeConfirm();
    if (!wasOpen) askDelete(page, item, button);
  });
  return button;
}

function closeConfirm(focus = false) {
  if (!confirming) return;
  confirming.box.remove();
  confirming.button.setAttribute("aria-expanded", "false");
  if (focus) confirming.button.focus();
  confirming = null;
}

function askDelete(page, item, button) {
  const box = el("div", "link__confirm");
  box.id = "confirm-" + page.id;
  const text = el("p", "link__confirm-text", "Delete this page? Its link stops working for everyone.");
  text.append(el("span", "link__confirm-help", `Everything in /s/${page.id}/ is removed. It stays in the repository's history on GitHub.`));
  const cancel = el("button", "button button--sm", "Cancel");
  cancel.type = "button";
  const remove = el("button", "button button--sm button--danger", "Delete page");
  remove.type = "button";
  const buttons = el("div", "link__confirm-buttons");
  buttons.append(cancel, remove);
  const error = el("p", "link__confirm-error");
  error.setAttribute("role", "status");
  box.append(text, buttons, error);

  cancel.addEventListener("click", () => closeConfirm(true));
  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !remove.disabled) closeConfirm(true);
  });
  remove.addEventListener("click", async () => {
    error.textContent = "";
    remove.textContent = "Deleting…";
    let failure = null;
    setBusy(true);
    try {
      await deletePage(page);
    } catch (e) {
      failure = e;
    }
    setBusy(false);
    if (failure?.status === 401) return signOut("Your sign-in has expired. Sign in again to see your links.");
    if (failure) {
      remove.textContent = "Delete page";
      error.textContent = "Couldn't delete the page (" + failure.message + ").";
      remove.focus();
      return;
    }
    pages = pages.filter((other) => other !== page);
    count.textContent = pages.length;
    window.forgetUpload?.(page.id);
    note.textContent = `Deleted "${page.title}". Its link stops working in a minute or two.`;
    note.hidden = false;
    renderLinks();
    heading.focus();
  });

  item.append(box);
  button.setAttribute("aria-expanded", "true");
  confirming = { box, button };
  cancel.focus();
}

function linkButtons(page) {
  const copy = el("button", "button button--sm link__copy", "Copy link");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(page.url);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy link"; }, 1600);
    } catch {
      window.prompt("Copy this link:", page.url);
    }
  });

  const open = el("a", "button button--sm", "Open");
  open.href = page.url;
  open.target = "_blank";
  open.rel = "noopener";
  open.setAttribute("aria-label", "Open " + page.title);

  // links/edit/ edits a page's text; a page with its own editor opens instead
  const edit = el("a", "button button--sm", "Edit");
  edit.href = page.ownEditor ? page.url : "edit/?id=" + page.id;
  if (page.ownEditor) {
    edit.target = "_blank";
    edit.rel = "noopener";
  }
  edit.setAttribute("aria-label", "Edit " + page.title);
  return [open, edit, copy];
}

// Organize mode: a menu of the projects, "No project" and "New project…"
function projectPicker(page, projectNames) {
  const current = projectOf(page.id);
  const select = el("select", "picker__select");
  select.dataset.focusKey = "page:" + page.id;
  select.setAttribute("aria-label", "Project for " + page.title);
  for (const name of projectNames) select.add(new Option(name, name, false, name === current));
  select.add(new Option(NO_PROJECT, "", false, !current));
  const newOption = new Option("New project…");
  select.add(newOption);

  select.addEventListener("change", () => {
    let name = select.value;
    if (newOption.selected) {
      name = (window.prompt("Name of the new project:") || "").trim();
      if (!name || name === current) {
        select.value = current;
        return;
      }
    }
    collapsed.delete(name || NO_PROJECT);   // so the page stays in view
    saveCollapsed();
    changeProjects(
      (list) => putIn(list, page.id, name),
      `Shared links: move "${page.title}" to ${name ? `"${name}"` : "no project"}`,
    );
  });

  const picker = el("span", "picker");
  picker.append(select);
  return picker;
}

// Projects in their order, then the pages with no project, newest first
function groupPages() {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const groups = order.map(({ name, ids }) => ({ name, items: ids.map((id) => byId.get(id)).filter(Boolean) }));
  const listed = new Set(order.flatMap(({ ids }) => ids));
  groups.push({ name: "", items: pages.filter((page) => !listed.has(page.id)) });
  return groups.filter(({ items }) => items.length);
}

// projectNames: the projects shown, in order
function groupSection({ name, items }, index, projectNames) {
  const section = el("section", "group");
  const links = el("ul", "links");
  links.setAttribute("role", "list");
  links.id = "group-" + index;
  links.append(...items.map((page, i) => row(page, projectNames, name && { first: i === 0, last: i === items.length - 1 })));

  const label = name || NO_PROJECT;
  const isOpen = !collapsed.has(label);
  links.hidden = !isOpen;

  const toggle = el("button", "group__toggle");
  toggle.type = "button";
  toggle.dataset.focusKey = "group:" + label;
  toggle.setAttribute("aria-expanded", isOpen);
  toggle.setAttribute("aria-controls", links.id);
  toggle.append(el("span", "group__chevron"), el("span", null, label), el("span", "group__count", items.length));
  toggle.addEventListener("click", () => {
    const open = links.hidden;
    links.hidden = !open;
    toggle.setAttribute("aria-expanded", open);
    if (open) collapsed.delete(label);
    else collapsed.add(label);
    saveCollapsed();
  });

  const title = el("h2", "group__title");
  title.append(toggle);
  const head = el("div", "group__head");
  head.append(title);
  const newest = Math.max(...items.map((page) => page.updated || 0));
  if (newest) head.append(el("span", "group__date", "Updated " + formatDate(new Date(newest))));

  if (organizing && name) {
    const rename = el("button", "button button--sm", "Rename");
    rename.type = "button";
    rename.setAttribute("aria-label", "Rename " + name);
    rename.addEventListener("click", () => {
      const next = (window.prompt(`Rename "${name}" to:`, name) || "").trim();
      if (!next || next === name) return;
      changeProjects(
        (list) => renameProject(list, name, next),
        `Shared links: rename project "${name}" to "${next}"`,
        "group:" + next,
      );
    });
    const place = { first: name === projectNames[0], last: name === projectNames.at(-1) };
    head.append(rename, moveButtons(`project "${name}"`, "group:" + name, place, (step) => changeProjects(
      (list) => moveProject(list, name, step),
      `Shared links: move project "${name}" ${step < 0 ? "up" : "down"}`,
      undefined,
      MOVE_WAIT,
    )));
  }

  section.append(head, links);
  return section;
}

function renderLinks(focusKey) {
  confirming = null;
  const groups = groupPages();
  const projectNames = groups.map((group) => group.name).filter(Boolean);
  if (projectNames.length) {
    list.replaceChildren(...groups.map((group, i) => groupSection(group, i, projectNames)));
  } else {
    // No projects yet: one plain list
    const links = el("ul", "links");
    links.setAttribute("role", "list");
    links.append(...pages.map((page) => row(page, projectNames)));
    list.replaceChildren(links);
  }
  if (focusKey) {
    let target = list.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (target?.disabled) target = target.parentElement.querySelector(":enabled") || target;   // an arrow that reached the end: the other one
    target?.focus();
  }
}

async function loadLinks() {
  await flush();
  list.replaceChildren();
  count.textContent = "";
  note.textContent = "Loading…";
  note.hidden = false;
  try {
    const entries = await gh(`${BASE}/contents/${REPO.dir}?ref=${REPO.branch}`);
    pages = await Promise.all(entries.filter((e) => e.type === "dir").map(describe));
    pages.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    saved = await readProjects();
    order = copyList(saved.list);
    renderLinks();
    count.textContent = pages.length;
    note.textContent = pages.length ? "" : "No shared pages yet.";
    note.hidden = pages.length > 0;
  } catch (error) {
    if (error.status === 401) return signOut("Your sign-in has expired. Sign in again to see your links.");
    note.textContent = "Couldn't load your links (" + error.message + ").";
  }
}

function render() {
  signoutButton.hidden = !token;
  if (ownerLink) ownerLink.textContent = token ? "Shared links" : "Sign in";
  if (!form) return;

  form.hidden = Boolean(token);
  tools.hidden = !token;
  if (!token) {
    pages = [];
    pending.length = 0;
    setOrganizing(false);
    window.closeUpload?.();
    list.replaceChildren();
    count.textContent = "";
    note.hidden = true;
  }
}

function setOrganizing(on) {
  organizing = on;
  organizeButton.textContent = on ? "Done" : "Organize";
  hint.hidden = !on;
  if (!on) flush();                   // the last moves, now rather than in a moment
  if (pages.length) renderLinks();
}

function signOut(message = "") {
  for (const store of [localStorage, sessionStorage]) {
    store.removeItem(TOKEN_KEY);
    OLD_TOKEN_KEYS.forEach((key) => store.removeItem(key));
  }
  token = null;
  render();
  if (form) {
    errorText.textContent = message;
    tokenInput.value = "";
    tokenInput.focus();
  }
}

signoutButton.addEventListener("click", () => signOut());
addEventListener("beforeunload", (event) => {
  if (!pending.length && !writing) return;
  event.preventDefault();
  event.returnValue = "";             // older Safari
});

if (form) {
  refreshButton.addEventListener("click", loadLinks);
  organizeButton.addEventListener("click", () => setOrganizing(!organizing));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const candidate = tokenInput.value.trim();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    errorText.textContent = "";
    try {
      const repo = await gh(BASE, { auth: candidate });
      if (!repo.permissions?.push) throw new Error("This token's account can't write to " + REPO.repo + ".");
      (rememberInput.checked ? localStorage : sessionStorage).setItem(TOKEN_KEY, candidate);
      token = candidate;
      tokenInput.value = "";
      render();
      heading.focus();
      loadLinks();
    } catch (error) {
      errorText.textContent = error.status === 401 ? "That token isn't valid." : error.message;
    } finally {
      submit.disabled = false;
    }
  });
}

render();
if (form && token) loadLinks();
