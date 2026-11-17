"""Icons for Emkay's skills, in the style of Emkay's own logo (web/icon.svg):
a black rounded square, white strokes, the two eyes (a grey ring with a
white arc on top) and the smile. Each skill puts the face on its own motif.

    python tools/make_icons.py   writes build/icons/<name>.svg and .png (512 px,
                                 for the skills' repos) and web/menu/*.svg
                                 (the ones Emkay's own menu shows)
"""
import math
import subprocess
from pathlib import Path

BG = '<rect width="512" height="512" rx="96" fill="#000"/>'


def face(cx, cy, gap, r, mouth_y, mouth_w, width=26):
    """Emkay's eyes and smile around (cx, cy)."""
    eyes = "".join(
        f'<circle cx="{x}" cy="{cy}" r="{r}" stroke="#555"/>'
        f'<path d="M{x - r} {cy}a{r} {r} 0 0 1 {2 * r} 0" stroke="#fff"/>'
        for x in (cx - gap, cx + gap))
    smile = f'<path d="M{cx - mouth_w} {mouth_y}q{mouth_w} {mouth_w * 0.7:.0f} {2 * mouth_w} 0" stroke="#fff"/>'
    return f'<g fill="none" stroke-width="{width}" stroke-linecap="round">{eyes}{smile}</g>'


def svg(*parts):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">{BG}{"".join(parts)}</svg>\n'


def gear(cx, cy, r_out, r_in, teeth, tooth=0.42):
    """A gear's outline: `teeth` flat-topped teeth between radius r_in and r_out."""
    pts = []
    step = 2 * math.pi / teeth
    for i in range(teeth):
        a = i * step - math.pi / 2
        half = step * tooth / 2           # half a tooth's width at the top
        for ang, r in ((a - step / 2 + half * 0.3, r_in), (a - half, r_out),
                       (a + half, r_out), (a + step / 2 - half * 0.3, r_in)):
            pts.append(f"{cx + r * math.cos(ang):.1f} {cy + r * math.sin(ang):.1f}")
    return "M" + " L".join(pts) + " Z"


ICONS = {
    # a shield, the face on it
    "guardian": svg(
        '<path d="M256 64 L416 118 V244 Q416 384 256 452 Q96 384 96 244 V118 Z" fill="none" '
        'stroke="#fff" stroke-width="26" stroke-linejoin="round"/>',
        face(256, 226, 58, 34, 318, 48, 22)),
    # a shopping bag with the face on it
    "store": svg(
        '<g fill="none" stroke="#fff" stroke-width="26" stroke-linejoin="round" stroke-linecap="round">'
        '<path d="M116 186 H396 L374 436 Q372 452 356 452 H156 Q140 452 138 436 Z"/>'
        '<path d="M198 186 V150 a58 58 0 0 1 116 0 V186"/></g>',
        face(256, 276, 50, 30, 362, 44, 22)),
    # a screen on a stand, the face on the screen
    "kiosk": svg(
        '<g fill="none" stroke="#fff" stroke-width="26" stroke-linejoin="round" stroke-linecap="round">'
        '<rect x="84" y="88" width="344" height="244" rx="30"/>'
        '<path d="M256 332 V404 M172 424 H340"/></g>',
        face(256, 196, 64, 32, 268, 46, 22)),
    # a gear, the face in it: Emkay's settings
    "settings": svg(
        f'<path d="{gear(256, 256, 196, 160, 8)}" fill="none" stroke="#fff" stroke-width="24" '
        'stroke-linejoin="round"/>',
        face(256, 236, 52, 30, 318, 42, 22)),
    # a phone with the face on its screen and an arrow down onto it: install as an app
    "install": svg(
        '<g fill="none" stroke="#fff" stroke-width="26" stroke-linejoin="round" stroke-linecap="round">'
        '<rect x="150" y="64" width="212" height="384" rx="34"/>'
        '<path d="M228 404 H284"/></g>',
        face(256, 200, 40, 24, 268, 34, 18),
        '<g fill="none" stroke="#22a7f0" stroke-width="26" stroke-linejoin="round" stroke-linecap="round">'
        '<path d="M256 300 V358 M226 330 L256 360 L286 330"/></g>'),
}

#: the ones Emkay's own menu shows (web/menu/), next to its logo (web/icon.svg)
MENU = ("settings", "store", "kiosk", "install", "guardian")

if __name__ == "__main__":
    repo = Path(__file__).resolve().parent.parent
    here = repo / "build" / "icons"
    here.mkdir(parents=True, exist_ok=True)
    for name, text in ICONS.items():
        (here / f"{name}.svg").write_text(text)
        subprocess.run(["magick", "-background", "none", "-density", "300", str(here / f"{name}.svg"),
                        "-resize", "512x512", str(here / f"{name}.png")], check=True)
        print(name)
    menu = repo / "web" / "menu"
    menu.mkdir(exist_ok=True)
    for name in MENU:
        (menu / f"{name}.svg").write_text(ICONS[name])
