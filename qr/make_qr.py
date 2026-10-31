"""Discord invite QR codes with the Awake logo in the middle.

    python qr/make_qr.py          (uses assets/awake-logotype.pdf)

Needs: pip install segno pypdfium2 pillow numpy opencv-python-headless zxing-cpp
Writes PNG + PDF for each colourway next to this script, then checks every
file actually decodes back to the invite URL.
"""

import sys
from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium
import segno
import zxingcpp
from PIL import Image, ImageDraw

URL = "https://discord.gg/qKDz6xvwkT"
OUT = Path(__file__).parent

MODULE_PX = 60      # pixels per QR square -> ~2700px image, crisp when printed
QUIET = 4           # blank border, in squares (the QR spec minimum)
LOGO_WIDTH = 0.44   # logo width as a share of the code's width

# (pdf page, colourway name, QR square colour). Background comes from the PDF page itself.
VARIANTS = [
    (0, "light", (0, 0, 0)),
    (2, "orange", (0, 0, 0)),
    (1, "dark", (255, 255, 255)),  # inverted: light squares on black
]


def logo_crop(pdf, page_no):
    img = np.asarray(pdf[page_no].render(scale=6).to_pil().convert("RGB"))
    bg = img[5, 5].astype(int)
    h = img.shape[0]
    # Ignore the bottom quarter: page 0 has a colour swatch + CMYK notes there.
    diff = np.abs(img[: int(h * 0.75)].astype(int) - bg).max(axis=2) > 40
    ys, xs = np.nonzero(diff)
    return Image.fromarray(img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]), tuple(int(c) for c in bg)


def build(pdf, page_no, fg):
    qr = segno.make(URL, error="h", version=5, boost_error=False)
    n = qr.symbol_size(border=0)[0]
    matrix = qr.matrix

    logo, bg = logo_crop(pdf, page_no)
    aspect = logo.width / logo.height

    # Knock-out area for the logo, in whole squares, centred, with 1 square of padding.
    lw = round(n * LOGO_WIDTH)
    lh = max(1, round(lw / aspect))
    kw, kh = lw + 2, lh + 2
    kw += (n - kw) % 2  # keep it exactly centred
    kh += (n - kh) % 2
    c0, r0 = (n - kw) // 2, (n - kh) // 2
    covered = kw * kh / (n * n)

    size = (n + 2 * QUIET) * MODULE_PX
    img = Image.new("RGB", (size, size), bg)
    draw = ImageDraw.Draw(img)
    for r, row in enumerate(matrix):
        for c, dark in enumerate(row):
            if not dark or (c0 <= c < c0 + kw and r0 <= r < r0 + kh):
                continue
            x, y = (c + QUIET) * MODULE_PX, (r + QUIET) * MODULE_PX
            draw.rectangle([x, y, x + MODULE_PX - 1, y + MODULE_PX - 1], fill=fg)

    target_w = lw * MODULE_PX
    logo = logo.resize((target_w, round(target_w / aspect)), Image.LANCZOS)
    img.paste(logo, ((size - logo.width) // 2, (size - logo.height) // 2))
    return img, n, covered


def decodes(img):
    """Decode with ZXing at several sizes, from full print resolution down to a small, distant print."""
    arr = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2GRAY)
    results = {}
    for px in (img.width, 1200, 600, 300, 200):
        a = cv2.resize(arr, (px, px), interpolation=cv2.INTER_AREA)
        found = zxingcpp.read_barcodes(a, formats=zxingcpp.BarcodeFormat.QRCode)
        text = found[0].text if found else ""
        if text != URL:  # most phone scanners also try the inverted image
            found = zxingcpp.read_barcodes(255 - a, formats=zxingcpp.BarcodeFormat.QRCode)
            text = f"{found[0].text} (inverted)" if found and found[0].text == URL else text
        results[px] = text
    return results


def main():
    pdf = pdfium.PdfDocument(OUT.parent / "assets" / "awake-logotype.pdf")
    ok = True
    for page_no, name, fg in VARIANTS:
        img, n, covered = build(pdf, page_no, fg)
        png, pdf_out = OUT / f"awake-discord-qr-{name}.png", OUT / f"awake-discord-qr-{name}.pdf"
        img.save(png, dpi=(600, 600))
        img.save(pdf_out, resolution=600)  # ~11.4 cm wide at 600 dpi; scales down cleanly
        results = decodes(img)
        print(f"{name:7} {n}x{n} squares, logo covers {covered:.0%} | " + ", ".join(f"{px}px: {t or 'FAILED'}" for px, t in results.items()))
        ok &= all(t.startswith(URL) for t in results.values())
    print("all decode OK" if ok else "SOME FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
