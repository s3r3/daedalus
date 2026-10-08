# Cross-Cutting Layers Design Guide

## Overview

In IT architecture, **Cross-Cutting Concerns** (also called **Orthogonal Layers**) represent functions that apply to an entire system, not just a single functional component:

- **Security** (applies everywhere)
- **Governance/Compliance** (monitoring across all layers)
- **Logging/Monitoring** (visible everywhere)
- **Operations/DevOps** (runs through all components)
- **Identity/Authentication** (enables access everywhere)

This guide specifies how to visually represent these orthogonal concerns in architecture diagrams.

---

## 1. The "Sidebar" Rule (Placement)

**Core Principle:** Cross-cutting functions should NOT be "inside" the flow because they apply to ALL layers/steps.

### **For Top-Down Diagrams:**

Place control layers as a **vertical pillar on the left OR right** side of the main stack:

```
┌─────────────────────────────────────────────────┐
│                    Functional                   │
│                    Stack                        │
│         ┌─────────────────┐                     │
│         │  Data Layer     │                     │
│         │  Processing     │                     │ ← Main functional flow
│         │  Services       │                     │
│         └─────────────────┘                     │
│                                                 │
│         ┌─────────────────┐                     │
│         │ Presentation    │                     │
│         └─────────────────┘                     │
└─────────────────────────────────────────────────┘
│                                                 │
│  Cross-Cutting          Security                │ ← Vertical pillar on right
│  Layer                  Governance              │
│  (Orthogonal Concerns)    Monitoring              │
│                         Operations              │
└─────────────────────────────────────────────────┘
```

### **For Left-Right Diagrams:**

Place control layer as a **horizontal bar at the very bottom or very top**:

```
┌────────────────────────────────────────────────────────────────────┐
│                   Cross-Layer Concerns                               │
│            [Security] [Governance] [Monitoring]                      │
└────────────────────────────────────────────────────────────────────┘
┌─────────────────┐  ┌─────────────┐  ┌─────────────────┐
│   Source Layer  │→ │ Process    │→ │   Output       │
└─────────────────┘  └─────────────┘  └─────────────────┘
     Left               Center               Right
┌────────────────────────────────────────────────────────────────────┐
│                   Cross-Layer Concerns                               │
│            [Security] [Governance] [Monitoring]                      │
└────────────────────────────────────────────────────────────────────┘
```

### **Visual Logic:**

This positioning suggests that the main architecture:
- **"Runs through"** the control layer
- **"Is observed by"** the governance layer
- **"Protected by"** the security layer

The sidebar/bar creates a visual metaphor of "oversight" or "enabling" - it doesn't participate in the flow itself, but enables it from the outside.

---

## 2. Visual Differentiation (The "Ghost" or "Bridge" Style)

To show that cross-cutting layers are different from functional components, use distinct visual styling.

### **Style Guidelines:**

| Property | Specification |
|----------|---------------|
| **Background** | Neutral light gray (#F3F4F6) or light accent tint |
| **Fill Opacity** | 10-20% (transparent, looks like overlay) |
| **Border** | Dashed line (1.5pt) |
| **Border Color** | Muted gray (#D1D5DB) or accent at 50% opacity |
| **Border Style** | Dashed (indicates non-physical/logical boundary) |

### **Text Styling:**

| Property | Specification |
|----------|---------------|
| **Direction** | Vertical (90° rotation) for top-down diagrams |
| **Direction** | Horizontal for top/bottom bars |
| **Alignment** | Centered |
| **Font Size** | 10-11pt |
| **Font Weight** | Bold |
| **Color** | Muted gray or neutral text color |

### **Example Styling:**

```
Top-Down with Vertical Pillar (Right Side):
┌─────────────────────────────────┐
│  Functional Stack               │
│  [Layer 1 → Layer 2 → Layer 3] │
│                                 │
│  ┌─────────────────┐            │
│  │  Cross-         │            │
│  │  Cutting        │            │ ← Vertical 90° text
│  │  Layer          │            │
│  └─────────────────┘            │
└─────────────────────────────────┘
```

```
Left-Right with Bottom Bar:
┌─────────────────────────────────┐
│  Source → Process → Output      │
└─────────────────────────────────┘
┌─────────────────────────────────┐
│  [ Security | Governance | Monitoring ]  │
└─────────────────────────────────┘
```

### **Visual Effect:**

**Good (Ghost/Bridge Style):**
```
┌─────────────────────────────────┐
│  Light gray, semi-transparent   │
│  Dashed border                    │
│  Vertical text                    │
└─────────────────────────────────┘
  ← Looks like "overlay" or "framework"
```

**Bad (Too Heavy):**
```
┌─────────────────────────────────┐
│  Solid fill, dark border          │
│  Horizontal text                  │
└─────────────────────────────────┘
  ← Looks like "another layer" (wrong!)
```

---

## 3. The "Unified Border" Rule (Containment)

When governance/scope applies to the **entire system**, you need a containment container.

### **Implementation:**

**Step 1: Draw Bounding Box**
- Large, thin-lined box that encloses ALL functional components
- Thin line (1pt) to indicate "envelope" not "component"
- Light gray or accent color at low opacity

**Step 2: Add Container Label**
- Place label in a "tab" attached to the top or side
- NOT inside the box (wastes space)
- Clear, bold text

**Example:**

```
┌─────────────────────────────────────────────────┐
│  ════ Management & Governance ════              │ ← Tab label
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │  Functional Components                    │   │
│  │  [Component A] [Component B] [Component C]│   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│         (Cross-cutting layer implied)           │
└─────────────────────────────────────────────────┘
  ↑ Thin bounding box with tab
```

### **Tab Design:**

| Property | Specification |
|----------|---------------|
| **Background** | Same as content (or accent color) |
| **Border** | 1pt solid (connects to box) |
| **Text** | Bold, 12pt, centered in tab |
| **Width** | At least 100px |
| **Height** | 16px |

---

## 4. Connection Rules (Invisible vs. Explicit)

### **A. Implicit (Clean Look) - Recommended**

**When to use:**
- Most common case
- Cross-cutting applies to entire system uniformly
- Want clean, uncluttered diagram

**Implementation:**
- **NO arrows** from the control pillar/bar to functional components
- **Placement alone** implies coverage
- Visual proximity = implied connection

**Example:**
```
┌─────────────────────────────────────────┐
│    Functional Components                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐│
│  │ Comp A   │ │ Comp B   │ │ Comp C   ││
│  └──────────┘ └──────────┘ └──────────┘│
│                                         │
│    Cross-Cutting Layer                  │ ← No arrows needed
│    (Security, Governance, Monitoring)   │
└─────────────────────────────────────────┘
```

### **B. Explicit (Detailed Look)**

**When to use:**
- Need to highlight specific control functions
- Showing "audit logging" or specific monitoring
- Stakeholders need explicit understanding

**Implementation:**
- Use **single, thin, dashed line** (0.5pt)
- **Small dot-head** arrow (not triangle)
- Connect pillar to ONE functional tier only
- **DO NOT** add arrows to every single box!

**Example:**
```
┌─────────────────────────────────────────┐
│  ┌──────────┐      ┌──────────┐         │
│  │ Comp A   │ ────> │ Comp B   │         │
│  └──────────┘      └──────────┘         │
│      │                    │              │
│      ·                    ·  ← Dot arrows
│      │        │           │              │
│  ┌─────────────────────────────────┐    │
│  │  Cross-Cutting Layer            │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

**Explicit Arrow Guidelines:**
- **Line weight:** 0.5pt (thin)
- **Line style:** Dashed
- **Arrowhead:** Small dot (0.2pt)
- **Color:** Muted (not the accent color)

---

## 5. Grammar & Phrasing for Style Guide

Use these polished architectural terms in documentation:

### **Standard Terms:**

| Term | Use Case | Example |
|------|----------|---------|
| **"Cross-Cutting Layers"** | All orthogonal concerns | "Security and Governance are cross-cutting layers that apply throughout the architecture." |
| **"Orthogonal Concerns"** | High-level architectural descriptions | "The architecture separates orthogonal concerns from functional concerns." |
| **"Pillar Architecture"** | Vertical governance blocks | "The monitoring pillar runs alongside the functional stack." |
| **"Cross-Layer Concerns"** | Horizontal control bars | "The security control bar spans the entire cross-layer." |
| **"Cross-Functional Scope"** | System-wide governance | "All components operate within cross-functional governance policies." |

### **Avoid These Terms:**

| ❌ Don't Say | ✅ Say Instead |
|--------------|----------------|
| "Special layer" | "Cross-Cutting Layer" |
| "Extra layer" | "Orthogonal Concern" |
| "Background layer" | "Cross-Layer Governance" |
| "Side box" | "Pillar Architecture" |
| "Outer frame" | "Unified Border Container" |

### **Example in Documentation:**

**Wrong:**
> "We have a special layer on the right that monitors everything."

**Correct:**
> "Security and Monitoring are implemented as cross-cutting layers following pillar architecture. These orthogonal concerns run alongside the functional stack to provide governance, logging, and security across all components."

**Better:**
> "The architecture employs orthogonal concerns for Security, Governance, and Monitoring, implemented as a cross-cutting pillar architecture on the right side. This ensures these controls apply uniformly throughout the functional stack."

---

## 6. The "QC Rule" - Alignment Check

**CRITICAL:** Ensure the "Control Pillar" is **perfectly aligned** with the height of the functional stack.

### **QC Checks:**

| Check | Pass Criteria | Visual Test |
|-------|---------------|-------------|
| **Height Match** | Control pillar = Total functional height | Pillar touches top and bottom of stack |
| **Top Alignment** | Control top = Functional top | No gap at top |
| **Bottom Alignment** | Control bottom = Functional bottom | No gap at bottom |
| **Consistent Width** | Consistent pillar width throughout | No tapering or changing size |
| **Spacing** | Consistent spacing from functional elements | Even gap throughout |

### **Bad Alignment Examples:**

**❌ Too Tall:**
```
┌─────────────────────────────────┐
│  Functional                     │
│  Stack                          │
└─────────────────────────────────┘
│ Control Layer                   │ ← Exceeds stack
│ (Too tall)                      │
└─────────────────────────────────┘
```

**❌ Too Short:**
```
┌─────────────────────────────────┐
│  Functional                     │
│  Stack                          │
└─────────────────────────────────┘
│ Control                         │
│ (Too short - gap at bottom)     │ ← Excess space
└─────────────────────────────────┘
```

**✅ Perfect Alignment:**
```
┌─────────────────────────────────┐
│  Functional Stack               │
├─────────────────────────────────┤ ← Pillar top aligns
│  ┌─────────────────┐            │
│  │                 │            │
│  │  Cross-Cutting  │            │
│  │  Layer          │            │
│  └─────────────────┘            │
├─────────────────────────────────┤ ← Pillar bottom aligns
│  Functional                     │
│  Stack                          │
└─────────────────────────────────┘
```

### **QC Checklist:**
- [ ] Control pillar height = Functional stack height
- [ ] Top edges aligned
- [ ] Bottom edges aligned
- [ ] Consistent width
- [ ] Consistent spacing
- [ ] Vertical text perfectly centered in pillar

---

## Reference Examples

### **Example 1: Top-Down with Right-Side Pillar**

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Functional Stack                             │
│  ┌───────────────────────────────────────────────────────┐         │
│  │  Presentation Layer                                     │         │
│  │  [UI] [Mobile App] [API Gateway]                       │         │
│  ├───────────────────────────────────────────────────────┤         │
│  │  Application Layer                                      │         │
│  │  [Services] [Microservices] [Logic Layer]              │         │
│  ├───────────────────────────────────────────────────────┤         │
│  │  Data Layer                                             │         │
│  │  [Databases] [Data Warehouse] [Cache]                  │         │
│  └───────────────────────────────────────────────────────┘         │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │                                                         │       │
│  │  C r o s s - C u t t i n g                             │       │  ← Vertical text (90°)
│  │  L a y e r                                            │       │
│  │  [Security] [Governance] [Monitoring] [Logging]        │       │
│  │                                                         │       │
│  └─────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
         ↑ Perfect height alignment
```

### **Example 2: Left-Right with Bottom Cross-Layer**

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Logical Architecture                         │
│                                                                     │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐         │
│  │   Source    │  →   │  Process    │  →   │   Output    │         │
│  │  (Inputs)   │      │ (Transform) │      │  (Results)  │         │
│  └─────────────┘      └─────────────┘      └─────────────┘         │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────────┐│
│ │ [ Security ] [ Governance ] [ Monitoring ] [ Compliance ]      ││ ← Bottom bar
│ └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

---

## Summary

**Cross-Cutting Layers Design Formula:**

```
Cross-Cutting Design =
  Proper Placement (Sidebar or Bar) +
  Visual Differentiation (Transparency, Dashed, Vertical Text) +
  Unified Border (if system-wide) +
  Implicit Connections (NO arrows) +
  Perfect Alignment (height match!) +
  Professional Phrasing
```

**Key Takeaways:**
1. **Placement:** Pillar for Top-Down, Bar for Left-Right
2. **Style:** Transparent (10-20%), dashed border, 90° vertical text
3. **Containment:** Unified border with tab label for system-wide governance
4. **Connections:** Implicit (no arrows) preferred
5. **Alignment:** Control pillar must match functional stack height perfectly
6. **Phrasing:** Use "Cross-Cutting Layer", "Orthogonal Concerns", "Pillar Architecture"

**This design pattern visually communicates that these controls apply to the entire system from the outside, not as part of the functional flow.** 🏗️
