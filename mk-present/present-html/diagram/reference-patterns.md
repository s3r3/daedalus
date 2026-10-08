# Reference Pattern Analysis

## Overview

This document analyzes the architecture samples in `diagram/samples/` to extract design patterns that should be followed.

---

## Sample Analysis Summary

### 1. **data-architecture-01.png** (Data Lakehouse)

**Design Characteristics:**
- **Layout:** Hybrid (Left-Right data flow + Top-Bottom cross-cutting layers)
- **Color Palette:** Azure Blue + Snowflake Light Blue + Orange accents (Bronze/Silver/Gold)
- **Shapes:** Rounded rectangles for components, Cylinders for databases
- **Borders:** Medium thickness (1.5pt) solid blue, Dotted blue for logical boundaries
- **Padding:** Generous (Premium look)
- **Icons:** Official brand logos (Fivetran, dbt, Snowflake, etc.)
- **Containers:** Light fills, dashed borders for logical grouping
- **Connectors:** Solid blue lines, double-headed for bidirectional flows
- **Design Style:** **Modern Professional** (Flat, no shadows/3D)

**Key Takeaways:**
-✅ Consistent color scheme (Blue theme)
✅ Industry-standard shapes (rect/cylinder)
✅ Generous internal padding
✅ Clean flat design
✅ Logical grouping with dashed borders
✅ Official icons for recognition

---

### 2. **logical-architecture-01.png** (Oracle BI 12c)

**Design Characteristics:**
- **Layout:** Hybrid (Top-Down hierarchy + Left-Right grids)
- **Color Palette:** Blue (processing layers) + Green (infrastructure) + Gray (management)
- **Shapes:** Rectangles only (no rounded corners)
- **Borders:** Thick for main containers, thin for internal components
- **Padding:** Generous (16-24pt internal padding)
- **Shadows:** Soft gradients for depth (NOT shadows)
- **Legend:** None (relies on visual consistency)
- **Grid Alignment:** Strict grid with uniform distribution

**Key Takeaways:**
- ✅ 3x3 Rule of Thirds for visual balance
✅ Color-coding by function/layer
✅ Thick borders for major containers
✅ Thin borders for components
✅ Generous padding = Premium look
✅ Soft gradients for depth (instead of shadows)
✅ Strict grid alignment

---

### 3. **business-flow-01.svg** (Supply Chain)

**Design Characteristics:**
- **Layout:** Swimlanes (Top-Down hierarchy)
- **Color Palette:** Coded swine lanes (Green, Teal, Red, Purple, Yellow, Blue)
- **Shapes:** Rectangles with colored headers
- **Borders:** Thin consistent lines
- **Padding:** Consistent internal spacing
- **Connectors:** Elbow connectors (90-degree angles only)
- **Design Style:** **Blueprint-style** (Technical precision)

**Key Takeaways:**
- ✅ 90-degree/180-degree lines only (No diagonals)
✅ Color-coded swimlanes
✅ Clean elbow connectors
✅ Flat design (No shadows)
✅ Consistent padding

---

### 4. **system-flow-01.png** (System Process Flow)

**Design Characteristics:**
- **Layout:** Top-to-bottom with serpentine path
- **Color Palette:** Blue dominant + Color-coded swimlanes
- **Shapes:** Rectangles (no decision diamonds)
- **Borders:** Thin consistent
- **Padding:** Generous
- **Connectors:** Solid lines with arrowheads
- **Grid:** Perfect alignment
- **Design Style:** Modern Professional (Flat)

**Key Takeaways:**
- ✅ Strict grid alignment
✅ Edge connections only (no center)
✅ Small sharp arrowheads
✅ Consistent line weights
✅ No shadows or 3D effects

---

## Common Design Patterns Identified

### **1. Layout Patterns**
- **Hybrid layouts** preferred (combination of Top-Down structure with Left-Right flow)
- **Cross-cutting layers** (Operations at top, Security at bottom)
- **Swimlanes** for role-based organization
- **Grid alignment** is essential

### **2. Color Patterns**
- **Base colors:** Slate/Navy/Gray as structural foundation (60%)
- **Accent colors:** ONE bright accent per diagram (Electric Blue, Teal)
- **Tints:** 10-15% accent color for container backgrounds
- **NO rainbow palettes** - use consistent theme

### **3. Shape Patterns**
- **Standard semantics:**
  - Rectangle = Component/Service
  - Cylinder = Database/Storage
  - Cloud = External/Internet
  - Rounded Rectangle = User/Persona/Start-End
- **Consistent shape family** throughout diagram

### **4. Border Patterns**
- **Standard:** 1.5pt solid (primary components)
- **Primary system:** 2pt OR Accent color
- **Secondary:** 1pt with lighter color
- **Logical boundaries:** 1pt dashed
- **Hard boundaries:** 1.5pt solid

### **5. Padding Patterns**
- **Generous padding** (16-24pt internal padding)
- **20% white space** rule
- **Premium look** = spacious, NOT cramped

### **6. Connector Patterns**
- **90-degree/180-degree angles only**
- **Elbow connectors** (NO diagonal lines)
- **Edge connections** (never through center)
- **Small sharp arrowheads** (0.5-1.0pt line weight)

### **7. Container Patterns**
- **Light fills** for grouping (10-15% opacity)
- **Label placement:** Top-left or bottom-center
- **Dashed borders** = logical groupings
- **Solid borders** = hard boundaries

### **8. Text Patterns**
- **Title:** Largest, bold (28-44pt)
- **Primary text:** Bold (12-14pt)
- **Secondary text:** Regular (10-11pt)
- **Mathematically centered**

### **9. Design Philosophy**
- **NO shadows, NO 3D, NO bevels**
- **Depth through tone** (gray shades)
- **Flat design** is modern professional
- **Technical precision** > artistry

---

## Design Checklist (Based on References)

When creating architecture diagrams, check:

### Layout
- [ ] Proper orientation (Top-Down or Left-Right or Hybrid)
- [ ] Cross-cutting layers if applicable
- [ ] Strict grid alignment
- [ ] 3x3 Rule of Thirds applied (focal points at intersections)

### Color
- [ ] Base palette (Slate/Navy/Charcoal) - 60%
- [ ] ONE accent color for highlights
- [ ] Tints (10-15%) for containers
- [ ] No rainbow colors

### Shapes
- [ ] Standard semantics used
- [ ] Consistent shape family
- [ ] Rectangles, cylinders, clouds as appropriate

### Borders
- [ ] Consistent weights (1.5pt standard)
- [ ] Color for hierarchy (not just thickness)
- [ ] Dashed for logical, solid for hard

### Padding
- [ ] Generous internal padding (16-24pt)
- [ ] 20% white space rule
- [ ] Text mathematically centered

### Connectors
- [ ] 90-degree angles only (NO diagonals)
- [ ] Edge connections (never center)
- [ ] Small sharp arrowheads
- [ ] Elbow connectors for turns

### Containers
- [ ] Light fills/tints
- [ ] Label at top-left/bottom-center
- [ ] Dashed = logical, solid = hard

### Text
- [ ] Title largest and bold
- [ ] Primary (Bold), Secondary (Regular)
- [ ] Centered

### Design Philosophy
- [ ] NO shadows
- [ ] NO 3D effects
- [ ] NO bevels
- [ ] Modern flat design

---

## Implementation Notes

**Color Palette Standard:**
```python
COLORS = {
    'base-primary': #2F476F,  # Navy
    'base-secondary': #64748B,  # Slate
    'accent': #0EA5E9,  # Electric Blue
    'bg-light': #F8FAFC,  # Light tint
    'text-primary': #1E293B,  # Dark gray
    'text-secondary': #64748B,  # Medium gray
}
```

**Border Weights:**
- Primary components: 1.5pt
- Primary system: 2.0pt OR Accent color
- Secondary: 1.0pt
- Logical boundaries: 1.0pt dashed

**Padding Standards:**
- Primary boxes: 16pt horizontal, 8pt vertical
- Containers: 24pt horizontal, 12pt vertical
- Icons: 8-12px from edges

**Connector Standards:**
- Line weight: 0.5pt - 1.0pt
- Arrowheads: Small, sharp triangles
- Angles: 90° or 180° only

---

## Conclusion

The reference patterns consistently show:
1. **Modern Professional flat design** (no shadows/3D)
2. **Consistent color palettes** (base + accent tint)
3. **Standard shape semantics**
4. **Generous padding** for premium look
5. **Technical precision** (90° lines, edge connections)
6. **Grid alignment** throughout
7. **Logical grouping** with containers

**Follow these patterns to create professional, modern architecture diagrams.**
