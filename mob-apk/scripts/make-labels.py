"""Demo stock labels for the Pune demo data (demo-data/aria-demo-pune.csv): QR codes that are label links,
aria://label?product=...&lot=...&qty=...&exp=...&depot=..., so a phone camera or Google Lens opens ARIA at the label's
check (the in-app scanner reads them too). Writes one PNG per label, with its caption printed under the code, and
labels.html to print or show on a screen.

Usage: pip install segno pillow; python scripts/make-labels.py [out_dir]   (default: ../demo-data/labels)
"""
import html
import sys
from pathlib import Path
from urllib.parse import urlencode

import segno
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'demo-data' / 'labels'

# (file, title, what ARIA does, label fields) - the same cases as the first labels (D-044)
LABELS = [
    ('1-new-milk-hadapsar', 'New milk delivery at Hadapsar', 'Everything is on the label. Tap "Add to the list".',
     {'product': 'MILK_1L', 'lot': 'PUN-MILK-1101', 'qty': 600, 'exp': '2026-10-29', 'depot': 'D_HADAPSAR'}),
    ('2-new-bread-hinjewadi', 'New bread delivery at Hinjewadi', 'Everything is on the label. Tap "Add to the list".',
     {'product': 'BREAD_400G', 'lot': 'PUN-BRD-7781', 'qty': 500, 'exp': '2026-10-29', 'depot': 'D_HINJEWADI'}),
    ('3-paneer-product-number', 'Paneer pack with a product number', 'New product number: choose PANEER_200G once and ARIA remembers it. Choose the depot.',
     {'gtin': '08901234000017', 'lot': 'PNR2610', 'qty': 150, 'exp': '2026-11-04'}),
    ('4-atta-missing-details', 'Atta label with only product and lot', 'ARIA asks for the depot, units and expiry date.',
     {'product': 'ATTA_5KG', 'lot': 'PUN-ATT-5512'}),
    ('5-recount-chakan-milk', 'Recount of a lot already in stock', 'Product, depot and expiry come from your stock. Type the new count.',
     {'lot': 'L62-D_CHAKAN-MILK_1L'}),
    ('6-expired-curd', 'Expired curd (refused)', 'ARIA refuses it: the lot expired on 20 Oct 2026.',
     {'product': 'CURD_400G', 'lot': 'PUN-CRD-0921', 'qty': 200, 'exp': '2026-10-20', 'depot': 'D_CHAKAN'}),
    ('7-unknown-product', 'Product not in your list (refused until fixed)', 'GHEE_1L is not in the product list: choose a product or add it to your data first.',
     {'product': 'GHEE_1L', 'lot': 'PUN-GHE-0007', 'qty': 50, 'exp': '2027-03-01', 'depot': 'D_CHAKAN'}),
    ('8-wrong-expiry', 'Milk with an impossible expiry date (refused)', 'Milk keeps 3 days, but the label says 2027.',
     {'product': 'MILK_1L', 'lot': 'PUN-MILK-1102', 'qty': 300, 'exp': '2027-01-15', 'depot': 'D_CHAKAN'}),
]

link = lambda fields: 'aria://label?' + urlencode(fields)


def font(size):
    for name in ('segoeui.ttf', 'arial.ttf', 'DejaVuSans.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def png(path, title, text):
    """The QR code, large with a wide quiet zone (easy for any camera), and the title and link printed under it."""
    qr = segno.make(text, error='m')
    tmp = path.with_suffix('.qr.png')
    qr.save(tmp, scale=12, border=4)
    code = Image.open(tmp).convert('RGB')
    tmp.unlink()
    w = code.width
    big, small = font(26), font(15)
    lines, line = [], ''
    for part in text.replace('&', ' &').split(' '):  # wrap the link at its fields
        if line and len(line + part) > 52:
            lines.append(line)
            line = part.lstrip()
        else:
            line += part
    lines.append(line)
    out = Image.new('RGB', (w, code.height + 50 + 22 * len(lines) + 16), 'white')
    out.paste(code, (0, 0))
    d = ImageDraw.Draw(out)
    d.text((w // 2, code.height + 6), title, fill='black', font=big, anchor='ma')
    for i, l in enumerate(lines):
        d.text((w // 2, code.height + 48 + 22 * i), l, fill='#555', font=small, anchor='ma')
    out.save(path, optimize=True)


OUT.mkdir(parents=True, exist_ok=True)
cards = []
for name, title, what, fields in LABELS:
    text = link(fields)
    png(OUT / f'{name}.png', title, text)
    svg = segno.make(text, error='m').svg_inline(scale=6, border=4)
    cards.append(f'<figure><div class="qr">{svg}</div><figcaption><b>{html.escape(title)}</b><br><span>{html.escape(what)}</span>'
                 f'<code>{html.escape(text)}</code></figcaption></figure>')

(OUT / 'labels.html').write_text(f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ARIA demo labels</title>
<style>body{{font:15px system-ui,sans-serif;margin:24px;color:#111;background:#fff}}h1{{font-size:20px}}p{{color:#444;max-width:760px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}}figure{{margin:0;border:1px solid #ddd;border-radius:12px;padding:14px;break-inside:avoid}}
.qr svg{{width:100%;height:auto;max-width:240px;display:block;margin:auto}}figcaption{{margin-top:8px;font-size:13px}}figcaption span{{color:#555}}
code{{display:block;margin-top:6px;font-size:11px;color:#666;word-break:break-all}}@media print{{body{{margin:8mm}}}}</style></head><body>
<h1>ARIA demo stock labels (Pune demo data)</h1>
<p>On the admin's phone, load <b>aria-demo-pune.csv</b> and tap <b>Plan tonight</b>. Then point the <b>phone camera</b> (or Google Lens) at a label
and tap the link: ARIA opens at <b>Scan stock labels</b> with the label's details filled in. <b>Scan labels</b> on Home reads them too.
Add labels 1 to 5, tap <b>Update stock and plan again</b> and ARIA shows the new plan against the old one. Labels 6 to 8 show what it refuses.</p>
<div class="grid">{"".join(cards)}</div></body></html>
''', encoding='utf-8')
print(f'{len(LABELS)} labels in {OUT}')
