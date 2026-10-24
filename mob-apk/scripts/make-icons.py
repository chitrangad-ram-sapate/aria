"""Builds every app icon and splash screen from the ARIA logo (assets/logo-source.png).

Usage: python scripts/make-icons.py   (Pillow). Writes Android mipmaps and splashes, the iOS app icon and splash,
public/ web icons and the in-app logo. The artwork (A, globe, truck, wordmark) is cut from its white tile and
re-placed on white at each size, inside the safe zone Android's adaptive icons need.
"""
import glob
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

APP = Path(__file__).resolve().parents[1]
SRC = APP / 'assets' / 'logo-source.png'
RES = APP / 'android' / 'app' / 'src' / 'main' / 'res'
WHITE = (255, 255, 255, 255)


def artwork() -> Image.Image:
    """The logo cut out to its ink, with white turned transparent (anti-aliased edges kept)."""
    im = Image.open(SRC).convert('RGB')
    # ink = clearly darker or bluer than the white tile and its pale glow
    r, g, b = im.split()
    ink = ImageChops.darker(ImageChops.darker(r, g), b).point(lambda v: 255 if v < 200 else 0)
    box = ink.getbbox()
    art = im.crop(box).convert('RGBA')
    # alpha from distance to white so edges blend on any background
    px = art.load()
    for y in range(art.height):
        for x in range(art.width):
            cr, cg, cb, _ = px[x, y]
            a = 255 - min(cr, cg, cb)
            a = 0 if a < 18 else min(255, int(a * 1.6))
            px[x, y] = (cr, cg, cb, a)
    return art


def place(art: Image.Image, size: tuple[int, int], fill: float, bg=WHITE) -> Image.Image:
    """art scaled to `fill` of the shorter side, centred on a canvas of `size`."""
    w, h = size
    s = fill * min(w, h) / max(art.width, art.height)
    a = art.resize((max(1, round(art.width * s)), max(1, round(art.height * s))), Image.LANCZOS)
    out = Image.new('RGBA', size, bg)
    out.alpha_composite(a, ((w - a.width) // 2, (h - a.height) // 2))
    return out


def main():
    art = artwork()
    # Android: legacy square and round icons, adaptive foreground (art inside the 66/108 safe zone)
    for d, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
        place(art, (px, px), 0.78).convert('RGB').save(RES / f'mipmap-{d}' / 'ic_launcher.png')
        rnd = place(art, (px, px), 0.66)
        mask = Image.new('L', (px, px), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, px - 1, px - 1), fill=255)
        rnd.putalpha(mask)
        rnd.save(RES / f'mipmap-{d}' / 'ic_launcher_round.png')
        fg = px * 108 // 48
        place(art, (fg, fg), 0.56, (0, 0, 0, 0)).save(RES / f'mipmap-{d}' / 'ic_launcher_foreground.png')
    for f in glob.glob(str(RES / '*' / 'splash.png')):
        w, h = Image.open(f).size
        place(art, (w, h), 0.42).convert('RGB').save(f)
    # iOS
    ios = APP / 'ios' / 'App' / 'App' / 'Assets.xcassets'
    place(art, (1024, 1024), 0.78).convert('RGB').save(ios / 'AppIcon.appiconset' / 'AppIcon-512@2x.png')
    for f in glob.glob(str(ios / 'Splash.imageset' / '*.png')):
        place(art, (2732, 2732), 0.30).convert('RGB').save(f)
    # web and in-app
    pub = APP / 'public'
    for px in (192, 512):
        place(art, (px, px), 0.78).convert('RGB').save(pub / f'icon-{px}.png')
    place(art, (180, 180), 0.78).convert('RGB').save(pub / 'apple-touch-icon.png')
    place(art, (512, 512), 0.96, (0, 0, 0, 0)).save(pub / 'logo.png')
    print('icons written')


if __name__ == '__main__':
    main()
