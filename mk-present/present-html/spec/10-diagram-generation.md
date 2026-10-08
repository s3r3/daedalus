# Diagram Generation Specification (Architecture & Flow)

## 1. Overview

Two new diagram features applied across all Present HTML themes and styles:
1. **Architecture Diagram** — Layered, tiered, business, data, application, physical architectures
2. **Flow Diagram** — Linear pipeline, branch flow, CI/CD, swimlane, system flow

Each feature supports two generation methods, chosen by the user at generation time.

## 2. Generation Methods

### 2.1 HTML Direct Method

**How it works:** Pure HTML/CSS positioned elements with inline SVG connectors.

**Architecture:**
- CSS `position: absolute` or flexbox for layout
- CSS shapes (rectangles, cylinders via border-radius, diamonds via clip-path, clouds via SVG)
- Inline SVG for connector arrows and lines
- Container borders (solid for physical, dashed for logical)
- Color coding via CSS variables (maps to Present HTML theme)

**Flow:**
- Flexbox pipeline row with node cards
- SVG elbow connectors for decision/fallback paths
- Actor color coding via left-border strips or fill
- Legend section for actors and path meanings

**Pros:**
- Fully customizable — all styles inline
- No external dependencies
- Responsive and theme-consistent
- Editable in source code

**Cons:**
- More manual layout work
- Complex diagrams require careful coordinate math

### 2.2 Drawio → PNG Method

**How it works:** Generate a `.drawio` XML file programmatically, then render to PNG at 2x resolution using Pillow, then embed as `<img>` in the HTML slide.

**Pipeline:**
```
Spec JSON → generate-drawio.py → .drawio file + .png (2x Retina)
                                            ↓
                                    Embedded into HTML slide
                                            ↓
                                    <img src="diagram.png">
```

**Tool:** `scripts/generate-drawio.py`

```bash
python scripts/generate-drawio.py <spec.json> --output <diagram_name>
# Produces: <diagram_name>.drawio + <diagram_name>.png
```

**Drawio file** is editable in [diagrams.net](https://app.diagrams.net) — users can tweak post-generation.

**PNG embedding in HTML:**
```html
<img src="<diagram_name>.png" alt="Architecture Diagram"
     style="max-width: 90%; max-height: min(60vh, 500px); object-fit: contain;">
```

**Pros:**
- Edit generated diagrams visually in diagrams.net
- Higher visual fidelity (vector → raster at 2x)
- Familiar diagramming paradigm for many users
- Cleaner separation of content and rendering

**Cons:**
- Requires Python + Pillow dependency
- Static PNG — not responsive to theme changes
- Additional file (.drawio + .png) alongside .html

## 3. AskUserQuestion Template

When Mode G (Architecture) or Mode H (Flow) is detected, ask:

```markdown
"Which generation method do you prefer?"
- **HTML Direct** — Generate diagram as pure HTML/CSS inline. Fully customizable, no extra files.
- **Drawio → PNG** — Generate .drawio file + .png image. Editable later in diagrams.net (app.diagrams.net).
```

## 4. Architecture Diagram Types

### 4.1 Layered (Data Architecture)
- Vertical stack with clear horizontal boundaries
- Data flows top-to-bottom or bottom-to-top
- Layers: Source → Ingestion → Storage → Processing → Consumption
- Cylinders for databases, rectangles for processes
- Arrows show data movement between layers

### 4.2 Tiered (System Logical)
- Three-tier "sandwich" layout with hybrid 2D grid
- Top: Analysis Layer (UI, reporting, API)
- Middle: Data Layer (storage, caching, integration)
- Bottom: Control Layer (security, governance, monitoring)
- Each tier uses a color accent (sky blue / green / purple)

### 4.3 Swimlane (Business Flow)
- Horizontal lanes by actor/department
- Each lane: Customer, Sales, Warehouse, etc.
- Chronological flow with handoff points
- Standard flowchart shapes (diamond for decisions)

### 4.4 Business Architecture
- Block/grid layout of business domains
- Top-level blocks: Finance, Operations, Marketing
- Sub-blocks: specific capabilities under each domain
- Color coding for maturity or strategic importance

### 4.5 Application Architecture
- Grouped rectangles for applications (ERP, CRM, Custom)
- Lines/integration arrows between groups
- Organized into layers or functional clusters
- Shows system coexistence and communication

### 4.6 Physical Architecture
- Hardware/cloud icons with connection topology
- Racks, servers, routers, firewalls (onsite)
- Provider-specific icons for cloud (AWS EC2, etc.)
- Network wiring and physical connectivity focus

## 5. Flow Diagram Types

### 5.1 Linear Pipeline
- Sequential steps with right-pointing arrows
- Simple progression: Step A → Step B → Step C
- No branching, no decisions

### 5.2 Branch Flow
- Decision gates with pass/fail paths
- Pass arrow continues right (green)
- Fail arrow drops down to fallback loop (red/dashed)
- Elbow connectors for one-to-many routing
- Shared fallback card below pipeline

### 5.3 CI/CD Pipeline
- Multi-stage with automated gates
- Stages: Upload → Merge → Auto Test → Security Check → AI Review → Peer Review → Deploy → Monitor
- Any stage can fail → fallback to issue fix → reupload
- Actor color coding for human vs system vs IT

### 5.4 Swimlane Flow
- Horizontal lanes by actor/role
- Chronological handoffs between lanes
- Decision diamonds within each lane

### 5.5 System Flow
- Request flow through system modules
- Queues, logic gates, error loops
- Retry logic and automated triggers
- No swimlanes — pure process logic

## 6. Shape Semantics (Both Methods)

| Shape | Meaning | CSS (HTML Method) | Drawio Shape |
|-------|---------|-------------------|--------------|
| Rectangle | Standard component | `border: 1px solid; border-radius: 4px` | `rounded=1` |
| Cylinder | Database / Storage | `border-radius: 50% / 0 0 100% 100%` | `cylinder=1` |
| Cloud | External network | SVG path | `ellipse` |
| Diamond | Decision | `clip-path: polygon(...)` | `rhombus` |
| Pill | Start/End | `border-radius: 999px` | `rounded=1` |
| Document | Report/File | `border-radius: 0 0 0 16px` | `note` |

## 7. Container Logic

- **Solid border** (1.5pt): Physical boundary (VPC, server, on-prem)
- **Dashed border**: Logical group (namespace, zone, environment)
- **Dotted border**: Temporary/optional grouping
- **Fill**: 10-15% accent opacity or transparent
- **Label**: Top-left corner of container

## 8. Connector Rules

- Edge connections only — never through center of shapes
- Mid-point connections preferred
- Consistent entry/exit (inputs left/bottom, outputs right/top)
- Clean angles (90 / 180 only)
- No connector overlap
- Line weight: 0.5pt for arrows, lighter than boxes

## 9. Actor Color Coding (Flow Diagrams)

| Actor | Border Color | Fill Color | Text Color |
|-------|-------------|------------|------------|
| System | #0EA5E9 (blue) | #F0F9FF | #1E293B |
| Human | #F59E0B (amber) | #FFFBEB | #1E293B |
| IT/Ops | #8B5CF6 (violet) | #F5F3FF | #1E293B |
| Fallback | #EF4444 (red) | #FEF2F2 | #1E293B |

## 10. Cross-Cutting Layer Design

For architecture diagrams that need governance/security/monitoring:

- **Top-down**: Vertical pillar on right side with 90 rotated text
- **Left-right**: Horizontal bar at bottom
- **Style**: 10-20% opacity fill, dashed border, muted gray
- **No arrows** — placement alone implies coverage
- Perfect height alignment with functional stack

## 11. Quality Control

- [ ] All shapes visible within slide boundaries
- [ ] Consistent border weight across all components (1pt standard)
- [ ] 20% padding inside shapes (text not touching borders)
- [ ] Edge-based connectors (never through center)
- [ ] No shadows, 3D, or bevels
- [ ] Single accent color (semantic pass/fail colors allowed)
- [ ] Container height matches contained shapes
- [ ] Text fully visible, no overflow or overlap
- [ ] Actor colors correct per role (flow diagrams)
- [ ] Decision gates clearly distinguishable
- [ ] Fallback path visually distinct (dashed/red)
