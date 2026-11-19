# Zentangle portfolio

A small static website that shows all your zentangle SVGs and lets visitors play with each one.

- **Index page** (`index.html`): a gallery of every sketch, with search and a "Surprise me" button.
- **Sketch pages** (`sketch.html?s=…`): the interactive player for one sketch, with ‹ Prev / Next › and a link
  back to the index. Arrow keys and swipes move between sketches.
- **No colour features:** the artwork always shows as ink on paper. Visitors can't recolour it or upload files.

## Adding your sketches

1. Put your `.svg` files in the **`sketches/`** folder (subfolders are fine).
2. Run:

       python3 update_index.py

   That scans the folder and writes `sketches.json`, the list the website reads. (A static web host can't list a
   folder by itself, so this step is needed.) Run it again whenever you add, remove or rename a sketch.

**Titles** come from the SVG's own `<title>` if it has one (in Inkscape: File › Document Properties › Metadata ›
Title), otherwise from the file name: `tide-pool_02.svg` → "Tide Pool 02".

**Order:** newest file first by default. For a fixed order, start file names with numbers (`01-…`, `02-…`) and run
`python3 update_index.py --sort name`. The number prefix is left out of the title.

The two demo tiles (`mandala-tile.svg`, `spiral-garden.svg`) are placeholders. Delete them once you've added yours.

## Your details

Edit **`config.js`**: your name, the site title, tagline, about text, links, the animation each sketch opens in,
and whether visitors may save a PNG (`allowDownloads`, off by default).

## Trying it on your computer

The pages load your SVGs with `fetch`, which browsers don't allow from a file opened from disk. Serve the folder:

    python3 -m http.server 8000      # then open http://localhost:8000

## Publishing

Upload the whole folder to any static host (Netlify, Cloudflare Pages, GitHub Pages, your own server).
Remember to run `update_index.py` before uploading.

**GitHub Pages, fully automatic (optional):** `.github/workflows/pages.yml` rebuilds the sketch list and publishes
the site on every push. Push this folder to a GitHub repository, then go to Settings › Pages › Source:
**GitHub Actions**. After that, adding an SVG to `sketches/` and pushing is all it takes.

## What visitors can do

| Motion | Draw & reveal | Effects |
|---|---|---|
| Vertex, Magnet, Melt, Shatter, Lens, Wind, Morph (into any of your other sketches) | Draw, Ink spread, Scan, Grow, Redraw | Glow, Echo trails, Kaleidoscope, Paper grain & ink bleed |

Keys: `←` `→` previous/next sketch · `↑` `↓` or `1`–`9` animation · `Space` pause · `R` restart · `S` new noise ·
`G` `E` `K` `P` effects · `Esc` back to the index. Settings carry over from sketch to sketch while the tab is open.

## Files

| File | What it is |
|---|---|
| `index.html`, `gallery.js` | the index page |
| `sketch.html`, `player.js` | the sketch page and player |
| `site.css` | styles for both pages |
| `config.js` | your details |
| `update_index.py` | scans `sketches/` → `sketches.json` |
| `zentangle-core.js`, `p5.min.js` | the animation engine (same as the standalone animator) and p5.js |

## Tips for large traced drawings

Traced files can be large (1 MB or more). They work, but load faster if you simplify them in Inkscape first
(Path › Simplify, Ctrl+L), and the gallery thumbnails will appear sooner too.
