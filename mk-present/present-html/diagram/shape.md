# Architecture Shape Design Guide

## 1. Shape Semantics (Meaning)

In architecture diagrams, the geometry of a shape signals its type. While you can deviate, **sticking to industry standards** helps viewers scan slides faster and reduces cognitive load.

---

### **Shape Dictionary**

| Shape | Industry Meaning | When to Use | Examples |
|-------|------------------|-------------|----------|
| **Rectangle** | Standard Components | Core modules, services, or functional units | API Gateway, Load Balancer, Microservice |
| **Cylinder** | Databases / Storage | Data persistence, storage layers | PostgreSQL, Redis, S3, Data Warehouse |
| **Cloud** | External Networks | Internet, SaaS, public cloud | AWS Cloud, Google Cloud, Salesforce |
| **Hexagon** | Processes / Logic | Microservices, compute processes | Kubernetes Pod, Lambda Function, Compute Engine |
| **Rounded Rectangle (Pill)** | Start/End Points | User interactions, entry/exit points | User Login, End of Process, Mobile App |
| **Oval / Circle** | Start/End | Workflow begin or finish | Initial Request, Final Report, Database Backup |
| **Diamond** | Decision Point | Conditional logic, branching | User Auth Check, Payment Verified |
| **Parallelogram** | Input/Output | Data transfer, document exchange | File Upload, Email Sent, API Response |
| **Document** | Reports/Files | Documentation, output files | PDF Report, CSV Export, Configuration File |

---

### **Modern Shape Trends**

**Traditional vs. Modern:**

| Shape | Traditional Use | Modern Adaptation |
|-------|----------------|-------------------|
| **Rectangle** | Generic component | Rounded corners for modern feel |
| **Cylinder** | Database symbol | Still standard (well-recognized) |
| **Cloud** | External/Internet | Acceptable for any cloud service |
| **Hexagon** | Rare | Growing in microservices diagrams |
| **Pill** | None | Popular for user personas, start/end |

**Best Practice:** Choose ONE shape family and use consistently throughout your deck.

---

## 2. Container Logic (Parent-Child Relationship)

Containers are shapes used to **group other shapes**. This is critical for showing:
- **Environments:** Prod vs. Dev vs. Staging
- **Locations:** Cloud vs. Edge vs. Hybrid
- **Security Zones:** DMZ, Internal, Restricted
- **Functional Groups:** Auth, Billing, Analytics

---

### **The Container Hierarchy**

**Bad (Scattered):**
```
[Service A]   [Service B]   [Service C]
  (no grouping = unclear relationship)
```

**Good (Container Grouping):**
```
┌─────────────────────────────────────────┐
│  Production Environment                   │
├─────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ Service A│ │ Service B│ │ Service C│ │
│  └──────────┘ └──────────┘ └──────────┘ │
└─────────────────────────────────────────┘
```

---

### **Container Fill Style**

**Rule:** Containers should have a very light fill or be transparent to avoid overwhelming nested icons.

**Recommended Fill Opacity:**

| Container Type | Fill Style | Background Color |
|----------------|------------|------------------|
| **Logical Group** | Transparent | None or #FFFFFF at 90% |
| **Physical Boundary** | Very Light Tint | Accent color at 10-15% opacity |
| **Security Zone** | Light Gray | #F5F5F5 or #FAFAFA |

**Bad (Heavy Fill):**
```
Heavy fill overwhelms content:
┌─────────────────────────────────────────┐
│  ██████████████████████████████████████  │ ← Too dark
│                                         │
└─────────────────────────────────────────┘
```

**Good (Light Fill):**
```
Light tint maintains contrast:
┌─────────────────────────────────────────┐
│  ░░░░░░░░░░░░░░░░ ░░░ ░░ ░░ (10%)      │ ← Subtle
│                                         │
└─────────────────────────────────────────┘
```

---

### **Container Border Style**

**Rule:** Line style indicates boundary type.

| Border Type | Use Case | Visual |
|-------------|----------|--------|
| **Solid Line** | Hard boundaries (Physical, VPC, Server) | ───────── |
| **Dashed Line** | Logical groupings (Namespace, Zone) | · · · · · |
| **Dotted Line** | Temporary/optional grouping | . . . . . |

**Examples:**

**Solid (Physical/Required):**
```
┌─────────────────────────────────────────┐  ← Solid = VPC (physical boundary)
│                                         │
│  [App Server 1]  [App Server 2]        │
└─────────────────────────────────────────┘
```

**Dashed (Logical/Optional):**
```
┌───── ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐  ← Dashed = Namespace (logical)
│                                         │
│  [Pod A]  [Pod B]  [Pod C]             │
└───── ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘
```

---

### **Container Labeling**

**Position:** Place the container label where it doesn't interfere with nested components.

**Recommended Positions:**

| Position | Best For |
|----------|----------|
| **Top-Left Corner** | Standard containers, environments |
| **Bottom-Center** | Wide containers, zones |
| **Inside Border (Left)** | Tall containers |
| **Outside (Leader Line)** | Very crowded containers |

**Standard Placement (Recommended):**

```
┌─────────────────────────────────────────┐
│  Production Environment                 │ ← Top-left label in border
├─────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐             │
│  │ Service A│ │ Service B│             │
│  └──────────┘ └──────────┘             │
└─────────────────────────────────────────┘
```

---

## 3. Stroke and Border Weight

The "weight" (thickness) of your shapes defines the "noise" level of the slide.

---

### **Consistent Weight Rule**

**Rule:** If one service box has a 1pt border, every service box should have a 1pt border.

**Bad (Inconsistent):**
```
Inconsistent borders increase noise:
┌───────┐  ← 1pt
│  Box  │
└───────┘
┌─────────────┐  ← 3pt (too thick!)
│ Big Box     │
└─────────────┘
┌────┐  ← 0.5pt (too thin!)
│ X  │
└────┘
```

**Good (Consistent):**
```
Consistent borders (clean look):
┌───────┐
│  Box  │  ← All 1pt
└───────┘
┌───────┐
│  Box  │  ← All 1pt
└───────┘
```

---

### **Standard Border Weights**

| Element Type | Border Weight | When to Use |
|--------------|---------------|-------------|
| **Standard Component** | 1pt | Primary architecture elements |
| **Primary System** | 1.5pt - 2pt | Main system under discussion |
| **Secondary System** | 1pt | Supporting components |
| **Legacy System** | 0.5pt - 0.75pt | Old/deprecated systems |
| **Containers** | 1.5pt | Grouping boundaries |
| **Connectors** | 0.5pt | Lines should be lighter than boxes |

---

### **Hierarchy Through Color (NOT Thickness)**

**Rule:** Instead of making a border thicker to show importance, change its color. This keeps the diagram looking "light" and modern.

**Bad (Thickness Hierarchy):**
```
Using thickness for importance increases noise:
┌──────────────────┐  ← 4pt = Main system (too heavy)
│ Primary System   │
└──────────────────┘

┌──────┐          ← 1pt = Secondary (hard to compare)
│  Sec │
└──────┘
```

**Good (Color Hierarchy):**
```
Using color for importance maintains lightness:
┌──────────────────┐  ← 1pt, Dark Accent = Primary
│ Primary System   │   (more prominent color)
└──────────────────┘

┌──────┐          ← 1pt, Light Accent = Secondary
│  Sec │   (subtle color)
└──────┘
```

**Color for Hierarchy:**
| Priority | Border Color | Fill |
|----------|-------------|------|
| **Primary** | Accent color (e.g., #0EA5E9) | Transparent |
| **Secondary** | Neutral secondary (e.g., #64748B) | Transparent |
| **Legacy** | Muted gray (e.g., #94A3B8) | Light gray fill |

---

## 4. Internal Padding and "Breathing Room"

Shapes look professional when text or icons inside have space to "breathe."

---

### **The 20% Rule**

**Rule:** Aim for at least 20% white space between the text/icon and the border of the shape.

**Example:**

**Box Size 2" × 1" (160pt × 80pt):**

| Measurement | Standard Box | Bad (No Padding) |
|-------------|--------------|------------------|
| **Horizontal Space** | 32pt left/right | 0pt (text touches border) |
| **Vertical Space** | 16pt top/bottom | 0pt (text touches border) |
| **Result** | ✅ Professional | ❌ Cramped = Cheap |

**Calculating Padding:**
```
For a box of width W and height H:
  Left/Right Padding = 0.2 × W
  Top/Bottom Padding = 0.2 × H

Example: W=200pt, H=100pt
  Left/Right = 40pt
  Top/Bottom = 20pt
```

---

### **Real-World Padding Values**

| Box Width | Recommended Padding |
|-----------|---------------------|
| 1.5" - 2" | 12pt horizontal, 6pt vertical |
| 2" - 3" | 16pt horizontal, 8pt vertical |
| 3" - 4" | 20pt horizontal, 10pt vertical |
| > 4" | 24pt horizontal, 12pt vertical |

**Padding for Icons:**
| Icon Size | Min Padding |
|-----------|-------------|
| 24px × 24px | 8px from edges |
| 48px × 48px | 12px from edges |
| 64px × 64px | 16px from edges |

**Cramped = Cheap:** A box with text touching borders looks unprofessional.

---

### **Centering Rules**

**Rule:** Ensure text is mathematically centered. If a box is 2cm wide, the text should be exactly at the 1cm mark.

**Horizontal Centering:**
```
✓ CORRECT:
┌─────────────────────────┐
│          Text           │  ← Centered at 1cm
└─────────────────────────┘
   0cm        1cm       2cm

✗ WRONG:
┌─────────────────────────┐
│ Text                     │  ← Left-aligned = messy
└─────────────────────────┘
```

**Vertical Centering:**
```
✓ CORRECT:
┌─────────────────────────┐
│                         │ 1cm vertical space
│          Text           │  ← Centered
│                         │ 1cm vertical space
└─────────────────────────┘

✗ WRONG:
┌─────────────────────────┐
│ Text                     │  ← Top-aligned = messy
│                         │
│                         │
└─────────────────────────┘
```

---

## 5. Connector Anchor Points

A shape is only as good as how it connects to others.

---

### **Connection Points: Edge Mid-Points**

**Rule:** Arrows should attach to the mid-points of the sides.

**PowerPoint:**
1. Select a shape
2. Hover near edges - small dots appear at connection points
3. Connect from one connection point to another

**Connection Point Locations:**
```
Top Connection Point (0, 0)
    ↓
┌─────────────────────┐
│         ●           │ ← Center connection (NEVER USE)
└─────────────────────┘
    ↑
Bottom Connection Point (Width/2, Height)

Left Connection Point (0, Height/2) → Right Connection Point (Width, Height/2)
```

**Never Connect Through Center:**
```
❌ BAD - Center Connection:
┌─────────────┐
│      │      │ ← Line through center (looks amateur)
│      ▼      │
└─────────────┘

✓ GOOD - Edge Connection:
┌─────────────┐
│             │
│             │
│             │ ← Line from edge
├─────────────┤
└─────────────┘
```

---

### **Multi-Connection Shapes: Avoid Star Pattern**

**Rule:** If a shape has too many lines coming out of it, the shape itself starts to look like a "star." Increase the size of the shape to give the lines more room to attach cleanly.

**Bad (Crowded):**
```
Crowded connector (Star pattern):
        ┌─────────┐
        │  Shape  │ ← Lines all clustered
        └─────────┘
      ↙  ↘   │   ↙  ↘

Good (Expanded):
              ┌─────────────────┐
              │     Shape       │ ← More room for connections
              └─────────────────┘
          ↙    │    ↘  ↙    │    ↘
```

**Solution:** Increase box size OR group connections through intermediate nodes.

---

### **Connection Point Rules**

| Rule | Implementation |
|------|----------------|
| **Always edge connections** | Never connect through center |
| **Mid-point preferred** | Connect from side centers |
| **Consistent entry/exit** | All inputs from left/bottom, outputs from right/top |
| **No overlap** | Connectors should not cross each other |
| **Clean angles** | Use 90° or 180° connections only |

---

## 6. Shadow and 3D (The "Flat" Rule)

As an IT architect, your goal is **clarity**, not art.

---

### **Prohibited Effects**

**NEVER Use:**
- ❌ Drop shadows
- ❌ Inner shadows
- ❌ 3D rotations
- ❌ Bevels and emboss
- ❌ Glossy effects
- ❌ Gradient fills (except for containers/tints)
- ❌ Reflection effects

**Why Prohibited:**
1. These add "visual artifacts" that make technical diagrams harder to read
2. They distract from the actual architecture
3. They create a dated look
4. They increase cognitive load

---

### **Depth Through Tone (Flat Hierarchy)**

**Rule:** If you need to show one system "behind" another, use a darker shade of gray for the background shape rather than a shadow.

**Example Showing Depth (NO SHADOWS):**

```
❌ BAD - Shadow Effects:
┌─────────────────────┐
│ Main Component      │  ← Has drop shadow (bad)
└─────────────────────┘
    ☁️ ← Shadow behind makes reading harder

✓ GOOD - Tone-Based Depth:
┌─────────────────────┐
│ Background Shade    │  ← Darker gray for depth
└─────────────────────┘
    ┌─────────────────────┐
    │ Main Component      │  ← No shadows, just tone
    └─────────────────────┘
```

**Tone Hierarchy:**

| Layer | Color | Use Case |
|-------|-------|----------|
| **Background** | #FAFAFA (50% gray at 5% opacity) | Behind all |
| **Container** | #F5F5F5 (10% gray) | Grouping containers |
| **Main Component** | #FFFFFF (100% white) | Primary focus |
| **Secondary Component** | #F8F8F8 (85% white) | Supporting elements |
| **Legacy Component** | #F0F0F0 (75% white) | Deprecated systems |

---

## Shape Design Examples

### **Example 1: Complete Component**

```
┌─────────────────────────────────────────┐
│  ✓ Consistent 1pt border                │
│  ✓ 20% padding (text centered)          │
│  ✓ No shadows/3D effects                │
│  ✓ Flat design with accent border       │
├─────────────────────────────────────────┤
│          📊                            │  ← Icon top-center
│     Google BigQuery                    │  ← Primary (Bold)
│     (Data Warehouse)                   │  ← Secondary (Regular)
└─────────────────────────────────────────┘
  ✓ Connection point at right edge
```

### **Example 2: Container with Components**

```
┌─────────────────────────────────────────┐
│  Production Environment                  │  ← Label top-left
│  (Dashed border = logical grouping)      │
├─────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐             │
│  │ Service A│ │ Service B│  ← Same size
│  │  🖥️     │ │  💾     │  ← Same icon size
│  └──────────┘ └──────────┘  ← 0.15" spacing
└─────────────────────────────────────────┘
  ✓ Consistent padding
  ✓ Grid alignment
  ✓ No overlapping
```

---

## Quick Reference Checklist

### Shape Semantics:
- [ ] Using industry-standard shapes (rect, cylinder, cloud, etc.)
- [ ] Consistent shape family throughout slide
- [ ] Shape choice matches component type

### Container Logic:
- [ ] Logical grouping with clear containers
- [ ] Light fill or transparency for containers
- [ ] Border style indicates boundary type (solid/dashed)
- [ ] Label placed at top-left or bottom-center
- [ ] Labels don't interfere with components

### Border Weight:
- [ ] Consistent weight across all components
- [ ] Primary system: 1.5-2pt or accent color
- [ ] Secondary/legacy: 0.5-1pt or lighter color
- [ ] Color for hierarchy, not thickness

### Internal Padding:
- [ ] 20% white space rule followed
- [ ] At least 12pt horizontal padding
- [ ] At least 6pt vertical padding
- [ ] Text mathematically centered

### Connectors:
- [ ] Edge connections only (NEVER center)
- [ ] Mid-point connections preferred
- [ ] No star patterns (expand shapes if needed)
- [ ] Clean angles (90°/180° only)

### Flat Design:
- [ ] NO shadows
- [ ] NO 3D effects
- [ ] NO bevels
- [ ] Depth shown through tone (gray shades)

---

## Summary: Shape Best Practices

**The Formula:**
```
Professional Shapes =
  Industry-Standard Semantics
  + Logical Container Grouping
  + Consistent Border Weight
  + 20% Padding (Breathing Room)
  + Edge-Based Connectors
  + Flat Design (No Shadows)
```

**Key Takeaway:** Shapes should communicate **type** and **relationship** effortlessly. Keep them clean, consistent, and professional. No visual clutter, no shadows, no 3D - just clear technical communication.
