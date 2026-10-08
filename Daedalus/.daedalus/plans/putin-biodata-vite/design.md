# Design Specification

## Visual Style
- Professional, clean, minimal
- Centered card layout
- Light background (#f5f5f5)
- White card with subtle shadow
- Dark text on light background for readability
- Professional sans-serif font (system default)

## Layout

### Desktop (≥768px)
```
┌─────────────────────────────────────┐
│         [Page Header/Title]         │
│                                     │
│   ┌───────────────────────────┐    │
│   │      [Photo 200x200]      │    │
│   │                           │    │
│   │  Vladimir Vladimirovich   │    │
│   │         Putin             │    │
│   │                           │    │
│   │  Presiden Federasi Rusia  │    │
│   │                           │    │
│   │  Lahir: 7 Oktober 1952    │    │
│   │  Tempat: Leningrad, USSR  │    │
│   │                           │    │
│   │  [Career Paragraph 1]     │    │
│   │  ...                      │    │
│   │                           │    │
│   │  [Career Paragraph 2]     │    │
│   │  ...                      │    │
│   └───────────────────────────┘    │
│                                     │
└─────────────────────────────────────┘
```

### Mobile (<768px)
- Same card layout, narrower width (90% viewport)
- Photo remains 200x200
- Text wraps naturally
- Vertical padding adjusted for smaller screens

## Screens

### Main Screen (only screen)
- **Header**: "Biodata Presiden Vladimir Putin" (h1)
- **Card**:
  - Profile photo (centered, rounded or square)
  - Name (h2, bold)
  - Title (h3, lighter weight)
  - Birth info (date + place, smaller text)
  - Horizontal divider
  - Career summary (two paragraphs, justified text)

## Interaction States
- None (static page, no interactivity)

## Loading State
- Not applicable (all content static, no async data)

## Empty State
- Not applicable (data is hardcoded)

## Accessibility
- Semantic HTML (header, main, article)
- Alt text on photo: "Vladimir Putin, Presiden Rusia"
- Proper heading hierarchy (h1 → h2 → h3)
- Sufficient color contrast (WCAG AA minimum)
- Responsive text sizing (min 16px body)
