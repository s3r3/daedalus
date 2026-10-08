# Content & Scenario Templates Specification

## 1. Content Design Principles

- Fictional but hyper-realistic — named brands, imperfect numbers ($4.2M not $5M), specific dates
- Each scenario has a distinct authorial voice
- At least 1 footnote/source citation per deck
- Never use "Lorem ipsum", "Company X", or round placeholder numbers
- Data visualizations must use the style's color palette natively

## 2. Additional Slide Types (Supplement html-template.md)

### 2.1 Comparison Matrix (Multi-Column)
- Competitive analysis across 3+ options
- Table layout: feature rows × competitor columns
- Max 5-6 features to fit viewport
- Accent color highlights "us" column

### 2.2 Team / People Grid
- Headshots with initials (CSS gradient placeholders)
- Name, role, one-line background
- Max 4-6 members per slide
- Circular avatar containers with accent gradients

### 2.3 Pricing / Tiers
- 2-3 pricing cards side by side
- Highlighted "recommended" tier with accent border
- Starter / Pro / Enterprise pattern
- Feature checklists per tier

### 2.4 Architecture / Flow Diagram
- CSS-only system architecture with connected nodes
- Arrows (→) between nodes
- No images needed — pure CSS/HTML
- 3-5 nodes max

### 2.5 Agenda / Table of Contents
- Numbered section list with time estimates
- 5-6 items max
- Accent-colored numbers, time column right-aligned

## 3. Scenario Catalog

116 scenario templates organized by use case:

### 3.1 Pitch Decks (fundraising, investor meetings)
| File | Style Variants |
|------|---------------|
| pitch-deck | bold, cinema, swiss, midnight, noir, clarity, greenplate, orbital |
| pitch-deck-clarity | swiss variant |
| pitch-deck-greenplate | midnight, noir variants |
| pitch-deck-orbital | cinema, midnight, neon variants |

**Narrative arc:** Confidence → Evidence → Vision → Urgency
**Voice:** Confident, data-driven, concise

**Example Brand:** "Melo" — AI-powered fitness coaching
- $4.2M ARR, 23% MoM growth, 147K MAU
- Seed round $2.5M, 4 co-founders

### 3.2 Product Launches
| File | Style Variants |
|------|---------------|
| product-launch | bold, electric, neon, noir, clarity |
| product-launch-dji | noir variant |
| product-launch-xiaomi | bold, neon, swiss variants |

**Narrative arc:** Curiosity → Reveal → Delight → Desire
**Voice:** Excited but grounded

**Example Brand:** "Shipfast" — developer deployment tool
- 3.2x faster deploys, 47% less config
- Free / Pro $29/mo / Enterprise

### 3.3 Tech Talks (conference, meetup)
| File | Style Variants |
|------|---------------|
| tech-talk | neon, noir, swiss, paper |
| tech-talk-agent | neon, terminal variants |
| tech-talk-pipeline | noir, swiss variants |

**Narrative arc:** Surprise → Understanding → Insight → Inspiration
**Voice:** Technically precise but accessible

**Example Topic:** "How We Cut API Latency by 97% Without Rewriting Anything"
- Edge caching + connection pooling
- p99 340ms → 12ms

### 3.4 Teaching / Tutorial (classroom, workshop)
| File | Style Variants |
|------|---------------|
| teaching | morning, notebook, pastel, swiss, ux |
| teaching-python | notebook, pastel variants |
| teaching-ux | morning, swiss variants |

**Narrative arc:** Curiosity → Framework → Deep Dive → Practice → Mastery
**Voice:** Patient, clear, encouraging

**Example Topic:** "CSS Grid in 10 Minutes — From Zero to Layout"

### 3.5 Portfolio / Case Study (freelancer, agency)
| File | Style Variants |
|------|---------------|
| portfolio | noir, swiss, botanical, cinema |
| portfolio-motion | editorial, noir variants |
| portfolio-photo | botanical, ink, noir variants |

**Narrative arc:** Craft → Range → Depth → Connection
**Voice:** Craft-focused, reflective

**Example:** "Sofia Chen — Product Designer"
- +340% user engagement, 2.1M campaign views

### 3.6 E-Commerce Campaigns
| File | Style Variants |
|------|---------------|
| ecommerce-1111 | bold, electric, neon |
| ecommerce-beauty | bold, neon |
| ecommerce-product | bold, electric, neon |

### 3.7 Chinese Brand Presentations
| File | Style Variants |
|------|---------------|
| chinese-brand | botanical, cinema, fashion, starfield, wine |
| chinese-brand-fashion | botanical, cinema |
| chinese-brand-wine | botanical, cinema, ink |

### 3.8 Job Promotions (internal)
| File | Style Variants |
|------|---------------|
| job-promotion | bold, midnight, swiss |
| job-promo-cto | noir |
| job-promo-marketing | bold |
| job-promo-sales | bold |

### 3.9 Year-End Reviews
| File | Style Variants |
|------|---------------|
| year-end-review | bold, noir, swiss |
| year-end-engineering | noir |
| year-end-sales | bold, midnight |

### 3.10 Thesis Defenses (academic)
| File | Style Variants |
|------|---------------|
| thesis-defense | campus, morning, paper |
| thesis-mba | morning, swiss |
| thesis-medical | campus |

## 4. Scenario Template Structure

Each scenario file defines:
1. **Title slide** content (brand name, positioning)
2. **Narrative arc** (slide sequence with types)
3. **Content guidelines** per slide (what to say, how to say it)
4. **Example brand** with realistic numbers and names
5. **Style recommendations** (primary + alternative)

## 5. Content Principles (All Scenarios)

- Realistic specificity: named brands, imperfect numbers, specific dates
- Distinct authorial voice per scenario type
- At least one footnote/source citation per deck
- No generic placeholders
- Data visualizations use style's native color palette
