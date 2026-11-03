// Owner sign-in and the list of unlisted pages in docs/s/.
// Home page: the footer's "Sign in" link becomes "Shared links" plus "Sign out"
// once you're signed in. links/: takes a GitHub token, the same one the CV
// editor uses, and fetches the list from the GitHub API, so the list never
// ships in the page.

const REPO = { owner: "kiana-park", repo: "kiana-park.github.io", branch: "main", dir: "docs/s" };
const SITE = "https://kiana-park.github.io";
const TOKEN_KEY = "gh:token";       // shared with docs/s/s4htpheix3 (CV editor)
const OLD_TOKEN_KEYS = ["cv:token"];

// Footer, on both pages
const ownerLink = document.getElementById("owner-link");   // home page only
const signoutButton = document.getElementById("signout");

// links/ only
const heading = document.getElementById("links-title");
const list = document.getElementById("links-list");
const count = document.getElementById("links-count");
const note = document.getElementById("links-status");
const refreshButton = document.getElementById("links-refresh");
const form = document.getElementById("signin-form");
const tokenInput = document.getElementById("signin-token");
const rememberInput = document.getElementById("signin-remember");
const errorText = document.getElementById("signin-error");

let token = readToken();

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

async function gh(path, { accept = "application/vnd.github+json", auth = token } = {}) {
  const res = await fetch("https://api.github.com" + path, {
    cache: "no-store",
    headers: { Authorization: "Bearer " + auth, Accept: accept },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.message || res.statusText);
    error.status = res.status;
    throw error;
  }
  return accept.endsWith(".raw") ? res.text() : res.json();
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
  const base = `/repos/${REPO.owner}/${REPO.repo}`;
  const [html, commits] = await Promise.all([
    gh(`${base}/contents/${entry.path}/index.html?ref=${REPO.branch}`, { accept: "application/vnd.github.raw" }).catch(() => ""),
    gh(`${base}/commits?path=${encodeURIComponent(entry.path)}&sha=${REPO.branch}&per_page=1`).catch(() => []),
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

function row(page) {
  const item = el("li", "link");
  const title = el("a", "link__title", page.title);
  title.href = page.url;
  title.target = "_blank";
  title.rel = "noopener";

  const meta = el("p", "link__meta");
  meta.append(el("span", null, `/s/${page.id}/`));
  if (page.updated) meta.append(el("span", null, "Updated " + formatDate(page.updated)));
  if (page.noindex) meta.append(el("span", null, "noindex"));

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

  item.append(title, meta, copy);
  return item;
}

async function loadLinks() {
  list.replaceChildren();
  count.textContent = "";
  note.textContent = "Loading…";
  note.hidden = false;
  try {
    const entries = await gh(`/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.dir}?ref=${REPO.branch}`);
    const pages = await Promise.all(entries.filter((e) => e.type === "dir").map(describe));
    pages.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    list.replaceChildren(...pages.map(row));
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
  refreshButton.hidden = !token;
  if (!token) {
    list.replaceChildren();
    count.textContent = "";
    note.hidden = true;
  }
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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const candidate = tokenInput.value.trim();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    errorText.textContent = "";
    try {
      const repo = await gh(`/repos/${REPO.owner}/${REPO.repo}`, { auth: candidate });
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
