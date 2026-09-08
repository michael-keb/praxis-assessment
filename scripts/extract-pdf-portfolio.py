#!/usr/bin/env python3
"""Render PDF portfolio pages to web JPEGs for interior-designer sync."""
import os
import subprocess
import sys

import fitz


def main() -> None:
    if len(sys.argv) < 3:
        print("Usage: extract-pdf-portfolio.py <pdf> <out-dir>", file=sys.stderr)
        sys.exit(1)
    pdf_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    for i, page in enumerate(doc):
        zoom = 1400 / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        raw = os.path.join(out_dir, f"{i + 1:02d}.jpg")
        web = os.path.join(out_dir, f"{i + 1:02d}.web.jpg")
        pix.save(raw)
        subprocess.run(
            [
                "sips",
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                "82",
                "-Z",
                "1400",
                raw,
                "--out",
                web,
            ],
            check=True,
        )
        if os.path.exists(raw):
            os.remove(raw)
    print(f"Rendered {doc.page_count} pages → {out_dir}")


if __name__ == "__main__":
    main()
