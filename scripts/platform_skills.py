"""Build the platform skills (plan 44) from Anthropic's document skills.

The four skills (docx, xlsx, pptx, pdf) are taken from ``anthropics/skills`` at
one pinned commit (Apache-2.0 since 2026-11-06) and adapted to this platform:
commands run through ``execute`` in an offline sandbox, the skills sit at
``/platform_skills/<name>/`` (the same path in the agent's filesystem and in the
sandbox box), nothing can be installed, and finished files are handed over with
``present_artifact``. Every change is listed in the skill's ``CHANGES.md`` (the
Apache-2.0 §4(b) notice), and ``SOURCE`` records the upstream commit and a hash
of the adapted tree. The same tree ships in two repos (magenticx's agents image
and the sandbox box); each repo's tests recompute the hash against ``SOURCE``.

The remote skill sync never stores these four in Postgres: a remote skill with
a platform skill's name is catalogued as "a platform skill" (no files, not
addable). When the sync sees that the upstream content changed, it logs
``platform_skill_update_available``; the update is done **locally**, here:

    python scripts/platform_skills.py update [<commit>]    # default: head of main

That clones upstream, rebuilds ``magenticx/agents/harness/skill_registry/platform_skills``
and copies the same bytes to the sibling ``sandbox/box/platform_skills``. Review
the diff, run both repos' tests, release the sandbox first. Lower-level commands:

    python scripts/platform_skills.py build <upstream clone> <commit> <out dir>
    python scripts/platform_skills.py hash <dir>

Every edit asserts it matched, so a re-pin to a commit whose text moved fails
loudly instead of shipping a half-adapted skill.
"""
from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SKILLS = ("docx", "xlsx", "pptx", "pdf")
REPO_URL = "https://github.com/anthropics/skills"
OUT = Path("magenticx/agents/harness/skill_registry/platform_skills")

NOTES = """\
> **Platform notes (mAgenticX).** Run every command with `execute`: a fresh,
> offline sandbox, and the user approves each call, so put the steps of one
> stage in one command. This skill's files are at `/platform_skills/{name}/`, the
> same path inside the sandbox: run its scripts as
> `python3 /platform_skills/{name}/scripts/…`. The working directory is
> `/conversation/output/`. Uploads in `/conversation/input/` are read-only, so copy
> a file to `/conversation/output/` before changing it in place. Nothing can be
> installed (no network): if an import or `require` fails, say what is missing.
> LibreOffice renders and recalculations are slow, so give `execute` a timeout of
> 180 to 300 s for them. Look at rendered pages with `view_image`, and hand the
> finished file to the user with `present_artifact`.

"""

# (file, old, new, expected count). A count of 0 means "at least one".
EDITS: dict[str, list[tuple[str, str, str, int]]] = {
    "docx": [
        ("SKILL.md", "> Script paths below are relative to this skill's directory.",
         "> Script paths below are absolute: `/platform_skills/docx/scripts/…`.", 1),
        ("SKILL.md", "`docx` is preinstalled — do not run `npm install` first; write the script and "
                     "`require('docx')` directly. Only if that require fails: `npm install docx`.",
         "`docx` is preinstalled: write the script and `require('docx')` directly (nothing can be installed).", 1),
        ("SKILL.md", "python scripts/", "python3 /platform_skills/docx/scripts/", 0),
        ("SKILL.md", "ls page-*.jpg   # then Read the images", "ls page-*.jpg   # then open each image with view_image", 1),
        ("SKILL.md", "`docx` (npm, preinstalled — install only if `require('docx')` fails)", "`docx` (npm, preinstalled)", 1),
    ],
    "xlsx": [
        ("SKILL.md", "`markitdown file.xlsx` — `## SheetName` per sheet; reads `.xlsm` too.",
         "`python3 -c \"import sys, pandas as pd; [print(f'## {n}', d.head(40).to_string(), sep='\\n') "
         "for n, d in pd.read_excel(sys.argv[1], sheet_name=None).items()]\" file.xlsx` — `## SheetName` per sheet; "
         "reads `.xlsm` too.", 1),
        ("SKILL.md", "> `openpyxl`, `pandas`, and `markitdown` are preinstalled — do not run `pip install` first; write "
                     "the script and import directly. Only if an import fails (or the `markitdown` command is missing): "
                     "`pip install` the missing package.",
         "> `openpyxl` and `pandas` are preinstalled: write the script and import directly (nothing can be installed).", 1),
        ("SKILL.md", "> Script paths below are relative to this skill's directory.",
         "> Script paths below are absolute: `/platform_skills/xlsx/scripts/…`.", 1),
        ("SKILL.md", "python scripts/", "python3 /platform_skills/xlsx/scripts/", 0),
        ("SKILL.md", "`openpyxl`, `pandas`, `markitdown` (pip, preinstalled — install only if an import fails or the "
                     "command is missing)", "`openpyxl`, `pandas` (pip, preinstalled)", 1),
    ],
    "pptx": [
        ("SKILL.md", "Paths are relative to this skill's directory.",
         "Paths are under `/platform_skills/pptx/`; run the scripts as `python3 /platform_skills/pptx/scripts/…`.", 1),
        ("SKILL.md", "require(\"<this skill's directory>/scripts/apply_theme.js\")",
         "require(\"/platform_skills/pptx/scripts/apply_theme.js\")", 1),
        ("SKILL.md", "LibreOffice wrapper — bare `soffice` hangs in this sandbox",
         "LibreOffice wrapper: a throwaway profile, and links to outside files stripped before rendering", 1),
        ("SKILL.md", "`pptxgenjs` is preinstalled — do not run `npm install` first; write the script and "
                     "`require('pptxgenjs')` directly. Only if that require fails: `npm install pptxgenjs`.",
         "`pptxgenjs` is preinstalled: write the script and `require('pptxgenjs')` directly (nothing can be installed).", 1),
        ("SKILL.md", "python scripts/", "python3 /platform_skills/pptx/scripts/", 0),
        ("SKILL.md", " (a subagent works well for this if you have one)", "", 1),
        ("SKILL.md", "are preinstalled — `npm install react-icons react react-dom sharp` only if a require fails)",
         "are preinstalled; nothing can be installed)", 1),
        ("SKILL.md", "**Pass the absolute paths printed above directly to the view tool.**",
         "**Open each path printed above with `view_image`.**", 1),
        ("SKILL.md", "`pptxgenjs` (npm, preinstalled — install only if `require('pptxgenjs')` fails)",
         "`pptxgenjs` (npm, preinstalled)", 1),
    ],
    "pdf": [
        ("SKILL.md", "see REFERENCE.md. If you need to fill out a PDF form, read FORMS.md and follow its instructions.",
         "read `/platform_skills/pdf/REFERENCE.md`. If you need to fill out a PDF form, read "
         "`/platform_skills/pdf/FORMS.md` and follow its instructions.", 1),
        ("SKILL.md", "### pdftk (if available)\n```bash\n# Merge\npdftk file1.pdf file2.pdf cat output merged.pdf\n\n"
                     "# Split\npdftk input.pdf burst\n\n# Rotate\npdftk input.pdf rotate 1east output rotated.pdf\n```\n\n",
         "", 1),
        ("SKILL.md", "### Extract Text from Scanned PDFs\n```python\n# Requires: pip install pytesseract pdf2image\n"
                     "import pytesseract\nfrom pdf2image import convert_from_path\n\n# Convert PDF to images\n"
                     "images = convert_from_path('scanned.pdf')\n\n# OCR each page\ntext = \"\"\n"
                     "for i, image in enumerate(images):\n    text += f\"Page {i+1}:\\n\"\n"
                     "    text += pytesseract.image_to_string(image)\n    text += \"\\n\\n\"\n\nprint(text)\n```\n",
         "### Extract Text from Scanned PDFs\nOCR is not available on this platform. If `pdftotext` and pdfplumber "
         "find no text, tell the user the PDF is scanned; you can still render pages with `pdftoppm` and look at "
         "them with `view_image`.\n", 1),
        ("SKILL.md", "| OCR scanned PDFs | pytesseract | Convert to image first |",
         "| OCR scanned PDFs | not available here | Render pages and look at them |", 1),
        ("SKILL.md", "see FORMS.md", "see `/platform_skills/pdf/FORMS.md`", 1),
        ("SKILL.md", "- For advanced pypdfium2 usage, see REFERENCE.md\n- For JavaScript libraries (pdf-lib), see REFERENCE.md\n"
                     "- If you need to fill out a PDF form, follow the instructions in FORMS.md\n"
                     "- For troubleshooting guides, see REFERENCE.md",
         "- For advanced pypdfium2 usage, read `/platform_skills/pdf/REFERENCE.md`\n"
         "- For JavaScript libraries (pdf-lib), read `/platform_skills/pdf/REFERENCE.md`\n"
         "- If you need to fill out a PDF form, follow the instructions in `/platform_skills/pdf/FORMS.md`\n"
         "- For troubleshooting guides, read `/platform_skills/pdf/REFERENCE.md`", 1),
        ("FORMS.md", "python scripts/", "python3 /platform_skills/pdf/scripts/", 0),
        ("FORMS.md", "- Run this script from this file's directory: ", "- Run: ", 1),
        ("FORMS.md", " Run this script from this file's directory:", " Run:", 1),
        ("FORMS.md", " with this script (run from this file's directory):", " with this script:", 1),
        ("FORMS.md", "- Run the `fill_fillable_fields.py` script from this file's directory to create a filled-in PDF:",
         "- Run the `fill_fillable_fields.py` script to create a filled-in PDF:", 1),
        ("FORMS.md", "**Create a zoomed crop using ImageMagick:**\n```bash\n"
                     "magick <page_image> -crop <width>x<height>+<x>+<y> +repage <crop_output.png>\n```",
         "**Create a zoomed crop with Pillow:**\n```bash\npython3 -c \"import sys; from PIL import Image; "
         "x, y, w, h = map(int, sys.argv[3:7]); Image.open(sys.argv[1]).crop((x, y, x + w, y + h)).save(sys.argv[2])\" "
         "<page_image> <crop_output.png> <x> <y> <width> <height>\n```", 1),
        ("FORMS.md", "```bash\nmagick images_dir/page_1.png -crop 300x80+50+120 +repage crops/name_field.png\n```\n\n"
                     "(Note: if the `magick` command isn't available, try `convert` with the same arguments).",
         "```bash\npython3 -c \"import sys; from PIL import Image; x, y, w, h = map(int, sys.argv[3:7]); "
         "Image.open(sys.argv[1]).crop((x, y, x + w, y + h)).save(sys.argv[2])\" "
         "images_dir/page_1.png crops/name_field.png 50 120 300 80\n```", 1),
        ("REFERENCE.md", "# PDF Processing Advanced Reference\n",
         "# PDF Processing Advanced Reference\n\n> **Platform notes (mAgenticX).** `pdfjs-dist` and OCR (`pytesseract`) "
         "are not available here. Node scripts that use `import` must be saved as `.mjs`; packages are found without "
         "installing.\n", 1),
        # One page at a time: pdf2image spools ~11 MB of PPM per page at 200 dpi
        # into the box's 64 MiB /tmp, so a whole document at once overflows it.
        ("scripts/convert_pdf_to_images.py",
         "from pdf2image import convert_from_path\n",
         "from pdf2image import convert_from_path, pdfinfo_from_path\n", 1),
        ("scripts/convert_pdf_to_images.py",
         "    images = convert_from_path(pdf_path, dpi=200)\n\n    for i, image in enumerate(images):\n",
         "    # Modified by mAgenticX: one page at a time, so the sandbox's small /tmp holds it.\n"
         "    pages = pdfinfo_from_path(pdf_path)[\"Pages\"]\n\n"
         "    for i in range(pages):\n"
         "        image = convert_from_path(pdf_path, dpi=200, first_page=i + 1, last_page=i + 1)[0]\n", 1),
        ("scripts/convert_pdf_to_images.py",
         "    print(f\"Converted {len(images)} pages to PNG images\")",
         "    print(f\"Converted {pages} pages to PNG images\")", 1),
    ],
}

CHANGES = """\
# Changes made by mAgenticX

This skill is Anthropic's `{name}` skill from {repo} at commit `{commit}`,
licensed under the Apache License 2.0 (`LICENSE.txt`, unchanged). mAgenticX
modified it to run on its platform (plan 44); the files below differ from
upstream. Generated by `scripts/platform_skills.py`.

- `SKILL.md`: a "Platform notes" block after the front matter (commands run
  through `execute` in an offline sandbox, absolute script paths under
  `/platform_skills/{name}/`, nothing installable, `view_image`,
  `present_artifact`).
{extra}"""


def _apply(text: str, old: str, new: str, expected: int, where: str) -> str:
    count = text.count(old)
    if (expected and count != expected) or (not expected and count == 0):
        raise SystemExit(f"{where}: expected {expected or '>=1'} match(es) of {old[:60]!r}, found {count}")
    return text.replace(old, new)


def _add_notes(skill_md: str, name: str) -> str:
    match = re.match(r"---\n.*?\n---\n\n?", skill_md, re.DOTALL)
    if match is None:
        raise SystemExit(f"{name}/SKILL.md: no front matter")
    return skill_md[:match.end()] + NOTES.format(name=name) + skill_md[match.end():]


def tree_hash(root: Path) -> str:
    """sha256 over every file's relative path and bytes (SOURCE excluded).

    Ordered by the path *string*: ``Path`` objects compare case-insensitively on
    Windows and case-sensitively on Linux, so sorting them gives ``SKILL.md`` a
    different place on each and the same tree two hashes.
    """
    digest = hashlib.sha256()
    files = {p.relative_to(root).as_posix(): p for p in root.rglob("*")
             if p.is_file() and p.name != "SOURCE" and "__pycache__" not in p.parts}
    for rel in sorted(files):
        digest.update(rel.encode() + b"\0")
        digest.update(files[rel].read_bytes() + b"\0")
    return digest.hexdigest()


def upstream_ref(upstream: Path, commit: str, name: str) -> str:
    """The skill's upstream content as the remote sync names it
    (``harness.skill_registry.remote.sync.content_ref_for`` over its visible
    blobs), read from git's own tree so a checkout's line endings never matter.
    The sync compares it with what it sees upstream: a difference means "a
    newer upstream version exists, update locally"."""
    listing = subprocess.run(
        ["git", "-C", str(upstream), "ls-tree", "-r", commit, f"skills/{name}/"],
        check=True, capture_output=True, text=True,
    ).stdout
    prefix = f"skills/{name}/"
    entries = []
    for line in listing.splitlines():
        meta, path = line.split("\t", 1)
        _mode, kind, sha = meta.split()
        rel = path[len(prefix):]
        if kind == "blob" and not any(part.startswith(".") for part in rel.split("/")):
            entries.append((rel, sha))
    lines = "\n".join(f"{rel}\0{sha}" for rel, sha in sorted(entries))
    return hashlib.sha256(lines.encode("utf-8")).hexdigest()


def build(upstream: Path, commit: str, out: Path) -> None:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for name in SKILLS:
        shutil.copytree(upstream / "skills" / name, out / name)
        changed: dict[str, None] = {}
        for rel, old, new, expected in EDITS[name]:
            path = out / name / rel
            text = path.read_text(encoding="utf-8")
            path.write_text(_apply(text, old, new, expected, f"{name}/{rel}"), encoding="utf-8", newline="\n")
            if rel != "SKILL.md":
                changed[rel] = None
        skill_md = out / name / "SKILL.md"
        skill_md.write_text(_add_notes(skill_md.read_text(encoding="utf-8"), name), encoding="utf-8", newline="\n")
        extra = "".join(f"- `{rel}`: adapted (see the diff against upstream).\n" for rel in changed)
        (out / name / "CHANGES.md").write_text(
            CHANGES.format(name=name, repo=REPO_URL, commit=commit, extra=extra), encoding="utf-8", newline="\n")
    # Upstream is LF. A CR here means the clone converted line endings (git's
    # autocrlf on Windows): the scripts would carry CRLF to Linux and the tree
    # hash would differ between this checkout and CI's. Refuse to ship that.
    crlf = [p.relative_to(out).as_posix() for p in out.rglob("*")
            if p.is_file() and p.suffix != ".png" and b"\r\n" in p.read_bytes()]
    if crlf:
        raise SystemExit(f"CRLF in {len(crlf)} file(s), e.g. {crlf[:3]}: clone upstream with "
                         "`git -c core.autocrlf=false clone` (the `update` command does)")
    upstream_lines = "".join(f"upstream:{name} {upstream_ref(upstream, commit, name)}\n" for name in SKILLS)
    (out / "SOURCE").write_text(f"repo {REPO_URL}\ncommit {commit}\n{upstream_lines}tree {tree_hash(out)}\n",
                                encoding="utf-8", newline="\n")


def update(commit: str | None) -> None:
    """The local update: fetch upstream (at ``commit``, else the head of main),
    rebuild into this repo and copy the same bytes to the sibling sandbox repo."""
    repo_root = Path(__file__).resolve().parents[1]
    out = repo_root / OUT
    sandbox = repo_root.parent / "sandbox" / "box" / "platform_skills"
    with tempfile.TemporaryDirectory() as tmp:
        upstream = Path(tmp) / "upstream"
        subprocess.run(["git", "-c", "core.autocrlf=false", "clone", "--quiet", f"{REPO_URL}.git", str(upstream)],
                       check=True)
        if commit:
            subprocess.run(["git", "-C", str(upstream), "checkout", "--quiet", commit], check=True)
        resolved = subprocess.run(["git", "-C", str(upstream), "rev-parse", "HEAD"],
                                  check=True, capture_output=True, text=True).stdout.strip()
        build(upstream, resolved, out)
    if sandbox.parent.is_dir():
        if sandbox.exists():
            shutil.rmtree(sandbox)
        shutil.copytree(out, sandbox, ignore=shutil.ignore_patterns("__pycache__"))
        print(f"copied to {sandbox}")
    else:
        print(f"no sandbox repo at {sandbox.parent}: copy {out} there by hand")
    print((out / "SOURCE").read_text(encoding="utf-8"), end="")


def main(argv: list[str]) -> None:
    if len(argv) == 5 and argv[1] == "build":
        build(Path(argv[2]), argv[3], Path(argv[4]))
        print((Path(argv[4]) / "SOURCE").read_text(encoding="utf-8"), end="")
    elif len(argv) in (2, 3) and argv[1] == "update":
        update(argv[2] if len(argv) == 3 else None)
    elif len(argv) == 3 and argv[1] == "hash":
        print(tree_hash(Path(argv[2])))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
