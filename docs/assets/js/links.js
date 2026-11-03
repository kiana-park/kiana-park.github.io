// Owner sign-in and the list of unlisted pages in docs/s/.
// Home page: the footer's "Sign in" link becomes "Shared links" plus "Sign out"
// once you're signed in. links/: takes a GitHub token, the same one the CV
// editor uses, and fetches the list from the GitHub API, so the list never
// ships in the page.
//
// Pages are grouped by project. Which page belongs to which project is kept in
// shared-links.json at the repository root, outside docs/ so the site never
// serves it. "Organize" edits it from this page; each change is one commit.
// Its format, page ids by project name:
//   { "projects": { "Project name": ["bxz5thwyhn", "ms6fqkcbqu"] } }

const REPO = { owner: "kiana-park", repo: "kiana-park.github.io", branch: "main", dir: "docs/s" };
const BASE = `/repos/${REPO.owner}/${REPO.repo}`;
const PROJECTS_FILE = "shared-links.json";
const SITE = "https://kiana-park.github.io";
const TOKEN_KEY = "gh:token";       // shared with docs/s/s4htpheix3 (CV editor)
const OLD_TOKEN_KEYS = ["cv:token"];
const COLLAPSED_KEY = "links:collapsed";
const NO_PROJECT = "No project";

// Footer, on both pages
const ownerLink = document.getElementById("owner-link");   // home page only
const signoutButton = document.getElementById("signout");

// links/ only
const heading = document.getElementById("links-title");
const list = document.getElementById("links-list");
const count = document.getElementById("links-count");
const note = document.getElementById("links-status");
const tools = document.getElementById("links-tools");
const organizeButton = document.getElementById("links-organize");
const refreshButton = document.getElementById("links-refresh");
const hint = document.getElementById("links-hint");
const form = document.getElementById("signin-form");
const tokenInput = document.getElementById("signin-token");
const rememberInput = document.getElementById("signin-remember");
const errorText = document.getElementById("signin-error");

let token = readToken();
let pages = [];                     // newest first, from describe()
let projects = {};                  // page id → project name
let projectsSha = null;             // null until shared-links.json exists
let organizing = false;
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

const toBase64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromBase64 = (data) => new TextDecoder().decode(Uint8Array.from(atob(data.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

async function readProjects() {
  try {
    const file = await gh(`${BASE}/contents/${PROJECTS_FILE}?ref=${REPO.branch}`);
    const map = {};
    for (const [name, ids] of Object.entries(JSON.parse(fromBase64(file.content)).projects || {})) {
      for (const id of ids) map[id] = name;
    }
    return { map, sha: file.sha };
  } catch (error) {
    if (error.status === 404) return { map: {}, sha: null };
    throw error;
  }
}

// Projects and their page ids in a fixed order (by code point, the same in
// every browser), so each commit's diff shows only what changed
async function writeProjects(map, sha, message) {
  const byName = {};
  for (const [id, name] of Object.entries(map)) (byName[name] ||= []).push(id);
  const names = Object.keys(byName).sort();
  const text = JSON.stringify({ projects: Object.fromEntries(names.map((name) => [name, byName[name].sort()])) }, null, 2) + "\n";
  const res = await gh(`${BASE}/contents/${PROJECTS_FILE}`, {
    method: "PUT",
    body: { message, content: toBase64(text), branch: REPO.branch, ...(sha && { sha }) },
  });
  return res.content.sha;
}

// If the file changed since it was loaded (GitHub answers 409, or 422 when it
// was created meanwhile), the change is made again on top of the latest copy.
// Focus goes back to the control that made the change, or to focusKey's.
async function changeProjects(change, message, focusKey = document.activeElement?.dataset.focusKey) {
  let failure = null;
  setBusy(true);
  try {
    let next = { ...projects };
    change(next);
    try {
      projectsSha = await writeProjects(next, projectsSha, message);
    } catch (error) {
      if (error.status !== 409 && error.status !== 422) throw error;
      const latest = await readProjects();
      next = latest.map;
      change(next);
      projectsSha = await writeProjects(next, latest.sha, message);
    }
    projects = next;
  } catch (error) {
    failure = error;
  }
  setBusy(false);
  if (failure?.status === 401) return signOut("Your sign-in has expired. Sign in again to see your links.");
  note.textContent = failure ? "Couldn't save the change (" + failure.message + ")." : "";
  note.hidden = !failure;
  renderLinks(focusKey);
}

function setBusy(busy) {
  list.setAttribute("aria-busy", busy);
  for (const control of [organizeButton, refreshButton, ...list.querySelectorAll("button, select")]) control.disabled = busy;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const formatDate = (date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// Title and robots tag come from the page's own HTML; "updated" is its latest commit.
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
    updated: commits[0] ? new Date(commits[0].commit.committer.date) : null,
  };
}

function row(page, projectNames) {
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
  actions.append(...(organizing ? [projectPicker(page, projectNames)] : linkButtons(page)));
  item.append(title, meta, actions);
  return item;
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
  return [open, copy];
}

// Organize mode: a menu of the projects, "No project" and "New project…"
function projectPicker(page, projectNames) {
  const current = projects[page.id] || "";
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
      (map) => { if (name) map[page.id] = name; else delete map[page.id]; },
      `Shared links: move "${page.title}" to ${name ? `"${name}"` : "no project"}`,
    );
  });

  const picker = el("span", "picker");
  picker.append(select);
  return picker;
}

// Groups in the order of their newest page (pages are sorted newest first),
// with pages that have no project last
function groupPages() {
  const groups = new Map();
  for (const page of pages) {
    const name = projects[page.id] || "";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(page);
  }
  return [...groups].map(([name, items]) => ({ name, items })).sort((a, b) => !a.name - !b.name);
}

function groupSection({ name, items }, index, projectNames) {
  const section = el("section", "group");
  const links = el("ul", "links");
  links.setAttribute("role", "list");
  links.id = "group-" + index;
  links.append(...items.map((page) => row(page, projectNames)));

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
  if (items[0].updated) head.append(el("span", "group__date", "Updated " + formatDate(items[0].updated)));

  if (organizing && name) {
    const rename = el("button", "button button--sm", "Rename");
    rename.type = "button";
    rename.setAttribute("aria-label", "Rename " + name);
    rename.addEventListener("click", () => {
      const next = (window.prompt(`Rename "${name}" to:`, name) || "").trim();
      if (!next || next === name) return;
      changeProjects(
        (map) => { for (const id in map) if (map[id] === name) map[id] = next; },
        `Shared links: rename project "${name}" to "${next}"`,
        "group:" + next,
      );
    });
    head.append(rename);
  }

  section.append(head, links);
  return section;
}

function renderLinks(focusKey) {
  const groups = groupPages();
  const projectNames = groups.map((group) => group.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (projectNames.length) {
    list.replaceChildren(...groups.map((group, i) => groupSection(group, i, projectNames)));
  } else {
    // No projects yet: one plain list
    const links = el("ul", "links");
    links.setAttribute("role", "list");
    links.append(...pages.map((page) => row(page, projectNames)));
    list.replaceChildren(links);
  }
  if (focusKey) list.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

async function loadLinks() {
  list.replaceChildren();
  count.textContent = "";
  note.textContent = "Loading…";
  note.hidden = false;
  try {
    const [entries, saved] = await Promise.all([
      gh(`${BASE}/contents/${REPO.dir}?ref=${REPO.branch}`),
      readProjects(),
    ]);
    pages = await Promise.all(entries.filter((e) => e.type === "dir").map(describe));
    pages.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    projects = saved.map;
    projectsSha = saved.sha;
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
    setOrganizing(false);
    list.replaceChildren();
    count.textContent = "";
    note.hidden = true;
  }
}

function setOrganizing(on) {
  organizing = on;
  organizeButton.textContent = on ? "Done" : "Organize";
  hint.hidden = !on;
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
