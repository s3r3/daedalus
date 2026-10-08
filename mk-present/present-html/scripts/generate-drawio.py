#!/usr/bin/env python3
"""
generate-drawio.py — Generate .drawio (diagrams.net) + .png from flow spec JSON.

Usage:
  python generate-drawio.py cicd_spec.json --output cicd
  # Produces: cicd.drawio + cicd.png
"""

import json, sys, os, uuid, textwrap
from PIL import Image, ImageDraw, ImageFont

# ── Config (per spec: Dark Gray #333333, Light Gray #F5F5F5) ──────
NEUTRAL = "#333333"  # Spec: Dark Gray for lines, borders, text
BLUE = "#1F549C"
ORANGE = "#F57C00"
DARK_GRAY = "#333333"
RED = "#C62828"
BG_LIGHT = "#F5F5F5"

# Drawio dimensions (vector, base resolution)
SLIDE_W, SLIDE_H = 1280, 720
MARGIN = 60
CARD_W = 120
CARD_H = 60
ARROW_W = 40
TOP_Y = 180
FALLBACK_Y = 380
ROW_GAP = 60
ELBOW_DROP = 80

# PNG scale factor (2x = HiDPI / Retina quality)
PNG_SCALE = 2

ACTOR_COLORS = {
    "system": {"fill": BLUE, "border": BLUE, "text": "#FFFFFF"},
    "human":  {"fill": ORANGE, "border": ORANGE, "text": "#FFFFFF"},
    "it":     {"fill": DARK_GRAY, "border": DARK_GRAY, "text": "#FFFFFF"},
}

FALLBACK_ACTOR = {"fill": RED, "border": RED, "text": "#FFFFFF"}


def load_spec(path):
    with open(path) as f:
        return json.load(f)


def gen_id():
    return str(uuid.uuid4())


# ── Drawio XML Generation ───────────────────────────────────────────
def generate_drawio(spec, output_path):
    steps = spec.get("steps", [])
    decision_at = spec.get("decisionAt", [])
    fallback = spec.get("fallback")
    n = len(steps)

    # Layout calc
    total_w = n * CARD_W + (n - 1) * ARROW_W
    start_x = (SLIDE_W - total_w) // 2

    cells = []
    edges = []
    cell_id_map = {}
    next_id = 2  # 0=root, 1=layer

    # Helper
    def add_cell(style, x, y, w, h, label, parent=1):
        nonlocal next_id
        cid = gen_id()
        fill = "#FFFFFF"
        stroke = "#000000"
        font_color = "#000000"
        arc = style.split("rounded=")[1].split(";")[0] if "rounded=" in style else "0"
        cells.append(f'''    <mxCell id="{cid}" value="{label}" style="{style}" vertex="1" parent="{parent}">
      <mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry" />
    </mxCell>''')
        next_id += 1
        return cid

    def add_edge(src, dst, style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;"):
        nonlocal next_id
        eid = gen_id()
        edges.append(f'''    <mxCell id="{eid}" style="{style}" edge="1" parent="1" source="{src}" target="{dst}">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>''')
        next_id += 1
        return eid

    # Pipeline cards
    for i, step in enumerate(steps):
        x = start_x + i * (CARD_W + ARROW_W)
        y = TOP_Y
        actor = step.get("actor", "system")
        ac = ACTOR_COLORS.get(actor, ACTOR_COLORS["system"])
        fill_color = ac["fill"].lstrip("#")
        stroke_color = ac["border"].lstrip("#")
        font_color = ac["text"].lstrip("#")
        label = step["label"]
        style = f"rounded=1;whiteSpace=wrap;html=1;fillColor=#{fill_color};strokeColor=#{stroke_color};fontColor=#{font_color};fontStyle=1;fontSize=11;"
        is_dec = i in decision_at
        if is_dec:
            style += "dashed=1;strokeWidth=2;"
        else:
            style += "strokeWidth=1.5;"
        cid = add_cell(style, x, y, CARD_W, CARD_H, label)
        cell_id_map[f"step_{i}"] = cid

        # Arrow to next step
        if i < n - 1:
            arrow_x = x + CARD_W
            arrow_y = y + CARD_H // 2 - 5
            arrow_style = "endArrow=classic;html=1;rounded=0;strokeWidth=1.5;"
            aid = add_cell(f"endArrow=classic;html=1;shape=arrow;strokeWidth=1.5;strokeColor=#{stroke_color};fillColor=#{stroke_color};",
                           arrow_x, arrow_y, ARROW_W, 10, "", parent=1)
            # Actually, drawio handles arrows better as edge connectors
            # Replace the arrow cell with an edge
            eid = gen_id()
            edges.append(f'''    <mxCell id="{eid}" style="endArrow=classic;html=1;rounded=0;strokeWidth=1.5;strokeColor=#{stroke_color};exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="{cid}">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>''')
            # Actually let me not duplicate the arrow and edge. Let me remove the arrow cell above.
            # Wait, I already appended. Let me restructure.
            # Remove the last cell (the arrow) and use edge instead
            if cells:
                cells.pop()

    # Now rebuild properly without arrow artifacts
    cells.clear()
    edges.clear()
    cell_id_map.clear()
    next_id = 2

    def add_vertex(style, x, y, w, h, label, parent=1):
        nonlocal next_id
        cid = gen_id()
        cells.append(f'''    <mxCell id="{cid}" value="{label}" style="{style}" vertex="1" parent="{parent}">
      <mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry" />
    </mxCell>''')
        next_id += 1
        return cid

    def add_edge_conn(src, dst, style, label=""):
        nonlocal next_id
        eid = gen_id()
        lbl = f'value="{label}" ' if label else ""
        edges.append(f'''    <mxCell id="{eid}" {lbl}style="{style}" edge="1" parent="1" source="{src}" target="{dst}">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>''')
        next_id += 1
        return eid

    # Pipeline cards (rebuild)
    for i, step in enumerate(steps):
        x = start_x + i * (CARD_W + ARROW_W)
        y = TOP_Y
        actor = step.get("actor", "system")
        ac = ACTOR_COLORS.get(actor, ACTOR_COLORS["system"])
        fill_color = ac["fill"].lstrip("#")
        stroke_color = ac["border"].lstrip("#")
        font_color = ac["text"].lstrip("#")
        label = step["label"]
        is_dec = i in decision_at
        sw = "2" if is_dec else "1.5"
        dash = "dashed=1;" if is_dec else ""
        style = f"rounded=1;whiteSpace=wrap;html=1;fillColor=#{fill_color};strokeColor=#{stroke_color};fontColor=#{font_color};fontStyle=1;fontSize=11;strokeWidth={sw};{dash}"
        cid = add_vertex(style, x, y, CARD_W, CARD_H, label)
        cell_id_map[f"step_{i}"] = cid

    # Edges between steps — neutral color
    for i in range(n - 1):
        src = cell_id_map[f"step_{i}"]
        dst = cell_id_map[f"step_{i+1}"]
        add_edge_conn(src, dst,
            f"endArrow=classic;html=1;rounded=0;strokeWidth=1.5;strokeColor=#{NEUTRAL[1:]};exitX=1;exitY=0.5;entryX=0;entryY=0.5;")

    # Fallback card
    if fallback and decision_at:
        first_dec = min(decision_at)
        fbx = start_x + first_dec * (CARD_W + ARROW_W)
        fby = FALLBACK_Y
        fb_label = fallback.get("label", "Issue Found")
        fb_actor = fallback.get("actor", "human")
        ac = FALLBACK_ACTOR
        fill_color = ac["fill"].lstrip("#")
        stroke_color = ac["border"].lstrip("#")
        font_color = ac["text"].lstrip("#")
        style = f"rounded=1;whiteSpace=wrap;html=1;fillColor=#{fill_color};strokeColor=#{stroke_color};fontColor=#{font_color};fontStyle=1;fontSize=11;strokeWidth=2;"
        fb_id = add_vertex(style, fbx, fby, CARD_W, CARD_H, f"{fb_label}\n(User checks & re-uploads)")
        cell_id_map["fallback"] = fb_id

        # Elbow connectors from each decision point
        for di in decision_at:
            src = cell_id_map.get(f"step_{di}")
            if not src:
                continue
            # In drawio, L-shaped connectors use orthogonal edge style
            style = f"endArrow=classic;html=1;rounded=0;strokeWidth=1.5;strokeColor=#{NEUTRAL[1:]};dashed=1;edgeStyle=elbowEdgeStyle;elbow=vertical;exitX=0.5;exitY=1;entryX=0.5;entryY=0;"
            add_edge_conn(src, fb_id, style)

    # ── Title ──
    title = spec.get("title", "Flow Diagram")
    title_id = add_vertex(
        "text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=18;fontStyle=1;fontColor=#1E293B;",
        0, 20, SLIDE_W, 50, title)

    # ── Build XML ──
    diagram_id = gen_id()
    root_id = gen_id()
    layer_id = gen_id()

    xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="mk-ppt" modified="{gen_id()}" agent="mk-ppt" version="21.0.0">
  <diagram id="{diagram_id}" name="Flow">
    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{SLIDE_W}" pageHeight="{SLIDE_H}" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
{chr(10).join(cells)}
{chr(10).join(edges)}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>'''

    with open(output_path, "w") as f:
        f.write(xml)
    print(f"✅ Generated: {output_path}")


# ── PNG Generation (Pillow) — HiDPI @ 2x scale ──────────────────────
def generate_png(spec, output_path):
    S = PNG_SCALE
    steps = spec.get("steps", [])
    decision_at = spec.get("decisionAt", [])
    fallback = spec.get("fallback")
    title = spec.get("title", "Flow Diagram")
    n = len(steps)

    # Scaled layout
    sw, sh = SLIDE_W * S, SLIDE_H * S
    cw, ch = CARD_W * S, CARD_H * S
    aw = ARROW_W * S
    top_y = TOP_Y * S
    fallback_y = FALLBACK_Y * S
    elb = ELBOW_DROP * S
    total_w = n * cw + (n - 1) * aw
    start_x = (sw - total_w) // 2

    # Create image
    img = Image.new("RGB", (sw, sh), "#FFFFFF")
    draw = ImageDraw.Draw(img)

    # Fonts (size × S)
    try:
        font_title = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 20 * S)
        font_card  = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 12 * S)
        font_small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 9 * S)
    except:
        font_title = ImageFont.load_default()
        font_card  = ImageFont.load_default()
        font_small = ImageFont.load_default()

    def round_rect(d, xy, r, fill, outline=None, width=1):
        d.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)

    # Title
    _, _, tw, th = draw.textbbox((0, 0), title, font=font_title)
    draw.text(((sw - tw) // 2, 30 * S), title, fill="#333333", font=font_title)

    # Neutral line under title
    draw.rectangle([(sw // 2 - 60 * S, 65 * S), (sw // 2 + 60 * S, 68 * S)], fill=NEUTRAL)

    # Actor legend on top right
    actor_labels = {
        "system": {"label": "System", "color": BLUE},
        "human":  {"label": "Human", "color": ORANGE},
        "it":     {"label": "IT/Ops", "color": DARK_GRAY},
    }
    lx = sw - 160 * S
    ly = 20 * S
    draw.text((lx, ly), "Legend:", fill="#555555", font=font_small)
    legend_items = list(actor_labels.items())
    if fallback:
        legend_items.append(("fallback", {"label": "↺ Fallback: re-upload", "color": RED}))
    for j, (k, v) in enumerate(legend_items):
        yl = ly + 16 * S + j * 16 * S
        draw.rectangle([(lx, yl), (lx + 10 * S, yl + 10 * S)], fill=v["color"])
        draw.text((lx + 14 * S, yl), v["label"], fill="#555555", font=font_small)

    # Draw pipeline cards
    card_centers = {}
    for i, step in enumerate(steps):
        x = start_x + i * (cw + aw)
        y = top_y
        actor = step.get("actor", "system")
        ac = ACTOR_COLORS.get(actor, ACTOR_COLORS["system"])
        fc, bc, tc = ac["fill"], ac["border"], ac["text"]

        round_rect(draw, (x, y, x + cw, y + ch), 8 * S, fc, bc, max(1, 2 * S) if i in decision_at else max(1, 1 * S))

        if i in decision_at:
            for dx in range(x + 3 * S, x + cw - 3 * S, 6 * S):
                draw.rectangle([(dx, y + 3 * S), (dx + 3 * S, y + ch - 3 * S)], fill=None, outline=bc, width=1)

        label = step["label"]
        _, _, lw, lh = draw.textbbox((0, 0), label, font=font_card)
        draw.text((x + (cw - lw) // 2, y + (ch - lh) // 2 - 4 * S), label, fill=tc, font=font_card)

        tag = step.get("actor", "").upper()
        _, _, tw2, th2 = draw.textbbox((0, 0), tag, font=font_small)
        draw.text((x + (cw - tw2) // 2, y + ch + 4 * S), tag, fill=bc, font=font_small)

        if i in decision_at:
            ax = x + cw // 2
            ay = y + ch
            lw_s = max(1, 1 * S)
            draw.line([(ax, ay), (ax, ay + 16 * S)], fill=NEUTRAL, width=lw_s)
            draw.polygon([(ax, ay + 22 * S), (ax - 4 * S, ay + 16 * S), (ax + 4 * S, ay + 16 * S)], fill=NEUTRAL)

        card_centers[i] = (x + cw // 2, y + ch // 2)

    # Arrows between steps
    lw_s = max(1, 2 * S)
    for i in range(n - 1):
        x1 = start_x + i * (cw + aw) + cw
        yc = top_y + ch // 2
        x2 = x1 + aw
        draw.line([(x1, yc), (x2, yc)], fill=NEUTRAL, width=lw_s)
        draw.polygon([(x2, yc), (x2 - 6 * S, yc - 4 * S), (x2 - 6 * S, yc + 4 * S)], fill=NEUTRAL)

    # Fallback
    if fallback and decision_at:
        first_dec = min(decision_at)
        fbx = start_x + first_dec * (cw + aw)
        fby = fallback_y
        ac_fb = FALLBACK_ACTOR
        fc, bc, tc = ac_fb["fill"], ac_fb["border"], ac_fb["text"]

        for di in decision_at:
            sx = start_x + di * (cw + aw) + cw // 2
            sy = top_y + ch + 22 * S
            tx = fbx + cw // 2
            ty = fby
            draw.line([(sx, sy), (tx, sy)], fill=NEUTRAL, width=1)
            draw.line([(tx, sy), (tx, ty)], fill=NEUTRAL, width=1)
            draw.polygon([(tx, ty), (tx - 4 * S, ty - 6 * S), (tx + 4 * S, ty - 6 * S)], fill=NEUTRAL)

        round_rect(draw, (fbx, fby, fbx + cw, fby + ch), 8 * S, fc, bc, max(1, 2 * S))
        fb_label = fallback.get("label", "Issue Found")
        _, _, lw, lh = draw.textbbox((0, 0), fb_label, font=font_card)
        draw.text((fbx + (cw - lw) // 2, fby + 8 * S), fb_label, fill=tc, font=font_card)
        fb_desc = "User checks & re-uploads"
        _, _, dw, dh = draw.textbbox((0, 0), fb_desc, font=font_small)
        draw.text((fbx + (cw - dw) // 2, fby + ch - 20 * S), fb_desc, fill=tc, font=font_small)

    img.save(output_path)
    print(f"✅ Generated: {output_path}")


# ══════════════════════════════════════════════════════════════════
# TIERED ARCHITECTURE
# ══════════════════════════════════════════════════════════════════

def generate_drawio_tiered(spec, output_path):
    tiers = spec.get("tiers", [])
    title = spec.get("title", "Architecture")
    if not tiers:
        with open(output_path, "w") as f:
            f.write("<mxfile><diagram><mxGraphModel><root><mxCell id='0'/></root></mxGraphModel></diagram></mxfile>")
        return

    cells = []
    edges = []
    cell_id_map = {}
    t_h = 180        # tier height
    hdr_h = 36       # header height
    gap = 12
    ml, mt = 40, 100 # margins
    cw = SLIDE_W - 2 * ml

    def v(label, style, x, y, w, h):
        cid = gen_id()
        cells.append(f'''    <mxCell id="{cid}" value="{label}" style="{style}" vertex="1" parent="1">
      <mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry" />
    </mxCell>''')
        return cid

    # Title
    v(title, "text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=18;fontStyle=1;fontColor=#333333;",
      ml, 20, cw, 40)

    tier_colors = {
        "horizontal": "#1F549C",
        "hybrid": "#2E7D32",
        "grid_2x2": "#F57C00",
    }

    for ti, tier in enumerate(tiers):
        ty = mt + ti * (t_h + gap)
        tn = tier.get("name", f"Tier {ti+1}")
        tc = tier.get("color", list(tier_colors.values())[ti % 3])
        layout = tier.get("layout", "horizontal")
        items = tier.get("items", [])

        # Tier background
        bg = "#F5F5F5"
        v("", f"rounded=1;whiteSpace=wrap;html=1;fillColor={bg};strokeColor=#{tc[1:]};strokeWidth=1.5;",
          ml, ty, cw, t_h)

        # Tier header
        hc = tc
        v(tn, f"rounded=1;whiteSpace=wrap;html=1;fillColor=#{hc[1:]};strokeColor=#{hc[1:]};fontColor=#FFFFFF;fontStyle=1;fontSize=12;align=center;verticalAlign=middle;",
          ml + 8, ty + 6, cw - 16, hdr_h)

        content_y = ty + hdr_h + 14
        content_h = t_h - hdr_h - 20

        if layout == "horizontal":
            # Equal-width columns
            n = len(items)
            col_w = (cw - 16 - (n - 1) * 8) // n
            for ii, item in enumerate(items):
                cx = ml + 8 + ii * (col_w + 8)
                children = item.get("children", [])
                child_html = "<br>".join([f"&nbsp;&nbsp;▪ {c}" for c in children]) if children else ""
                label = item.get("label", "")
                disp = f"<b>{label}</b>{'<br>' + child_html if child_html else ''}"
                v(disp,
                  f"rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#{tc[1:]};strokeWidth=1;fontColor=#333333;fontSize=10;align=center;verticalAlign=middle;",
                  cx, content_y, col_w, content_h)

        elif layout == "hybrid":
            # Left: Source of Truth (flex:2), Right: Custom Data (flex:1)
            left_w = int((cw - 16) * 0.65)
            right_w = (cw - 16) - left_w - 8
            for ii, item in enumerate(items):
                lx = ml + 8 + ii * (left_w + 8) if ii == 0 else ml + 8 + left_w + 8
                iw = left_w if ii == 0 else right_w
                label = item.get("label", "")
                children = item.get("children", [])

                # Header center-aligned, sub-items left-aligned
                header_html = f"<div style='text-align:center;font-weight:bold;font-size:11px;'>{label}</div>"
                body_parts = []
                for ch_item in children:
                    if isinstance(ch_item, dict):
                        cl = ch_item.get("label", "")
                        subs = ch_item.get("children", [])
                        if len(subs) > 2:
                            ncols = min(3, len(subs))
                            grid_rows = []
                            for si in range(0, len(subs), ncols):
                                row_cells = []
                                for sj in range(si, min(si + ncols, len(subs))):
                                    row_cells.append(f"<span style='display:inline-block;width:{100//ncols-2}%;padding:1px 4px;font-size:9px;'>▪ {subs[sj]}</span>")
                                grid_rows.append("".join(row_cells))
                            grid = "<br>".join(grid_rows)
                            body_parts.append(f"<div style='text-align:left;font-size:10px;'><b>{cl}</b><br>{grid}</div>")
                        else:
                            sub_html = "<br>".join([f"&nbsp;&nbsp;▪ {s}" for s in subs])
                            body_parts.append(f"<div style='text-align:left;font-size:10px;'><b>{cl}</b>{'<br>' + sub_html if sub_html else ''}</div>")
                    else:
                        body_parts.append(f"<div style='text-align:left;font-size:10px;'>&nbsp;▪ {ch_item}</div>")
                disp = header_html + "<br>" + "<br>".join(body_parts)
                v(disp,
                  f"rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#{tc[1:]};strokeWidth=1;fontColor=#333333;fontSize=10;align=center;verticalAlign=top;overflow=hidden;",
                  lx, content_y, iw, content_h)

        elif layout == "grid_2x2":
            cols = 2
            gw = (cw - 16 - (cols - 1) * 8) // cols
            gh = (content_h - 8) // 2
            for ii, item in enumerate(items):
                col = ii % cols
                row = ii // cols
                gx = ml + 8 + col * (gw + 8)
                gy = content_y + row * (gh + 8)
                label = item.get("label", "")
                v(label,
                  f"rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#{tc[1:]};strokeWidth=1;fontColor=#333333;fontSize=11;align=center;verticalAlign=middle;",
                  gx, gy, gw, gh)

    # Build XML
    diagram_id = gen_id()
    xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="mk-ppt" modified="{gen_id()}" agent="mk-ppt" version="21.0.0">
  <diagram id="{diagram_id}" name="Architecture">
    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{SLIDE_W}" pageHeight="{SLIDE_H}" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
{chr(10).join(cells)}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>'''

    with open(output_path, "w") as f:
        f.write(xml)
    print(f"✅ Generated: {output_path}")


def generate_png_tiered(spec, output_path):
    S = PNG_SCALE
    tiers = spec.get("tiers", [])
    title = spec.get("title", "Architecture")
    if not tiers:
        img = Image.new("RGB", (SLIDE_W * S, SLIDE_H * S), "#FFFFFF")
        img.save(output_path)
        return

    sw, sh = SLIDE_W * S, SLIDE_H * S
    ml, mt = 40 * S, 100 * S
    cw = sw - 2 * ml
    t_h = 180 * S
    hdr_h = 36 * S
    gap = 12 * S

    img = Image.new("RGB", (sw, sh), "#FFFFFF")
    draw = ImageDraw.Draw(img)

    try:
        ft = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 18 * S)
        fh = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 13 * S)
        fi = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 10 * S)
    except:
        ft = fh = fi = ImageFont.load_default()

    def rr(xy, r, fill, outline=None, width=1):
        draw.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)

    # Title
    _, _, tw, th = draw.textbbox((0, 0), title, font=ft)
    draw.text(((sw - tw) // 2, 25 * S), title, fill="#333333", font=ft)

    for ti, tier in enumerate(tiers):
        ty = mt + ti * (t_h + gap)
        tn = tier.get("name", f"Tier {ti+1}")
        tc = tier.get("color", "#1F549C")
        layout = tier.get("layout", "horizontal")
        items = tier.get("items", [])

        # Tier background
        rr((ml, ty, ml + cw, ty + t_h), 8 * S, "#F5F5F5", tc, max(1, 1 * S))

        # Header
        rr((ml + 8 * S, ty + 6 * S, ml + cw - 8 * S, ty + hdr_h + 6 * S), 4 * S, tc)
        _, _, nw, nh = draw.textbbox((0, 0), tn, font=fh)
        draw.text(((sw - nw) // 2, ty + 6 * S + (hdr_h - nh) // 2), tn, fill="#FFFFFF", font=fh)

        cy = ty + hdr_h + 14 * S
        ch = t_h - hdr_h - 20 * S

        if layout == "horizontal":
            n = len(items)
            col_w = (cw - 16 * S - (n - 1) * 8 * S) // n
            for ii, item in enumerate(items):
                cx = ml + 8 * S + ii * (col_w + 8 * S)
                label = item.get("label", "")
                children = item.get("children", [])
                rr((cx, cy, cx + col_w, cy + ch), 6 * S, "#FFFFFF", tc, 1)
                # Label
                _, _, lw, lh = draw.textbbox((0, 0), label, font=fh)
                draw.text((cx + (col_w - lw) // 2, cy + 8 * S), label, fill="#333333", font=fh)
                # Children
                for ci, c in enumerate(children):
                    _, _, cw_t, ch_t = draw.textbbox((0, 0), f"▪ {c}", font=fi)
                    draw.text((cx + 12 * S, cy + 40 * S + ci * 18 * S), f"▪ {c}", fill="#555555", font=fi)

        elif layout == "hybrid":
            left_w = int((cw - 16 * S) * 0.65)
            right_w = (cw - 16 * S) - left_w - 8 * S
            for ii, item in enumerate(items):
                lx = ml + 8 * S if ii == 0 else ml + 8 * S + left_w + 8 * S
                iw = left_w if ii == 0 else right_w
                label = item.get("label", "")
                children = item.get("children", [])
                rr((lx, cy, lx + iw, cy + ch), 6 * S, "#FFFFFF", tc, 1)
                # Center-aligned header
                _, _, lw, lh = draw.textbbox((0, 0), label, font=fh)
                draw.text((lx + (iw - lw) // 2, cy + 6 * S), label, fill="#333333", font=fh)

                y_off = cy + 36 * S
                avail_h = (cy + ch) - y_off - 4 * S
                for ch_item in children:
                    if not isinstance(ch_item, dict):
                        draw.text((lx + 8 * S, y_off), f"▪ {ch_item}", fill="#555555", font=fi)
                        y_off += 16 * S
                        continue
                    cl = ch_item.get("label", "")
                    subs = ch_item.get("children", [])
                    # Sub-section label: left-aligned
                    draw.text((lx + 8 * S, y_off), cl, fill="#1F549C", font=fh)
                    y_off += 20 * S
                    if len(subs) > 2:
                        ncols = min(3, len(subs))
                        nrows = (len(subs) + ncols - 1) // ncols
                        cell_w = (iw - 24 * S) // ncols
                        cell_h = min(18 * S, (avail_h - 22 * S) // nrows)
                        for si, sub in enumerate(subs):
                            col = si % ncols
                            row = si // ncols
                            gx = lx + 12 * S + col * cell_w
                            gy = y_off + row * cell_h
                            draw.text((gx, gy), f"▪ {sub}", fill="#555555", font=fi)
                        y_off += nrows * cell_h + 4 * S
                    else:
                        for sub in subs:
                            draw.text((lx + 16 * S, y_off), f"▪ {sub}", fill="#555555", font=fi)
                            y_off += 16 * S

        elif layout == "grid_2x2":
            cols = 2
            gw = (cw - 16 * S - (cols - 1) * 8 * S) // cols
            gh = (ch - 8 * S) // 2
            for ii, item in enumerate(items):
                col = ii % cols
                row = ii // cols
                gx = ml + 8 * S + col * (gw + 8 * S)
                gy = cy + row * (gh + 8 * S)
                label = item.get("label", "")
                rr((gx, gy, gx + gw, gy + gh), 6 * S, "#FFFFFF", tc, 1)
                _, _, lw, lh = draw.textbbox((0, 0), label, font=fh)
                draw.text((gx + (gw - lw) // 2, gy + (gh - lh) // 2), label, fill="#333333", font=fh)

    img.save(output_path)
    print(f"✅ Generated: {output_path}")


# ── Main ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python generate-drawio.py <spec.json> [--output name]")
        sys.exit(1)

    spec_path = sys.argv[1]
    spec = load_spec(spec_path)

    output_name = "data_strategy"
    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        output_name = sys.argv[idx + 1]

    drawio_path = f"{output_name}.drawio"
    png_path = f"{output_name}.png"
    st = spec.get("type", "flow")

    if st == "architecture":
        generate_drawio_tiered(spec, drawio_path)
        generate_png_tiered(spec, png_path)
    else:
        generate_drawio(spec, drawio_path)
        generate_png(spec, png_path)

    print(f"\n📋 Output files:")
    print(f"   {drawio_path}")
    print(f"   {png_path}")
