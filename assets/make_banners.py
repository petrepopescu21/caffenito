"""Server banners for the shop status: banner-open.png and banner-closed.png.

    python assets/make_banners.py [--preview]          (uses assets/awake-logotype.pdf)

Needs: pip install pypdfium2 pillow numpy, and the Segoe UI Black font (ships with Windows;
elsewhere point FONT at another heavy sans .ttf).
The source is Discord's recommended 960x540, but the sidebar shows only a wide strip
from the middle (about 2.6:1, so roughly y 85-455) with the server name drawn over the
top of that strip. Everything therefore sits on one line around the vertical centre:
logo on the left, status word on the right. --preview also writes preview-*.png that
mimic that crop and title, to check before publishing.
"""

import sys
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent
W, H = 960, 540
CENTER_Y = 325  # a little below the middle: the server name covers the top of the visible strip
FONT = "C:/Windows/Fonts/seguibl.ttf"  # Segoe UI Black, close to the logo's heavy sans
WORD_SIZE = 132
LOGO_W = 230
GAP = 36

# (pdf page, file, status word, word colour, logo opacity)
VARIANTS = [
    (2, "banner-open.png", "DESCHIS", (0, 0, 0), 1.0),  # black on brand orange, white sun
    (1, "banner-closed.png", "ÎNCHIS", (235, 235, 235), 0.45),  # dimmed logo on black
]


def logo_crop(pdf, page_no):
    img = np.asarray(pdf[page_no].render(scale=6).to_pil().convert("RGB"))
    bg = img[5, 5].astype(int)
    diff = np.abs(img[: int(img.shape[0] * 0.75)].astype(int) - bg).max(axis=2) > 40
    ys, xs = np.nonzero(diff)
    return Image.fromarray(img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]), tuple(int(c) for c in bg)


def build(pdf, page_no, word, color, opacity):
    logo, bg = logo_crop(pdf, page_no)
    banner = Image.new("RGB", (W, H), bg)
    draw = ImageDraw.Draw(banner)
    font = ImageFont.truetype(FONT, WORD_SIZE)

    # Centre on the capital letters, not the accent, so DESCHIS and ÎNCHIS sit at the same height.
    cap = draw.textbbox((0, 0), "H", font=font)
    word_w = draw.textlength(word, font=font)
    logo = logo.resize((LOGO_W, round(LOGO_W * logo.height / logo.width)), Image.LANCZOS)
    if opacity < 1:
        logo = Image.blend(Image.new("RGB", logo.size, bg), logo, opacity)

    # The word's capitals are centred on CENTER_Y; the logo's lettering shares their baseline.
    x = round((W - (LOGO_W + GAP + word_w)) / 2)
    text_y = CENTER_Y - (cap[1] + cap[3]) / 2
    baseline = round(text_y + cap[3])
    banner.paste(logo, (x, baseline - logo.height))
    draw.text((x + LOGO_W + GAP, text_y), word, font=font, fill=color)
    return banner


def preview(banner, name):
    """Roughly what the Discord sidebar shows: a 2.6:1 centre strip with the server name on top."""
    strip_h = round(W / 2.6)
    top = (H - strip_h) // 2
    strip = banner.crop((0, top, W, top + strip_h)).convert("RGBA")
    shade = Image.new("RGBA", strip.size, (0, 0, 0, 0))
    ImageDraw.Draw(shade).rectangle([0, 0, W, 95], fill=(0, 0, 0, 120))
    strip = Image.alpha_composite(strip, shade)
    ImageDraw.Draw(strip).text((60, 30), "Awake Coffee Community", font=ImageFont.truetype(FONT, 40), fill="white")
    strip.convert("RGB").save(OUT / f"preview-{name}")


def main():
    pdf = pdfium.PdfDocument(OUT / "awake-logotype.pdf")
    for page_no, name, word, color, opacity in VARIANTS:
        banner = build(pdf, page_no, word, color, opacity)
        banner.save(OUT / name)
        print("wrote", OUT / name)
        if "--preview" in sys.argv:
            preview(banner, name)


if __name__ == "__main__":
    main()
