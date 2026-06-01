"""
Generate Kinnship Play Store graphics.
- store_icon_512.png — 512x512 app icon (Play Store listing)
- store_feature_1024x500.png — Play Store feature graphic

Both designed to match Kinnship brand: deep forest green (#1A4A2E),
white shield with green check, clean professional layout.
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os

OUT_DIR = "/app/store_assets"
os.makedirs(OUT_DIR, exist_ok=True)

GREEN_DEEP = (26, 74, 46)        # #1A4A2E — primary brand
GREEN_BRIGHT = (34, 139, 87)     # for the check stroke
WHITE = (255, 255, 255)
OFF_WHITE = (248, 250, 248)      # icon background — very light, NOT pure white
SHADOW = (0, 0, 0, 40)
INK = (15, 30, 22)

BOLD = "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"
REG = "/usr/share/fonts/truetype/freefont/FreeSans.ttf"


# ---------------------------------------------------------------
# Shield geometry — a classic heater-shield silhouette.
# Coordinates are given as fractions of a target bounding box (0..1)
# so the same vector can be rasterised at any size.
# ---------------------------------------------------------------
SHIELD_PATH = [
    (0.10, 0.05),   # top-left
    (0.90, 0.05),   # top-right
    (0.90, 0.50),   # right shoulder
    (0.86, 0.65),
    (0.78, 0.80),
    (0.62, 0.92),
    (0.50, 0.98),   # bottom point
    (0.38, 0.92),
    (0.22, 0.80),
    (0.14, 0.65),
    (0.10, 0.50),   # left shoulder
]


def shield_polygon(cx: int, cy: int, size: int):
    """Return list of (x, y) tuples for a shield centered at (cx, cy)
    with the given pixel size (bounding box width/height)."""
    half = size / 2
    x0 = cx - half
    y0 = cy - half
    return [(x0 + px * size, y0 + py * size) for (px, py) in SHIELD_PATH]


def draw_check(d: ImageDraw.ImageDraw, cx: int, cy: int, size: int,
               colour=GREEN_DEEP, stroke_w: int = None):
    """Big bold checkmark centered around (cx, cy)."""
    if stroke_w is None:
        stroke_w = max(8, size // 8)
    pts = [
        (cx - size * 0.32, cy + size * 0.02),
        (cx - size * 0.05, cy + size * 0.28),
        (cx + size * 0.38, cy - size * 0.30),
    ]
    d.line([pts[0], pts[1]], fill=colour, width=stroke_w)
    d.line([pts[1], pts[2]], fill=colour, width=stroke_w)
    # Rounded line caps
    r = stroke_w // 2
    for (px, py) in pts:
        d.ellipse([px - r, py - r, px + r, py + r], fill=colour)


# ===============================================================
#  ICON  —  512 x 512
# ===============================================================
def make_icon(out_path: str):
    W = H = 1024  # render at 2x then downscale for crispness
    img = Image.new("RGB", (W, H), OFF_WHITE)
    d = ImageDraw.Draw(img)

    # Subtle vertical gradient on background to add depth without
    # making the icon look "transparent" or cluttered.
    for y in range(H):
        t = y / H
        r = int(OFF_WHITE[0] - 6 * t)
        g = int(OFF_WHITE[1] - 4 * t)
        b = int(OFF_WHITE[2] - 6 * t)
        d.line([(0, y), (W, y)], fill=(r, g, b))

    # Shield placement — center, occupying ~60% of the canvas height,
    # leaving room for the wordmark at the bottom.
    shield_size = int(W * 0.62)
    shield_cx = W // 2
    shield_cy = int(H * 0.45)

    # Drop shadow under the shield (soft, low opacity)
    shadow_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow_layer)
    sd.polygon(
        shield_polygon(shield_cx, shield_cy + 14, shield_size),
        fill=(0, 0, 0, 65),
    )
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=18))
    img.paste(shadow_layer, (0, 0), shadow_layer)

    # Shield body — solid forest green
    d.polygon(
        shield_polygon(shield_cx, shield_cy, shield_size),
        fill=GREEN_DEEP,
    )

    # Inner highlight (slightly lighter green at top to give dimension)
    highlight_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(highlight_layer)
    hd.polygon(
        shield_polygon(shield_cx, shield_cy, shield_size),
        fill=(255, 255, 255, 22),
    )
    # Mask the lower half so highlight only appears on top portion
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    md.rectangle([0, 0, W, int(H * 0.45)], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=40))
    highlight_layer.putalpha(
        Image.eval(mask, lambda v: v // 5)  # very subtle
    )
    img.paste(highlight_layer, (0, 0), highlight_layer)

    # White checkmark inside the shield
    draw_check(
        d,
        cx=shield_cx,
        cy=shield_cy + int(shield_size * 0.02),
        size=int(shield_size * 0.46),
        colour=WHITE,
        stroke_w=max(28, shield_size // 12),
    )

    # "Kinnship" wordmark below the shield
    try:
        font_word = ImageFont.truetype(BOLD, size=int(W * 0.13))
    except Exception:
        font_word = ImageFont.load_default()
    word = "Kinnship"
    # text bounding box
    bb = d.textbbox((0, 0), word, font=font_word)
    tw = bb[2] - bb[0]
    th = bb[3] - bb[1]
    tx = (W - tw) // 2 - bb[0]
    ty = int(H * 0.79) - bb[1]
    d.text((tx, ty), word, font=font_word, fill=GREEN_DEEP)

    # Down-scale 2x → final 512x512 with antialiasing
    img = img.resize((512, 512), Image.LANCZOS)
    img.save(out_path, "PNG", optimize=True)
    print(f"✓ icon saved: {out_path}")


# ===============================================================
#  FEATURE GRAPHIC  —  1024 x 500
# ===============================================================
def make_feature(out_path: str):
    W, H = 2048, 1000  # 2x render then downscale
    img = Image.new("RGB", (W, H), GREEN_DEEP)
    d = ImageDraw.Draw(img)

    # Subtle radial light at top-left for depth
    radial = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(radial)
    rd.ellipse([-300, -300, 1100, 1100],
               fill=(64, 128, 80, 80))
    radial = radial.filter(ImageFilter.GaussianBlur(radius=120))
    img.paste(radial, (0, 0), radial)

    # ----- LEFT: shield -----
    shield_size = int(H * 0.62)
    shield_cx = int(W * 0.16)
    shield_cy = int(H * 0.50)

    # Shield drop shadow
    shadow_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow_layer)
    sd.polygon(
        shield_polygon(shield_cx, shield_cy + 16, shield_size),
        fill=(0, 0, 0, 110),
    )
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=22))
    img.paste(shadow_layer, (0, 0), shadow_layer)

    # White shield body (since background is dark green)
    d.polygon(
        shield_polygon(shield_cx, shield_cy, shield_size),
        fill=WHITE,
    )

    # Green checkmark inside
    draw_check(
        d,
        cx=shield_cx,
        cy=shield_cy + int(shield_size * 0.02),
        size=int(shield_size * 0.46),
        colour=GREEN_DEEP,
        stroke_w=max(24, shield_size // 13),
    )

    # ----- CENTER-LEFT: wordmark + tagline -----
    try:
        font_brand = ImageFont.truetype(BOLD, size=190)
        font_tag = ImageFont.truetype(BOLD, size=64)
    except Exception:
        font_brand = ImageFont.load_default()
        font_tag = ImageFont.load_default()

    brand_x = int(W * 0.31)
    brand_y = int(H * 0.27)
    d.text((brand_x, brand_y), "Kinnship", font=font_brand, fill=WHITE)

    tag_x = brand_x + 4
    tag_y = brand_y + 230
    d.text(
        (tag_x, tag_y),
        "Always There.",
        font=font_tag, fill=(220, 235, 226),
    )
    d.text(
        (tag_x, tag_y + 80),
        "Even When You Can't Be.",
        font=font_tag, fill=(220, 235, 226),
    )

    # ----- RIGHT: subtle phone mockup -----
    phone_w = int(W * 0.24)
    phone_h = int(phone_w * 2.05)
    phone_x = int(W * 0.73)
    phone_y = (H - phone_h) // 2

    # Phone shadow
    pshadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    psd = ImageDraw.Draw(pshadow)
    psd.rounded_rectangle(
        [phone_x - 6, phone_y + 18,
         phone_x + phone_w + 6, phone_y + phone_h + 30],
        radius=72,
        fill=(0, 0, 0, 140),
    )
    pshadow = pshadow.filter(ImageFilter.GaussianBlur(radius=28))
    img.paste(pshadow, (0, 0), pshadow)

    # Phone body — dark frame
    d.rounded_rectangle(
        [phone_x, phone_y, phone_x + phone_w, phone_y + phone_h],
        radius=72, fill=(20, 32, 26),
    )
    # Inner bezel
    bezel = 18
    d.rounded_rectangle(
        [phone_x + bezel, phone_y + bezel,
         phone_x + phone_w - bezel, phone_y + phone_h - bezel],
        radius=54, fill=(245, 248, 246),
    )

    # Top notch
    notch_w = phone_w // 3
    notch_h = 26
    notch_x = phone_x + (phone_w - notch_w) // 2
    notch_y = phone_y + 22
    d.rounded_rectangle(
        [notch_x, notch_y, notch_x + notch_w, notch_y + notch_h],
        radius=14, fill=(20, 32, 26),
    )

    # Phone screen content — mini "family dashboard" mockup
    # Header bar
    hx0 = phone_x + bezel + 24
    hx1 = phone_x + phone_w - bezel - 24
    hy = phone_y + 110
    d.text((hx0, hy), "Family", font=ImageFont.truetype(BOLD, size=52), fill=GREEN_DEEP)
    # Status pill (top right)
    pill_w, pill_h = 130, 44
    px0 = hx1 - pill_w
    py0 = hy + 8
    d.rounded_rectangle(
        [px0, py0, px0 + pill_w, py0 + pill_h],
        radius=22, fill=(220, 245, 230),
    )
    d.ellipse(
        [px0 + 14, py0 + 14, px0 + 30, py0 + 30],
        fill=(34, 139, 87),
    )
    try:
        pill_font = ImageFont.truetype(BOLD, size=22)
    except Exception:
        pill_font = ImageFont.load_default()
    d.text((px0 + 38, py0 + 10), "All Safe", font=pill_font, fill=(20, 80, 50))

    # Member rows (3 of them)
    rows_y = phone_y + 220
    row_h = 130
    avatars = [
        ("Mom",   "Home · 2 min ago",   (255, 198, 88)),
        ("Dad",   "Walking · 8 min ago", (88, 165, 255)),
        ("Grandma", "Home · just now",   (255, 130, 165)),
    ]
    for i, (name, sub, av_color) in enumerate(avatars):
        ry = rows_y + i * row_h
        # Row background
        d.rounded_rectangle(
            [hx0 - 10, ry, hx1 + 10, ry + row_h - 18],
            radius=24, fill=WHITE,
        )
        # Avatar circle
        av_r = 38
        av_cx = hx0 + av_r + 8
        av_cy = ry + (row_h - 18) // 2
        d.ellipse(
            [av_cx - av_r, av_cy - av_r,
             av_cx + av_r, av_cy + av_r],
            fill=av_color,
        )
        # Initials
        try:
            init_font = ImageFont.truetype(BOLD, size=32)
            name_font = ImageFont.truetype(BOLD, size=34)
            sub_font  = ImageFont.truetype(REG,  size=24)
        except Exception:
            init_font = name_font = sub_font = ImageFont.load_default()
        init = name[0]
        ib = d.textbbox((0, 0), init, font=init_font)
        d.text(
            (av_cx - (ib[2] - ib[0]) // 2 - ib[0],
             av_cy - (ib[3] - ib[1]) // 2 - ib[1]),
            init, font=init_font, fill=WHITE,
        )
        # Name + sub
        text_x = av_cx + av_r + 22
        d.text((text_x, ry + 24), name, font=name_font, fill=INK)
        d.text((text_x, ry + 64), sub, font=sub_font, fill=(110, 130, 120))
        # Green status dot on right
        sdx = hx1 - 18
        sdy = av_cy
        sr = 12
        d.ellipse([sdx - sr, sdy - sr, sdx + sr, sdy + sr],
                  fill=(34, 139, 87))

    # SOS button at the bottom of the screen
    sos_y = phone_y + phone_h - bezel - 130
    sos_x0 = phone_x + bezel + 28
    sos_x1 = phone_x + phone_w - bezel - 28
    d.rounded_rectangle(
        [sos_x0, sos_y, sos_x1, sos_y + 96],
        radius=48, fill=(220, 38, 38),
    )
    try:
        sos_font = ImageFont.truetype(BOLD, size=46)
    except Exception:
        sos_font = ImageFont.load_default()
    sbb = d.textbbox((0, 0), "SOS", font=sos_font)
    d.text(
        ((sos_x0 + sos_x1) // 2 - (sbb[2] - sbb[0]) // 2 - sbb[0],
         sos_y + 48 - (sbb[3] - sbb[1]) // 2 - sbb[1]),
        "SOS", font=sos_font, fill=WHITE,
    )

    # ----- BOTTOM-LEFT footer mark -----
    try:
        foot_font = ImageFont.truetype(BOLD, size=34)
    except Exception:
        foot_font = ImageFont.load_default()
    d.text((int(W * 0.31), int(H * 0.84)), "Family safety. Senior wellness.",
           font=foot_font, fill=(180, 210, 192))

    # Down-scale to 1024 × 500
    img = img.resize((1024, 500), Image.LANCZOS)
    img.save(out_path, "PNG", optimize=True)
    print(f"✓ feature saved: {out_path}")


if __name__ == "__main__":
    make_icon(os.path.join(OUT_DIR, "store_icon_512.png"))
    make_feature(os.path.join(OUT_DIR, "store_feature_1024x500.png"))
    print("\nFiles ready in:", OUT_DIR)
