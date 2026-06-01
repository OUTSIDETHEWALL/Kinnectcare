"""
v2 — Kinnship store graphics, GREEN-background only.

The white-background master (kinnship-logo-white.png) ships with an
intentionally-asymmetric shield render — the left half is outlined
with a chalk/textured fill while the right half is solid. That looks
"corrupted/half-missing" when blown up to icon size at 512/1024.
The green-background master (kinnship-logo-dark.png) renders the
shield symmetrically and ships at the same 512×512 source size, so
we drop the white path entirely and use the green master for both
the Google Play and Apple App Store icon slots — sized 512 and 1024.

The feature graphic (1024×500) is re-composited so the LEFT side
now embeds the actual green-background brand logo (with its
built-in shield + check + "Kinnship" wordmark) instead of the
synthetic shield I had drawn earlier. The right-side phone mockup
and the supporting tagline are kept.

Outputs:
  • store_icon_green_512.png        — Google Play  (512x512  RGB)
  • store_icon_green_1024.png       — Apple App Store (1024x1024 RGB)
  • store_feature_1024x500.png      — Play Store feature graphic
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os

SRC_DARK = "/app/frontend/assets/images/kinnship-logo-dark.png"  # 512x512 RGBA, fully opaque
OUT_DIR  = "/app/store_assets"
os.makedirs(OUT_DIR, exist_ok=True)

# Sampled from the corner of kinnship-logo-dark.png → (7,40,21)
# We use a slightly lighter forest-green for the feature-graphic
# canvas so the embedded green logo reads as a clean "logo plate"
# rather than blending into the background. Easy on the eyes
# at any zoom.
BG_DEEP = (10, 50, 27)
WHITE = (255, 255, 255)
INK = (15, 30, 22)

BOLD = "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"
REG  = "/usr/share/fonts/truetype/freefont/FreeSans.ttf"


# ===============================================================
# ICON EXPORTS (green logo, flat RGB, no alpha, no rounded corners)
# ===============================================================
def export_icon(out_size: int, out_path: str):
    im = Image.open(SRC_DARK).convert("RGB")
    if im.size != (out_size, out_size):
        im = im.resize((out_size, out_size), Image.LANCZOS)
    im.save(out_path, "PNG", optimize=True)
    saved = Image.open(out_path)
    print(f"✓ {os.path.basename(out_path):32s}  "
          f"{saved.size[0]}×{saved.size[1]}  {saved.mode}  "
          f"{os.path.getsize(out_path)//1024} KB")


# ===============================================================
# FEATURE GRAPHIC — left = real brand logo, right = phone mockup
# ===============================================================
def export_feature(out_path: str):
    # Render at 2x (2048x1000) then downscale for crisp output.
    W, H = 2048, 1000
    img = Image.new("RGB", (W, H), BG_DEEP)
    d = ImageDraw.Draw(img)

    # Subtle radial highlight at top-left, same as v1.
    radial = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(radial)
    rd.ellipse([-300, -300, 1100, 1100], fill=(48, 110, 70, 70))
    radial = radial.filter(ImageFilter.GaussianBlur(radius=130))
    img.paste(radial, (0, 0), radial)

    # ----- LEFT: real brand logo (kinnship-logo-dark.png) -----
    # Render at ~78% of canvas height for prominence.
    logo_size = int(H * 0.78)
    logo = Image.open(SRC_DARK).convert("RGB").resize(
        (logo_size, logo_size), Image.LANCZOS
    )
    # Drop a soft shadow under the logo plate.
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    logo_x = int(W * 0.05)
    logo_y = (H - logo_size) // 2
    sd.rounded_rectangle(
        [logo_x - 6, logo_y + 14,
         logo_x + logo_size + 6, logo_y + logo_size + 26],
        radius=28, fill=(0, 0, 0, 140),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=22))
    img.paste(shadow, (0, 0), shadow)
    img.paste(logo, (logo_x, logo_y))

    # ----- CENTER: tagline (since the logo already says "Kinnship") -----
    # FIT-TO-WIDTH: the second tagline "Even When You Can't Be." is the
    # longest line and previously overflowed past the phone mockup on the
    # right. We now measure both candidate strings at decreasing font
    # sizes until they BOTH fit inside [tag_x, phone_left - margin].
    tag_x = logo_x + logo_size + 56          # tightened 70 → 56 to claw a bit more width
    phone_left_x = int(W * 0.76)             # matches the phone block below
    right_margin = 32                        # safe gap to the phone shadow
    avail_width = phone_left_x - tag_x - right_margin

    line1 = "Always There."
    line2 = "Even When You Can't Be."
    sub   = "Family safety · Senior wellness"

    # Start at the original 76pt and shrink until line2 fits. Floors at
    # 44pt — well above any "looks like fine print" threshold.
    font_tag_big = None
    big_size = 76
    while big_size >= 44:
        try:
            candidate = ImageFont.truetype(BOLD, size=big_size)
        except Exception:
            candidate = ImageFont.load_default()
        bb = ImageDraw.Draw(img).textbbox((0, 0), line2, font=candidate)
        w = bb[2] - bb[0]
        if w <= avail_width:
            font_tag_big = candidate
            break
        big_size -= 4
    if font_tag_big is None:
        font_tag_big = ImageFont.truetype(BOLD, size=44)

    try:
        font_tag_sml = ImageFont.truetype(REG, size=42)
    except Exception:
        font_tag_sml = ImageFont.load_default()

    # Vertically re-center the three text lines as a block (so the
    # reduced font size doesn't leave the bottom looking empty).
    line_h_big = big_size + 18                # leading
    block_h = (line_h_big * 2) + 60 + 50      # two big lines + gap + sub
    tag_y = (H - block_h) // 2 + 4

    d.text((tag_x, tag_y),
           line1, font=font_tag_big, fill=WHITE)
    d.text((tag_x, tag_y + line_h_big),
           line2, font=font_tag_big, fill=WHITE)
    d.text((tag_x, tag_y + line_h_big * 2 + 30),
           sub, font=font_tag_sml, fill=(190, 220, 200))

    # ----- RIGHT: phone mockup -----
    phone_w = int(W * 0.22)
    phone_h = int(phone_w * 2.05)
    phone_x = int(W * 0.76)
    phone_y = (H - phone_h) // 2

    pshadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    psd = ImageDraw.Draw(pshadow)
    psd.rounded_rectangle(
        [phone_x - 6, phone_y + 18,
         phone_x + phone_w + 6, phone_y + phone_h + 30],
        radius=72, fill=(0, 0, 0, 150),
    )
    pshadow = pshadow.filter(ImageFilter.GaussianBlur(radius=28))
    img.paste(pshadow, (0, 0), pshadow)

    # Phone body
    d.rounded_rectangle(
        [phone_x, phone_y, phone_x + phone_w, phone_y + phone_h],
        radius=72, fill=(20, 32, 26),
    )
    bezel = 18
    d.rounded_rectangle(
        [phone_x + bezel, phone_y + bezel,
         phone_x + phone_w - bezel, phone_y + phone_h - bezel],
        radius=54, fill=(245, 248, 246),
    )
    # Top notch
    nw = phone_w // 3
    nh = 26
    nx = phone_x + (phone_w - nw) // 2
    ny = phone_y + 22
    d.rounded_rectangle([nx, ny, nx + nw, ny + nh],
                        radius=14, fill=(20, 32, 26))

    # Screen content — mini family dashboard
    hx0 = phone_x + bezel + 22
    hx1 = phone_x + phone_w - bezel - 22
    hy  = phone_y + 110

    try:
        font_header = ImageFont.truetype(BOLD, size=52)
        font_pill   = ImageFont.truetype(BOLD, size=22)
        font_name   = ImageFont.truetype(BOLD, size=34)
        font_sub    = ImageFont.truetype(REG,  size=24)
        font_init   = ImageFont.truetype(BOLD, size=32)
        font_sos    = ImageFont.truetype(BOLD, size=46)
    except Exception:
        font_header = font_pill = font_name = font_sub = font_init = font_sos = ImageFont.load_default()

    d.text((hx0, hy), "Family", font=font_header, fill=(20, 70, 42))

    # All-safe pill
    pw, ph = 130, 44
    px = hx1 - pw
    py = hy + 8
    d.rounded_rectangle([px, py, px + pw, py + ph],
                        radius=22, fill=(220, 245, 230))
    d.ellipse([px + 14, py + 14, px + 30, py + 30], fill=(34, 139, 87))
    d.text((px + 38, py + 10), "All Safe", font=font_pill, fill=(20, 80, 50))

    # Member rows
    rows_y = phone_y + 220
    row_h = 130
    avatars = [
        ("Mom",     "Home · 2 min ago",   (255, 198, 88)),
        ("Dad",     "Walking · 8 min ago", (88, 165, 255)),
        ("Grandma", "Home · just now",     (255, 130, 165)),
    ]
    for i, (name, sub, av_color) in enumerate(avatars):
        ry = rows_y + i * row_h
        d.rounded_rectangle(
            [hx0 - 10, ry, hx1 + 10, ry + row_h - 18],
            radius=24, fill=WHITE,
        )
        av_r = 38
        av_cx = hx0 + av_r + 8
        av_cy = ry + (row_h - 18) // 2
        d.ellipse([av_cx - av_r, av_cy - av_r,
                   av_cx + av_r, av_cy + av_r],
                  fill=av_color)
        ib = d.textbbox((0, 0), name[0], font=font_init)
        d.text(
            (av_cx - (ib[2] - ib[0]) // 2 - ib[0],
             av_cy - (ib[3] - ib[1]) // 2 - ib[1]),
            name[0], font=font_init, fill=WHITE,
        )
        text_x = av_cx + av_r + 22
        d.text((text_x, ry + 24), name, font=font_name, fill=INK)
        d.text((text_x, ry + 64), sub, font=font_sub, fill=(110, 130, 120))
        sdx, sdy, sr = hx1 - 18, av_cy, 12
        d.ellipse([sdx - sr, sdy - sr, sdx + sr, sdy + sr],
                  fill=(34, 139, 87))

    # SOS button
    sos_y  = phone_y + phone_h - bezel - 130
    sos_x0 = phone_x + bezel + 28
    sos_x1 = phone_x + phone_w - bezel - 28
    d.rounded_rectangle([sos_x0, sos_y, sos_x1, sos_y + 96],
                        radius=48, fill=(220, 38, 38))
    sbb = d.textbbox((0, 0), "SOS", font=font_sos)
    d.text(
        ((sos_x0 + sos_x1) // 2 - (sbb[2] - sbb[0]) // 2 - sbb[0],
         sos_y + 48 - (sbb[3] - sbb[1]) // 2 - sbb[1]),
        "SOS", font=font_sos, fill=WHITE,
    )

    # Final downscale 2048×1000 → 1024×500
    img = img.resize((1024, 500), Image.LANCZOS)
    img.save(out_path, "PNG", optimize=True)
    saved = Image.open(out_path)
    print(f"✓ {os.path.basename(out_path):32s}  "
          f"{saved.size[0]}×{saved.size[1]}  {saved.mode}  "
          f"{os.path.getsize(out_path)//1024} KB")


if __name__ == "__main__":
    export_icon(512,  os.path.join(OUT_DIR, "store_icon_green_512.png"))
    export_icon(1024, os.path.join(OUT_DIR, "store_icon_green_1024.png"))
    export_feature(os.path.join(OUT_DIR, "store_feature_1024x500.png"))
    print("\nDone:", OUT_DIR)
