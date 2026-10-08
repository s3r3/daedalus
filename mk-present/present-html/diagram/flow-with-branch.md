# Branch Flow Diagram Pattern

For flows that include decision points and feedback loops — CI/CD pipelines,
approval workflows, incident response, etc. The existing `generate-html-flow.js`
only handles linear sequences; this pattern uses custom HTML for
branch/loop semantics.

---

## When to Use

- CI/CD pipelines with security gating
- Approval workflows with reject/fallback paths
- Incident response with escalation loops
- Any flow where a step branches (yes/no, pass/fail)

---

## Layout Structure

```
┌─────────────────────────────────────────────────────────────┐
│  [A] → [B] → [C] → [Decision] → [D] → [E] → [F]           │  ← Main pipeline (horizontal)
│                        │ (fail)                             │
│                        ▼                                    │
│                   [Fallback] → [Fix] ──── loop back ──────↩ │  ← Feedback loop (vertical below)
└─────────────────────────────────────────────────────────────┘
```

### Key Rules

1. **Main pipeline** runs horizontally across the top
2. **Decision node** has distinct visual treatment (accent border, different color for pass/fail arrows)
3. **Feedback loop** drops vertically from the decision node, placed below the pipeline
4. **Loop-back indicator** at end of feedback path — dashed line + circular arrow
5. **Actor coding** via left-border color strips:
   - System/automated → accent blue (#0EA5E9)
   - Human action → amber (#F59E0B)
   - IT/Ops → dark blue (#0284C7)

---

## HTML Implementation

**Option 1: Use `generate-html-flow.js` (v1.11+)** — Now supports elbow connectors:
- Single SVG overlay spanning full width
- L-shaped paths: `M srcX 0 L tgtX 0 L tgtX elbowY`
- All decision points connect to ONE shared "Issue Found" card

**Option 2: Custom Reveal.js slide** — For complex routing:
```css
.pipeline { display: flex; align-items: center; justify-content: center; position: relative; }
.node-card { border-radius: 10px; padding: 12px 16px; min-width: 110px; }
.arrow svg { width: 32px; height: 20px; }
```

### Elbow Connector Pattern (L-shaped, One-to-Many)
**Use case:** Multiple decision points connecting to one shared fallback card.

**Key principle:** Single SVG overlay with absolute positioning over the flow container.

```javascript
// Coordinate system: relative to flow container (0,0 = top-left of pipeline row)
const COL_W = NODE_W + ARROW_W;  // one column width

function getDecisionX(idx) {
  return idx * COL_W + NODE_W / 2;  // center of decision card
}

// Single SVG overlay for ALL elbow connectors
const connectorOverlay = `
<div style="position:relative; height:0; margin-top:6px; pointer-events:none;">
  <svg width="100%" height="${elbowDrop + 10}" 
       viewBox="0 0 ${n * COL_W} ${elbowDrop + 10}"
       style="position:absolute; top:0; left:0; overflow:visible;">
    ${decisionIndices.map(idx => {
      const srcX = getDecisionX(idx);
      const tgtX = getDecisionX(firstIdx);  // shared target = first decision point
      return `
        <path d="M ${srcX} 0 L ${tgtX} 0 L ${tgtX} ${elbowDrop}"
              stroke="${colors.baseMid}" stroke-width="1.2" 
              stroke-dasharray="3,3" fill="none"/>
        <polygon points="${tgtX - 3},${elbowDrop} ${tgtX + 3},${elbowDrop} ${tgtX},${elbowDrop + 6}" 
                  fill="${colors.baseMid}"/>`;
    }).join('')}
  </svg>
</div>`;
```

**Critical coordinate rules:**
1. `srcX` = `idx * COL_W + NODE_W / 2` (center of decision card)
2. SVG `viewBox` must span full pipeline width (`n * COL_W`)
3. Path: `M srcX 0` → `L tgtX 0` (horizontal) → `L tgtX elbowY` (vertical)
4. SVG positioned at `top:0` (not `top:100%`) — coordinates start at pipeline bottom
5. Arrowhead at `(tgtX, elbowY)` — points downward

**Pitfalls encountered:**
- ❌ `top:100%` + `srcY=0` = coordinates start at bottom of container (wrong!)
- ❌ Multiple SVG elements = overlapping, z-index issues
- ❌ Variable name mismatch (`connectorOverlay` vs `connectorSVG`) = undefined variable
- ❌ Duplicate declarations (`const firstIdx` twice) = syntax error
- ✅ **Single overlay SVG** = correct coordinate system, all paths in same space

---

## Color Scheme (per slide)

| Element | Color | Usage |
|---------|-------|-------|
| Accent | #0EA5E9 | System nodes, pass arrows |
| Danger | #EF4444 | Decision fail path, feedback loop |
| Success | #10B981 | Decision pass arrow |
| Warn | #F59E0B | Human actor left-border |
| Dark accent | #0284C7 | IT/Ops actor left-border |
| Base dark | #1E293B | Labels |
| Base mid | #475569 | Descriptions |

Single Accent Color Rule still applies: one accent per slide. Danger/success are semantic colors (not decoration).

---

## Common Pitfalls

1. **Don't use `generate-html-flow.js`** — it only does linear arrows between steps
2. **Center the pipeline** — calculate `start_x = (slide_width - total_pipeline_width) / 2`
3. **Position feedback under the decision node** — `feedback_x = start_x + decision_index * (node_w + arrow_w)`
4. **MSO_SHAPE validation** — `UTURN_ARROW` doesn't exist, use `CIRCULAR_ARROW`
5. **Inches arithmetic** — `Inches` objects don't support `+` with ints; use `.inches` property

---

## Verification Checklist

- [ ] All pipeline nodes visible in one row without wrapping
- [ ] Decision node visually distinct (different border color)
- [ ] Pass arrow green, fail arrow red + dashed
- [ ] Feedback loop positioned under correct decision node
- [ ] Loop-back indicator clearly shows re-entry point
- [ ] Legend present with actor + path explanations
- [ ] Single accent color per slide (danger/success are semantic)
- [ ] No emoji-only nodes — always pair with text label
