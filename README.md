# kiana-park.github.io

Source for my personal website: **https://kiana-park.github.io**

The site is plain HTML, CSS, and JavaScript with no build step. GitHub Pages
publishes the [`docs/`](docs/) folder of the `main` branch exactly as it is.

## Structure

```text
.
├── docs/                      # Everything in here is published
│   ├── index.html             # Home page
│   ├── 404.html               # Shown for any URL that doesn't exist
│   ├── assets/
│   │   ├── css/style.css      # Styles (design tokens at the top)
│   │   ├── js/main.js         # Scripts
│   │   └── img/og-image.png   # Link-preview image, 1200×630
│   ├── favicon.svg            # Browser tab icon
│   ├── favicon.ico            # Fallback icon for older browsers
│   ├── apple-touch-icon.png   # iOS home-screen icon, 180×180
│   ├── robots.txt
│   ├── sitemap.xml
│   └── .nojekyll              # Tells GitHub Pages to skip Jekyll processing
├── .editorconfig
├── .gitignore
└── README.md
```

## Preview locally

```sh
python3 -m http.server 8000 --directory docs
```

Then open <http://localhost:8000>. The local server shows its own error page
for missing URLs; open <http://localhost:8000/404.html> to see the custom one.

## Deploy

Push to `main`. GitHub Pages is set to **Deploy from a branch → `main` → `/docs`**
(Settings → Pages), and the live site usually updates within a few minutes of each
push (GitHub says it can take up to 10). You can follow each deployment in the
**Actions** tab ("pages build and deployment"). Pages lets browsers cache files for
10 minutes, so if a change doesn't show once the run has finished, hard-refresh
(Cmd+Shift+R or Ctrl+Shift+R).

## Customize

- **Text:** each card on the home page is an element with the `card` class in
  `docs/index.html` (intro, monogram, About, Projects, Contact, Status).
- **Card layout:** the "Bento grid" part of `docs/assets/css/style.css` places the
  cards with `grid-template-areas`, separately for phones, tablets (600px+), and
  desktops (960px+).
- **More projects:** see the comment above `.project` in `style.css`.
- **Title, description, and link previews:** the `<head>` of `docs/index.html`
- **Colors, type, and spacing:** the tokens at the top of `docs/assets/css/style.css`;
  the dark-mode colors are in the `prefers-color-scheme: dark` block right below them.
- **Fonts:** Geist and Geist Mono, loaded from Google Fonts by the `<link>` tags in
  the `<head>` of `docs/index.html` and `docs/404.html`.
- **Link-preview image:** replace `docs/assets/img/og-image.png` with any 1200×630 PNG,
  then update `og:image:alt` in the `<head>` of `docs/index.html` to describe it.
  Some apps (Facebook, KakaoTalk) cache preview images by URL, so also add `?v=2`
  (next time `?v=3`, …) to the end of the `og:image` URL.
- **Icons:** `docs/favicon.svg`, `docs/favicon.ico`, `docs/apple-touch-icon.png`

### Adding a page

Create `docs/<name>/index.html` and it will be served at `/<name>/`. Because the
page sits one folder deeper, its links to shared files need `../` (for example
`../assets/css/style.css`), and so do the header links back to the home page
(`../`, `../#about`, `../#projects`, `../#contact`). If you start from a copy of
`index.html`, also give the page its own `<title>`, description, canonical URL,
`og:title`, `og:description`, and `og:url` (for example
`https://kiana-park.github.io/<name>/`); otherwise search engines and link
previews treat it as the home page. Then add the new URL to `docs/sitemap.xml`.

`docs/404.html` is the exception: GitHub Pages serves it at whatever URL was
requested, so its links must start with `/` (for example `/assets/css/style.css`).
