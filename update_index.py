#!/usr/bin/env python3
"""
Scan the sketches/ folder and write sketches.json, the list the website reads.

Run it whenever you add, remove or rename a sketch:

    python3 update_index.py

Titles: taken from the SVG's own <title> if it has one, otherwise from the file name
("tide-pool_02.svg" -> "Tide Pool 02"). To set a title in Inkscape: Object > Object Properties
on the root, or File > Document Properties > Metadata > Title.

Order: newest file first. Use  --sort name  for alphabetical order, or put numbers at the start
of file names ("01-…", "02-…") and use --sort name to control the order exactly.

Only the Python standard library is used. Nothing to install.
"""
import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SVG_NS = "{http://www.w3.org/2000/svg}"


def slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", name).strip("-").lower()
    return s or "sketch"


def title_from_filename(stem: str) -> str:
    stem = re.sub(r"^\d+[\s._-]+", "", stem)          # drop an ordering prefix like "01-"
    words = re.split(r"[\s._-]+", stem)
    return " ".join(w[:1].upper() + w[1:] for w in words if w) or "Untitled"


def read_svg(path: Path):
    """Return (title or None, width, height) — size from viewBox, else width/height."""
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        raise ValueError(f"not valid SVG/XML ({e})")
    if root.tag not in (f"{SVG_NS}svg", "svg"):
        raise ValueError("root element is not <svg>")
    title = None
    for el in root:
        if el.tag in (f"{SVG_NS}title", "title") and (el.text or "").strip():
            title = el.text.strip()
            break
    w = h = None
    vb = root.get("viewBox")
    if vb:
        parts = re.split(r"[\s,]+", vb.strip())
        if len(parts) == 4:
            w, h = float(parts[2]), float(parts[3])
    if not w or not h:
        num = lambda v: float(re.match(r"[\d.]+", v).group()) if v and re.match(r"[\d.]+", v) else None
        w, h = num(root.get("width")), num(root.get("height"))
    return title, (w or 1), (h or 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--folder", default="sketches", help="folder with your SVGs (default: sketches)")
    ap.add_argument("--sort", choices=["newest", "oldest", "name"], default="newest")
    args = ap.parse_args()

    folder = (HERE / args.folder).resolve()
    if not folder.is_dir():
        sys.exit(f"Folder not found: {folder}")

    files = sorted(p for p in folder.rglob("*") if p.suffix.lower() == ".svg" and p.is_file())
    items, seen, skipped = [], set(), []
    for p in files:
        try:
            title, w, h = read_svg(p)
        except Exception as e:  # noqa: BLE001 — report and keep going
            skipped.append(f"{p.name}: {e}")
            continue
        slug = base = slugify(p.stem)
        n = 2
        while slug in seen:
            slug = f"{base}-{n}"; n += 1
        seen.add(slug)
        mtime = p.stat().st_mtime
        items.append({
            "slug": slug,
            "title": title or title_from_filename(p.stem),
            "file": p.relative_to(HERE).as_posix(),
            "aspect": round(w / h, 4),
            "date": datetime.fromtimestamp(mtime, timezone.utc).strftime("%Y-%m-%d"),
            "_mtime": mtime,
            "_name": p.name.lower(),
        })

    if args.sort == "name":
        items.sort(key=lambda i: i["_name"])
    else:
        items.sort(key=lambda i: i["_mtime"], reverse=(args.sort == "newest"))
    for i in items:
        del i["_mtime"], i["_name"]

    out = HERE / "sketches.json"
    out.write_text(json.dumps({"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                               "sketches": items}, indent=2), encoding="utf-8")
    print(f"Wrote {out.name}: {len(items)} sketch{'es' if len(items) != 1 else ''}.")
    for i in items:
        print(f"  • {i['title']}  ({i['file']})")
    for s in skipped:
        print(f"  ! skipped {s}")


if __name__ == "__main__":
    main()
