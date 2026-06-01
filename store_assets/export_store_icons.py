"""
Export Kinnship store icons from the OFFICIAL brand logo files.

Sources (existing 512x512 brand artwork, already finished design):
  • /app/frontend/assets/images/kinnship-logo-white.png  (white bg, shield+check+wordmark)
  • /app/frontend/assets/images/kinnship-logo-dark.png   (green bg, shield+check+wordmark)

NOT used (these are the adaptive-icon foreground with safe-zone
padding — wrong proportions for App Store listings):
  • kinnship-adaptive-foreground-1024.png

Three flat-PNG outputs, all RGB (no alpha, no transparency, no
rounded corners — perfect squares only), suitable for direct upload:

  1. store_icon_white_512.png   — 512 ×  512  white bg   (Play Store)
  2. store_icon_white_1024.png  — 1024 × 1024 white bg   (Apple App Store)
  3. store_icon_green_512.png   — 512 ×  512 green bg    (alternate)

The Apple-store 1024×1024 is produced by LANCZOS up-sampling the
512×512 brand master.  The brand artwork is vector-style with sharp
edges + flat fills, so a 2× LANCZOS produces effectively crisp
output — distinguishable from a true 1024 native only under pixel-
peeping. If a higher-res vector master surfaces later, swap the
source path and re-run; everything else is the same.
"""
from PIL import Image
import os

SRC_WHITE = "/app/frontend/assets/images/kinnship-logo-white.png"
SRC_DARK  = "/app/frontend/assets/images/kinnship-logo-dark.png"
OUT_DIR   = "/app/store_assets"
os.makedirs(OUT_DIR, exist_ok=True)


def export(src_path: str, out_size: int, out_path: str):
    """Open a brand master, ensure no alpha, resize if needed, save
    as flat RGB PNG with maximum quality. Both source files are
    already fully opaque RGBA, so .convert('RGB') just drops the
    redundant alpha channel — no transparency artefacts."""
    im = Image.open(src_path).convert("RGB")
    if im.size != (out_size, out_size):
        # LANCZOS — best resampling kernel for our flat-fill vector-
        # style brand artwork.  Up-sample (512→1024) and down-sample
        # (no-op for 512→512) both look clean.
        im = im.resize((out_size, out_size), Image.LANCZOS)
    im.save(out_path, "PNG", optimize=True)
    saved = Image.open(out_path)
    has_alpha = saved.mode in ("RGBA", "LA") or "transparency" in saved.info
    print(f"✓ {os.path.basename(out_path):32s}  "
          f"{saved.size[0]}×{saved.size[1]}  {saved.mode}  "
          f"{'has-alpha' if has_alpha else 'no-alpha'}  "
          f"{os.path.getsize(out_path)//1024} KB")


if __name__ == "__main__":
    # 1. Google Play Store — white background, 512×512
    export(SRC_WHITE, 512,  os.path.join(OUT_DIR, "store_icon_white_512.png"))
    # 2. Apple App Store — white background, 1024×1024
    export(SRC_WHITE, 1024, os.path.join(OUT_DIR, "store_icon_white_1024.png"))
    # 3. Alternate — green background, 512×512
    export(SRC_DARK,  512,  os.path.join(OUT_DIR, "store_icon_green_512.png"))
    print("\nAll exports written to:", OUT_DIR)
