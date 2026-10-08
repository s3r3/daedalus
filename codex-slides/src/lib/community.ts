// Community style catalog — reusable slide design systems distilled from several
// open prompt galleries. Every item contributes the same <page_style> context to
// generation, appears in the home/project Browser, and carries source metadata so
// the README and UI can preserve attribution. Portrait-only novelty prompts are
// intentionally excluded; this catalog keeps directions that can govern a complete
// presentation or a useful presentation page family.

export type CommunityGroup =
  | "Business & Report"
  | "Infographic"
  | "Diagram"
  | "Data & Map"
  | "UI & Dashboard"
  | "Poster & Ad"
  | "Product"
  | "Brand & Identity"
  | "Architecture & Space"
  | "Photo & Cinematic"
  | "Editorial"
  | "Illustration";

export type Density = "low" | "medium" | "high";

export type CommunitySourceId =
  | "youmind-gpt-image-2"
  | "youmind-nano-banana-pro"
  | "freestylefly-gpt-image-2"
  | "jimmylv-nano-banana"
  | "muset-nano-banana-pro"
  | "jamez-gpt4o-images";

export interface CommunitySource {
  id: CommunitySourceId;
  name: string;
  url: string;
  galleryUrl?: string;
  license: "CC BY 4.0" | "MIT";
  licenseUrl: string;
  note?: string;
}

export const COMMUNITY_SOURCES: CommunitySource[] = [
  {
    id: "youmind-gpt-image-2",
    name: "YouMind Awesome GPT Image 2",
    url: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2",
    galleryUrl: "https://youmind.com/gpt-image-2-prompts",
    license: "CC BY 4.0",
    licenseUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2/blob/main/LICENSE",
  },
  {
    id: "youmind-nano-banana-pro",
    name: "YouMind Awesome Nano Banana Pro Prompts",
    url: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts",
    license: "CC BY 4.0",
    licenseUrl: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/blob/main/LICENSE",
  },
  {
    id: "freestylefly-gpt-image-2",
    name: "freestylefly Awesome GPT Image 2",
    url: "https://github.com/freestylefly/awesome-gpt-image-2",
    license: "MIT",
    licenseUrl: "https://github.com/freestylefly/awesome-gpt-image-2/blob/main/LICENSE",
  },
  {
    id: "jimmylv-nano-banana",
    name: "JimmyLv Awesome Nano Banana",
    url: "https://github.com/JimmyLv/awesome-nano-banana",
    license: "CC BY 4.0",
    licenseUrl: "https://github.com/JimmyLv/awesome-nano-banana/blob/main/LICENSE",
    note: "Individual case attribution files can override the repository default.",
  },
  {
    id: "muset-nano-banana-pro",
    name: "muset-ai Awesome Nano Banana Pro",
    url: "https://github.com/muset-ai/awesome-nano-banana-pro",
    license: "CC BY 4.0",
    licenseUrl: "https://github.com/muset-ai/awesome-nano-banana-pro/blob/main/LICENSE",
    note: "Individual case attribution files can override the repository default.",
  },
  {
    id: "jamez-gpt4o-images",
    name: "jamez-bondos Awesome GPT-4o Images",
    url: "https://github.com/jamez-bondos/awesome-gpt4o-images",
    license: "CC BY 4.0",
    licenseUrl: "https://github.com/jamez-bondos/awesome-gpt4o-images/blob/main/LICENSE",
    note: "OpenAI examples and individual case attribution files can carry separate terms.",
  },
];

export interface CommunityTemplate {
  id: string;
  name: string;
  group: CommunityGroup;
  description: string;
  tags: string[];
  palette: string[]; // hex, first = primary accent
  density: Density;
  styleBlock: string; // injected verbatim into <page_style>
  cover: string; // local public path or an attributed HTTPS preview
  author?: string;
  sourceUrl?: string;
  sourceIds?: CommunitySourceId[];
}

export const COMMUNITY_GROUPS: CommunityGroup[] = [
  "Business & Report",
  "Infographic",
  "Diagram",
  "Data & Map",
  "UI & Dashboard",
  "Poster & Ad",
  "Product",
  "Brand & Identity",
  "Architecture & Space",
  "Photo & Cinematic",
  "Editorial",
  "Illustration",
];

const NANO_BANANA_PRO_TEMPLATES: CommunityTemplate[] = [
  { id: "nb-golden-serif-quote", name: "Golden Serif Quote", group: "Editorial", description: "A warm brown quote card with a soft-faded portrait on one side and one oversized light-gold serif statement on the other.", tags: ["quote","editorial","testimonial","portrait","serif","warm","minimal","keynote"], palette: ["#C9A24B","#3B2A1F","#E8D9BE"], density: "low", styleBlock: "Warm brown canvas with a single light-gold serif voice. A portrait anchors one-third of the frame behind a soft gradient fade while an oversized subtle quotation mark and one large serif statement command the remaining two-thirds. Intimate, editorial, and quietly premium — built for a single memorable line per slide.", cover: "/community/nb-golden-serif-quote.jpg", author: "Nicolechan", sourceUrl: "https://x.com/stark_nico99/status/1991718646570426763" },
  { id: "nb-liquid-glass-bento", name: "Liquid Glass Bento", group: "Infographic", description: "An asymmetric 16:9 bento grid of transparent Apple-style liquid-glass cards floating over a blurred, color-derived ground.", tags: ["bento","glassmorphism","product","infographic","dashboard","3d","modern","premium","grid"], palette: ["#2DD4BF","#0B1220","#E8EEF5","#7C93A8"], density: "high", styleBlock: "Apple-style liquid glass over a softly blurred, color-derived ground: an asymmetric 16:9 bento grid of 85-90% transparent cards with whisper-thin borders, subtle drop shadows, and floating depth. One oversized hero cell carries a photoreal or 3D-grade centerpiece while the remaining modules hold crisp titled facts with muted-tint icons. Premium, glossy, and modular — every slide reads as a curated dashboard.", cover: "/community/nb-liquid-glass-bento.jpg", author: "Mansi Sanghani", sourceUrl: "https://x.com/MansiSanghani1/status/2013550795224961492" },
  { id: "nb-handdrawn-gradient-header", name: "Hand-Drawn Header", group: "Illustration", description: "A loose, italic hand-drawn illustration under a blue-to-green gradient with a clear title band, styled like an explainer header.", tags: ["hand-drawn","illustration","header","gradient","casual","education","intro","friendly"], palette: ["#2FBF9F","#2E86AB","#F5F7F2"], density: "low", styleBlock: "Loose hand-drawn illustration washed in a blue-to-green gradient, with light italic sketch linework and an approachable, human feel. A simple illustrated character or motif sits beside a clear title band in 16:9, like the header of a well-designed explainer. Casual, warm, and inviting — good for intros, section openers, and lightweight topics.", cover: "/community/nb-handdrawn-gradient-header.jpg", author: "セミナー講師専門AIコンシェルジュ｜工藤 晶", sourceUrl: "https://x.com/akirakudo_ai/status/1992096860765561190" },
  { id: "nb-watercolor-map", name: "Watercolor Annotated Map", group: "Data & Map", description: "Soft watercolor regions on off-white paper, each zone hand-labeled in fine ballpoint-pen script.", tags: ["map","watercolor","education","geography","hand-drawn","annotated","segmentation","data"], palette: ["#7FB2C9","#F3EDE0","#4A4A4A","#C98B6B"], density: "medium", styleBlock: "Soft watercolor washes on off-white paper, regions bleeding into gentle pastel fields, every zone hand-labeled in fine ballpoint-pen script. An artful, tactile take on cartography and territory diagrams that trades cold precision for warmth. Educational and charming — ideal for geographies, segmentations, or any 'map of a space'.", cover: "/community/nb-watercolor-map.jpg", author: "Florian Gallwitz", sourceUrl: "https://x.com/FlorianGallwitz/status/1991796624646091091" },
  { id: "nb-vintage-patent", name: "Vintage Patent Filing", group: "Diagram", description: "An aged 1800s patent filing with numbered technical drawings, fountain-pen notes, an embossed seal, and a red wax stamp.", tags: ["vintage","patent","diagram","technical","archival","blueprint","retro","annotated"], palette: ["#8B2A1F","#E8DCC0","#3A2E1F"], density: "medium", styleBlock: "A recovered 1800s patent filing: aged ivory paper with foxing stains and fold creases, precise technical line drawings with numbered callouts (Fig. 1, Fig. 2), and fountain-pen annotations describing each part. An embossed seal and red wax stamp anchor a corner while a signature and date close the page. Authoritative, historic, and slightly mysterious — turns any mechanism or concept into an archival document.", cover: "/community/nb-vintage-patent.jpg", author: "Alexandra Aisling", sourceUrl: "https://x.com/AllaAisling/status/2004212035333365763" },
  { id: "nb-chalkboard-lesson", name: "Chalkboard Lesson", group: "Infographic", description: "A teacher's chalkboard of hand-written notes, quick diagrams, arrows, and circled key terms in white and pastel chalk.", tags: ["chalkboard","hand-drawn","education","summary","diagram","notes","casual","teaching"], palette: ["#E4B95B","#1F2A24","#F4F1E9","#6FB2A0"], density: "high", styleBlock: "A teacher's chalkboard: a dark slate ground filled with hand-written chalk lettering, quick sketched diagrams, arrows, and circled key terms in white with pastel chalk accents. Content is broken into approachable, explained beats as if drawn live during a lesson. Warm, informal, and genuinely instructive — perfect for summaries, how-it-works breakdowns, and study notes.", cover: "/community/nb-chalkboard-lesson.jpg", author: "ひでもん | AI開発@ニュース発信", sourceUrl: "https://x.com/okknews/status/1992173611520868372" },
  { id: "nb-bold-product-ad", name: "Bold Product Ad", group: "Poster & Ad", description: "A bold commercial ad with a dimensional 3D product hero wrapped in loud promotional copy and ranking badges.", tags: ["advertising","product","marketing","promo","poster","bold","launch","commercial"], palette: ["#E63946","#1A1A1A","#FFFFFF","#F0C808"], density: "medium", styleBlock: "A punchy commercial ad layout: a single product rendered in dimensional 3D hero placement, wrapped in bold promotional copy, ranking badges, and a loud pre-head banner. High-contrast type stacks and accent call-outs sell one offer hard. Confident, retail-ready, and conversion-minded — built to make a product the unmistakable star of the slide.", cover: "/community/nb-bold-product-ad.jpg", author: "KAWAI", sourceUrl: "https://x.com/kawai_design/status/1992142466255114727" },
  { id: "nb-hyperreal-product-poster", name: "Hyperreal Product Poster", group: "Poster & Ad", description: "Hyper-real advertising photography of a product hero caught in an authentic action moment under warm golden light.", tags: ["advertising","product","photography","marketing","poster","lifestyle","premium","realistic"], palette: ["#A7D129","#F6E23A","#FFFFFF","#B7C9C4"], density: "medium", styleBlock: "Hyper-real advertising photography with an official-campaign polish: a product hero — condensation, micro-bubbles, crisp highlights — caught in an authentic real-world moment under warm golden light. A disciplined composition budget hands most of the frame to human action and product, keeping environment and tight typography minimal. Vivid, premium, and believable — a flagship brand poster for any product.", cover: "/community/nb-hyperreal-product-poster.jpg", author: "ᴍᴜʀᴘʜʏ", sourceUrl: "https://x.com/Diplomeme/status/2075083065127571574" },
  { id: "nb-technical-cutaway", name: "Technical Cutaway", group: "Diagram", description: "A hyper-realistic cutaway on white that opens the subject to reveal detailed interior components with thin-line callouts.", tags: ["cutaway","technical","diagram","product","engineering","education","realistic","callouts"], palette: ["#D64541","#FFFFFF","#1D1D1F","#8A8F98"], density: "medium", styleBlock: "A hyper-realistic cutaway on a clean white background: the subject sliced open to reveal densely detailed interior components, each named by a thin-line text callout. High-focus rendering treats the object like a museum specimen. Precise, technical, and premium — turns any product, tool, or structure into an authoritative 'how it's built' slide.", cover: "/community/nb-technical-cutaway.jpg", author: "Pierrick Chevallier | IA", sourceUrl: "https://x.com/CharaspowerAI/status/2073104523476828533" },
  { id: "nb-3d-character-storyboard", name: "3D Character Storyboard", group: "Infographic", description: "A crisp white storyboard poster with hard black borders, bold type, and dramatic Pixar-style 3D stylized renders.", tags: ["3d","storyboard","character","infographic","playful","process","narrative","bold"], palette: ["#FF5A1F","#FFFFFF","#111111","#E01E37"], density: "high", styleBlock: "A crisp storyboard poster: white ground, hard black panel borders, and bold black typography framing premium Pixar-style 3D stylized renders. Dramatic saturated lighting gives each character or scene cinematic punch across a wide 16:9 grid. Playful yet structured — great for profiles, journeys, and step-by-step narratives with personality.", cover: "/community/nb-3d-character-storyboard.jpg", author: "𝐌", sourceUrl: "https://x.com/Strength04_X/status/2071466852614816182" },
  { id: "nb-luminous-scan-render", name: "Luminous Scan Render", group: "Illustration", description: "A single subject rendered as luminous, semi-transparent glowing tissue floating on a clean white-to-grey gradient.", tags: ["3d","medical","glow","render","hero","futuristic","minimal","technical"], palette: ["#2BE38A","#F2F5F3","#0D1B12","#7CF2B8"], density: "low", styleBlock: "An advanced medical-scan aesthetic: a single subject rendered as luminous, semi-transparent structure — interwoven lit fibers, nodes, and glowing pathways — floating on a clean white-to-grey gradient. Minimalist, high-focus, and text-free, letting the glowing form carry the slide. Clean, technological, and futuristic — a striking hero visual for anatomy, systems, or anything you want to show 'lit from within'.", cover: "/community/nb-luminous-scan-render.jpg", author: "Dera | Performance marketing Creative", sourceUrl: "https://x.com/Ifekaego1/status/2068607373200039956" },
  { id: "nb-summary-infographic", name: "Summary Infographic", group: "Infographic", description: "A clean infographic that organizes a complex subject into grouped cards, icons, and short labeled facts.", tags: ["infographic","summary","education","relationships","cards","data","structured","overview"], palette: ["#2563EB","#0F172A","#F8FAFC","#F59E0B"], density: "high", styleBlock: "A clean summary infographic that organizes a complex subject into a legible visual hierarchy: grouped cards, portraits or icons, connecting lines, and short labeled facts arranged for fast comprehension. Structure over decoration, with a restrained accent guiding the eye through relationships. Clear, encyclopedic, and information-dense — built to make a tangled topic instantly scannable.", cover: "/community/nb-summary-infographic.jpg", author: "ファーラ@ガンプラ", sourceUrl: "https://x.com/Live_05/status/2065366252391113120" },
  { id: "nb-retro-industrial-concept", name: "Retro Industrial Concept", group: "Product", description: "A realistic alternate-history render reimagining an object through muted mid-century industrial design.", tags: ["retro","industrial","product","concept","vintage","design","render","realistic"], palette: ["#B04A3A","#6E7B6B","#C9C1AE","#2E2E2C"], density: "low", styleBlock: "A realistic alternate-history industrial render: a designed object reimagined through mid-century engineering — a muted utilitarian palette, honest materials, restrained chrome, and period-correct forms. Photographic lighting sells it as a genuine archival product shot. Retro, tactile, and conceptual — ideal for design concepts, 'what-if' variants, and heritage-flavored product stories.", cover: "/community/nb-retro-industrial-concept.jpg", author: "Riccardo", sourceUrl: "https://x.com/Riccardo_Nero/status/2065184321514664239" },
  { id: "nb-neo-parametric-editorial", name: "Neo-Parametric Editorial", group: "Editorial", description: "Painterly editorial illustration fused with blueprint overlays in a luxury ivory, gold, and steel-blue palette.", tags: ["editorial","illustration","blueprint","technical","luxury","parametric","schematic","sophisticated"], palette: ["#C9A96A","#F0EBE0","#4A5568","#6B8BA3"], density: "medium", styleBlock: "Neo-parametric editorial illustration: elegant painterly rendering fused with blueprint overlays — flowing linework, cross-hatching, drafting grids, dimensional annotations, and engineering schematics threaded through the subject. A luxury palette of ivory, champagne gold, graphite, and steel blue sits under soft cinematic light with controlled line density. Intellectual, futuristic, and museum-grade — where organic form meets technical drawing.", cover: "/community/nb-neo-parametric-editorial.jpg", author: "zayan", sourceUrl: "https://x.com/HustleXR/status/2064955550971121953" },
  { id: "nb-pastel-chalk-knolling", name: "Pastel Chalk Knolling", group: "Illustration", description: "Soft pastel chalk specimens arranged in a top-down knolling grid with a larger hero piece at center.", tags: ["knolling","chalk","illustration","grid","collection","pastel","comparison","catalog"], palette: ["#B7D84B","#F3E9D2","#E39FB0","#7FB6C9"], density: "medium", styleBlock: "Soft pastel chalk-art specimens arranged in a precise top-down knolling grid, with visible chalk dust and paper grain and one larger hero piece anchoring the center. Gently blended colors sit on a saturated flat ground with clean negative space. Tactile, curated, and calm — a beautiful way to lay out a collection, taxonomy, or set of comparable items.", cover: "/community/nb-pastel-chalk-knolling.jpg", author: "Heather Green", sourceUrl: "https://x.com/heathergreen/status/2063412874232352859" },
  { id: "nb-watercolor-moodboard", name: "Watercolor Moodboard", group: "Editorial", description: "A watercolor lifestyle moodboard of painted vignettes, handwritten script titles, and short notes on off-white paper.", tags: ["watercolor","moodboard","editorial","collage","lifestyle","handwritten","travel","artisanal"], palette: ["#6B7A4F","#8B6A4A","#C9A24B","#F0EAD9"], density: "medium", styleBlock: "A watercolor lifestyle moodboard: a central figure or subject surrounded by loose painted vignettes, elegant handwritten script titles, and short bulleted notes on off-white paper texture. An earthy palette of greens, browns, and warm washes ties the collage together. Romantic, artisanal, and story-driven — perfect for narratives, brand worlds, and travel-flavored themes.", cover: "/community/nb-watercolor-moodboard.jpg", author: "Minahil", sourceUrl: "https://x.com/Minahil42298354/status/2063186164043903032" },
  { id: "nb-engineering-blueprint-grid", name: "Engineering Blueprint Grid", group: "Diagram", description: "A dense engineering infographic grid of photoreal cutaways, exploded views, dimension lines, and color-coded arrows.", tags: ["engineering","blueprint","diagram","exploded","technical","grid","product","industrial"], palette: ["#2563EB","#FFFFFF","#111111","#EA580C"], density: "high", styleBlock: "An ultra-detailed engineering infographic: a clean ground split by sharp separator lines into a precise grid, each cell holding a photoreal 3D render with transparent cutaways, exploded views, dimension lines, callout boxes, and color-coded engineering arrows. Apple-style industrial-design documentation, dense with precise technical labels. Rigorous, high-end, and authoritative — the definitive 'anatomy of the product' layout.", cover: "/community/nb-engineering-blueprint-grid.jpg", author: "⁠ luciaAI", sourceUrl: "https://x.com/luciaverseai/status/2062938095109255382" },
  { id: "nb-multi-angle-grid", name: "Multi-Angle Photo Grid", group: "Product", description: "One subject shown from many angles tiled into a clean nine-square grid against a softly blurred natural backdrop.", tags: ["grid","photography","product","multi-angle","showcase","gallery","perspective","collage"], palette: ["#6FA8DC","#7FA05A","#E8E2D0","#3B3B3B"], density: "medium", styleBlock: "One subject shot from many vantage points and tiled into a clean nine-square grid — distant, medium, and close-up framings mixing angles and crops against a softly blurred natural backdrop. Consistent light and color unify the panels into a single study. Cinematic and comprehensive — a strong way to present a subject, product, or place from every side on one slide.", cover: "/community/nb-multi-angle-grid.jpg", author: "coloringany.com", sourceUrl: "https://x.com/zhoumeng780/status/2062066820656550311" },
  { id: "nb-visual-info-guide", name: "Visual Info Guide", group: "Data & Map", description: "A real photo turned into an annotated information-visualization guide with labeled points and short descriptive notes.", tags: ["guide","infographic","annotated","location","travel","overlay","education","map"], palette: ["#0EA5E9","#F8FAFC","#0F172A","#F59E0B"], density: "medium", styleBlock: "A photo transformed into an information-visualization guide: the real scene kept as the backdrop while clean overlays — annotation lines, labeled points of interest, stat chips, and short descriptive notes — explain what you're looking at. Editorial infographic polish sits lightly over authentic imagery. Informative and immersive — turns any place, object, or scene into a guided, annotated overview.", cover: "/community/nb-visual-info-guide.jpg", author: "AI探路者Tim", sourceUrl: "https://x.com/AIExplorerTim/status/2062017023081848863" },
  { id: "nb-exploded-layers", name: "Exploded Layer Stack", group: "Infographic", description: "A hyper-real exploded breakdown of stacked horizontal layers, each tagged with a thin pointer line on a bright studio ground.", tags: ["exploded","layers","infographic","product","cross-section","breakdown","studio","food"], palette: ["#F5C518","#FFFFFF","#1A1A1A","#E07A2F"], density: "medium", styleBlock: "A hyper-real exploded breakdown: the subject separated into cleanly aligned horizontal layers stacked top-to-bottom, each tagged with a thin pointer line and a short label, floating on a bright seamless studio background. Commercial-photography lighting gives every layer crisp reflections and soft shadows. Appetizing, premium, and self-explaining — the ideal 'what's inside, layer by layer' slide.", cover: "/community/nb-exploded-layers.jpg", author: "𝐌", sourceUrl: "https://x.com/Strength04_X/status/2061027904738496976" },
  { id: "nb-lifestyle-product-shot", name: "Lifestyle Product Shot", group: "Product", description: "Bright, sun-drenched lifestyle photography with a model presenting a razor-sharp product in a joyful outdoor scene.", tags: ["product","lifestyle","photography","marketing","bright","outdoor","aspirational","hero"], palette: ["#12B5C9","#F4C542","#5EC8E5","#FFF6E5"], density: "low", styleBlock: "Bright, sun-drenched lifestyle product photography: a happy model presents the product straight to camera with a shallow depth of field keeping the item razor-sharp against a joyful outdoor scene. Natural sunlight, a warm vibrant palette, and a slightly elevated angle sell mood and use in one shot. Energetic, aspirational, and human — makes any product feel like part of a good day.", cover: "/community/nb-lifestyle-product-shot.jpg", author: "Maddox", sourceUrl: "https://x.com/Maddox_Digital/status/2074154537259356554" },
  { id: "nb-editorial-action-poster", name: "Editorial Action Poster", group: "Poster & Ad", description: "A full-bleed action poster with enormous cropped cream block type and a hero subject breaking through the letters.", tags: ["poster","editorial","advertising","bold","typography","action","marketing","dynamic"], palette: ["#FF4D2E","#3FA9E0","#F3E8CE","#FFFFFF"], density: "medium", styleBlock: "A full-bleed editorial action poster: enormous warm-cream extra-condensed block letters cropped by the frame and sitting behind a hero subject that cuts diagonally across and breaks through the type layer. Hard midday sun, crisp shadows, a sky-blue neutral environment, one vivid accent on the hero, and tight clusters of white microcopy pinned to a strong grid. Kinetic, loud, and magazine-grade — action first, type second, detail third.", cover: "/community/nb-editorial-action-poster.jpg", author: "H A J R A", sourceUrl: "https://x.com/codewithhajra/status/2073422730171478176" },
];

const GROUP_PALETTES: Record<CommunityGroup, string[]> = {
  "Business & Report": ["#155EEF", "#0F172A", "#F8FAFC", "#94A3B8"],
  Infographic: ["#2563EB", "#0F172A", "#F8FAFC", "#F59E0B"],
  Diagram: ["#0F766E", "#0F172A", "#F0FDFA", "#FB7185"],
  "Data & Map": ["#0284C7", "#082F49", "#F0F9FF", "#F59E0B"],
  "UI & Dashboard": ["#6366F1", "#111827", "#F8FAFC", "#22D3EE"],
  "Poster & Ad": ["#FF4D2E", "#111111", "#FFF7ED", "#FACC15"],
  Product: ["#0EA5E9", "#172554", "#F8FAFC", "#A3E635"],
  "Brand & Identity": ["#7C3AED", "#18181B", "#FAFAFA", "#F59E0B"],
  "Architecture & Space": ["#B45309", "#292524", "#F5F5F4", "#84A98C"],
  "Photo & Cinematic": ["#F97316", "#171717", "#FAFAF9", "#60A5FA"],
  Editorial: ["#B08968", "#292524", "#FAF7F2", "#64748B"],
  Illustration: ["#EC4899", "#312E81", "#FFF7ED", "#22C55E"],
};

type CommunityTemplateSeed = Omit<CommunityTemplate, "palette" | "density"> & {
  palette?: string[];
  density?: Density;
};

function catalogTemplate(seed: CommunityTemplateSeed): CommunityTemplate {
  return {
    ...seed,
    tags: Array.from(new Set([...seed.tags, seed.group.toLowerCase()])),
    palette: seed.palette ?? GROUP_PALETTES[seed.group],
    density: seed.density ?? "medium",
  };
}

const FREESTYLE_COVER_ROOT = "https://cdn.jsdelivr.net/gh/freestylefly/awesome-gpt-image-2@main/data/images/";
const FREESTYLE_SOURCE = "https://github.com/freestylefly/awesome-gpt-image-2/blob/main/data/style-library.json";

function freestyleTemplate(seed: Omit<CommunityTemplateSeed, "cover" | "author" | "sourceUrl" | "sourceIds"> & { cover: string }) {
  const { cover, ...template } = seed;
  return catalogTemplate({
    ...template,
    cover: `${FREESTYLE_COVER_ROOT}${cover}`,
    author: "freestylefly",
    sourceUrl: FREESTYLE_SOURCE,
    sourceIds: ["freestylefly-gpt-image-2", "youmind-gpt-image-2"],
  });
}

const FREESTYLE_TEMPLATES: CommunityTemplate[] = [
  freestyleTemplate({ id: "gi2-ui-screenshot-system", name: "UI Screenshot System", group: "UI & Dashboard", description: "High-fidelity app, web, dashboard, and social-interface compositions.", tags: ["ui", "dashboard", "saas", "interface", "screenshot", "产品界面", "仪表盘"], styleBlock: "Use a disciplined product grid, exact visible UI copy, credible navigation chrome, modular cards, charts, and platform-specific spacing. Render as a polished product screenshot rather than a generic wireframe.", cover: "case17.jpg", density: "high" }),
  freestyleTemplate({ id: "gi2-infographic-engine", name: "Infographic Engine", group: "Infographic", description: "Structured explainers, timelines, knowledge maps, and modular visual summaries.", tags: ["infographic", "timeline", "knowledge map", "explainer", "education", "信息图", "时间线"], styleBlock: "Build three to five clearly separated modules with short labels, directional arrows, restrained icons, and one obvious reading path. Favor comprehension, visual hierarchy, and clean spacing over decoration.", cover: "case334.png", density: "high" }),
  freestyleTemplate({ id: "gi2-scientific-scale-diagram", name: "Scientific Scale Diagram", group: "Diagram", description: "Micro-to-macro scientific plates with labeled detail windows and scale changes.", tags: ["science", "scale", "microscope", "diagram", "education", "科普", "尺度"], styleBlock: "Arrange six to eight distinct scale frames from macro to micro. Show units, magnification, crisp specimen details, and concise labels in an authoritative scientific-publication system.", cover: "case341.jpg", density: "high" }),
  freestyleTemplate({ id: "gi2-poster-layout-system", name: "Poster Layout System", group: "Poster & Ad", description: "A flexible event, product, movie, or campaign poster with strong hierarchy.", tags: ["poster", "campaign", "event", "typography", "cover", "海报", "活动"], styleBlock: "Lock one unmistakable hero visual, one dominant headline, a compact information block, and decisive negative space. Use an intentional crop and a limited campaign palette.", cover: "case345.jpg" }),
  freestyleTemplate({ id: "gi2-sports-campaign-poster", name: "Sports Campaign Poster", group: "Poster & Ad", description: "Commercial athlete-led campaign visuals with dramatic energy and data overlays.", tags: ["sports", "athlete", "campaign", "poster", "commercial", "体育", "运动"], styleBlock: "Use a dynamic athlete pose, dramatic directional light, a branded hero prop, bold condensed type, and small performance-stat overlays. Keep movement readable and premium.", cover: "case350.jpg" }),
  freestyleTemplate({ id: "gi2-conceptual-typography-poster", name: "Conceptual Typography Poster", group: "Editorial", description: "Premium title-led compositions where typography becomes the main visual structure.", tags: ["typography", "concept", "editorial", "poster", "title", "字体", "概念"], styleBlock: "Make the exact title the hero: oversized custom letterforms interact with figures, objects, or landscape in a controlled editorial composition. Keep secondary copy sparse and precisely aligned.", cover: "case355.jpg", density: "low" }),
  freestyleTemplate({ id: "gi2-ink-double-exposure", name: "Ink Double Exposure", group: "Editorial", description: "A quiet portrait-and-landscape composition in layered Chinese ink atmosphere.", tags: ["ink", "double exposure", "portrait", "classical", "poetry", "水墨", "双重曝光"], styleBlock: "Blend a portrait silhouette with ink landscape, mist, paper texture, and generous negative space. Use restrained calligraphic accents and a quiet museum-poster hierarchy.", cover: "case359.jpg", density: "low" }),
  freestyleTemplate({ id: "gi2-nature-science-poster", name: "Nature Science Poster", group: "Infographic", description: "Minimal product-style science posters for plants, animals, and natural systems.", tags: ["nature", "science", "specimen", "poster", "education", "自然", "科普"], styleBlock: "Isolate one natural subject like a premium specimen, pair it with a short scientific label and two or three factual callouts, then preserve abundant whitespace and soft realistic shadows.", cover: "case339.jpg", density: "low" }),
  freestyleTemplate({ id: "gi2-product-commerce-visual", name: "Product Commerce Visual", group: "Product", description: "Product hero shots, packaging, selling points, and detail-page layouts.", tags: ["product", "commerce", "packaging", "ecommerce", "benefits", "电商", "产品"], styleBlock: "Give the product a dominant studio-lit hero position, surround it with a few benefit labels and supporting props, and separate product, proof, and offer into a conversion-minded composition.", cover: "case373.jpg" }),
  freestyleTemplate({ id: "gi2-personalized-beauty-report", name: "Personalized Beauty Report", group: "Business & Report", description: "A polished diagnosis-and-recommendation report for beauty or lifestyle products.", tags: ["beauty", "report", "recommendation", "diagnosis", "shopping", "报告", "推荐"], styleBlock: "Use a clean report hierarchy with diagnosis summary, evidence or ratings, recommendation cards, and aligned product imagery. Keep it clinical enough to trust and warm enough to feel personal.", cover: "case353.jpg", density: "high" }),
  freestyleTemplate({ id: "gi2-brand-identity-package", name: "Brand Identity Package", group: "Brand & Identity", description: "A complete identity board with logo, palette, typography, and applications.", tags: ["brand", "identity", "logo", "palette", "typography", "品牌", "视觉识别"], styleBlock: "Present a coherent identity system on one board: primary and secondary marks, color swatches, type pairing, graphic motif, and two or three realistic applications aligned to one grid.", cover: "case354.jpg", density: "high" }),
  freestyleTemplate({ id: "gi2-brand-touchpoint-board", name: "Brand Touchpoint Board", group: "Brand & Identity", description: "A campaign rollout board spanning packaging, social, web, and display contexts.", tags: ["brand", "campaign", "touchpoint", "packaging", "social", "品牌触点", "活动"], styleBlock: "Arrange multiple branded touchpoints as a premium presentation board. Keep one palette, one typographic logic, and one graphic system consistent across every mockup.", cover: "case362.jpg", density: "high" }),
  freestyleTemplate({ id: "gi2-architecture-space", name: "Architecture & Space", group: "Architecture & Space", description: "Interior, exterior, city-map, and spatial-concept presentation visuals.", tags: ["architecture", "interior", "urban", "space", "map", "建筑", "空间"], styleBlock: "Define viewpoint, scale, materials, lighting, and spatial function with architectural clarity. Combine one immersive render with a plan, material strip, or small annotated spatial facts.", cover: "case331.png" }),
  freestyleTemplate({ id: "gi2-realistic-photography", name: "Realistic Photography", group: "Photo & Cinematic", description: "Lens-aware documentary and commercial photography with believable texture.", tags: ["photography", "realistic", "lens", "documentary", "film", "摄影", "纪实"], styleBlock: "Specify camera distance, lens character, motivated light, natural texture, and a believable environment. Preserve small imperfections and restrained grading so the image feels photographed, not rendered.", cover: "case377.jpg", density: "low" }),
  freestyleTemplate({ id: "gi2-candid-street-moment", name: "Candid Street Moment", group: "Photo & Cinematic", description: "A spontaneous phone-photo frame with motion, context, and documentary tension.", tags: ["street", "candid", "phone photo", "motion", "documentary", "街拍", "瞬间"], styleBlock: "Capture the exact unscripted moment from a plausible camera height with imperfect framing, contextual street detail, slight motion blur, and available light. Avoid staged advertising polish.", cover: "case376.jpg", density: "low" }),
  freestyleTemplate({ id: "gi2-illustration-art-style", name: "Illustration Art Direction", group: "Illustration", description: "A flexible art-directed illustration system for watercolor, ink, anime, or mixed media.", tags: ["illustration", "watercolor", "ink", "anime", "art", "插画", "绘画"], styleBlock: "Choose one explicit medium and preserve its material behavior across the slide. Coordinate composition, palette, brush texture, depth, and small type so the illustration feels authored and consistent.", cover: "case346.jpg" }),
  freestyleTemplate({ id: "gi2-character-design-sheet", name: "Character Design Sheet", group: "Illustration", description: "A consistent character sheet with pose, expression, and detail views.", tags: ["character", "pose", "sheet", "expression", "story", "角色", "设定"], styleBlock: "Use a structured design-sheet grid with one hero pose, several action or expression studies, concise callouts, and invariant identity anchors such as face, hairstyle, outfit, and proportions.", cover: "case347.jpg", density: "high" }),
  freestyleTemplate({ id: "gi2-3d-collectible-toy", name: "3D Collectible Toy", group: "Product", description: "A premium collectible-figure presentation with packaging and display details.", tags: ["3d", "toy", "collectible", "packaging", "character", "手办", "盲盒"], styleBlock: "Render a high-quality collectible at a believable scale with controlled materials, product lighting, a display base, and packaging details. Present it like a premium launch board, not a loose character render.", cover: "case378.jpg" }),
  freestyleTemplate({ id: "gi2-scene-storytelling", name: "Scene Storytelling", group: "Photo & Cinematic", description: "Narrative scenes and storyboards built around emotion, conflict, and camera framing.", tags: ["story", "scene", "storyboard", "cinematic", "worldbuilding", "故事", "分镜"], styleBlock: "Stage a specific who, where, when, conflict, and emotion. Use cinematic framing and a small sequence or supporting beat so every environmental detail advances the narrative.", cover: "case330.png" }),
  freestyleTemplate({ id: "gi2-history-classical-themes", name: "History & Classical Themes", group: "Editorial", description: "Traditional motifs, dynasty references, poetry, and scroll-style narrative.", tags: ["history", "classical", "scroll", "poetry", "culture", "历史", "古典"], styleBlock: "Use period-aware clothing, objects, architecture, and motif references inside a deliberate scroll, album-page, or archival-poster format. Keep cultural detail specific and the hierarchy calm.", cover: "case375.jpg" }),
  freestyleTemplate({ id: "gi2-document-publishing", name: "Document & Publishing", group: "Business & Report", description: "White-paper, manual, report, and encyclopedic page systems.", tags: ["report", "white paper", "manual", "publishing", "business", "报告", "白皮书", "商业汇报"], styleBlock: "Use a disciplined publication grid with readable headings, columns, tables, figures, page furniture, and a restrained evidence-first hierarchy suitable for executive review.", cover: "case360.jpg", density: "high" }),
  freestyleTemplate({ id: "gi2-concept-product-breakdown", name: "Concept Product Breakdown", group: "Diagram", description: "R&D boards, exploded views, and technical concept presentations.", tags: ["r&d", "exploded", "technical", "product", "callout", "研发", "拆解"], styleBlock: "Combine a dominant concept render with exploded components, material logic, numbered callouts, and concise engineering notes on a controlled technical board.", cover: "case370.jpg", density: "high" }),
];

const GPT4O_COVER_ROOT = "https://cdn.jsdelivr.net/gh/jamez-bondos/awesome-gpt4o-images@main/cases/";

function gpt4oTemplate(seed: Omit<CommunityTemplateSeed, "cover" | "sourceUrl" | "sourceIds"> & { caseId: number; cover: string }) {
  const { caseId, cover, ...template } = seed;
  return catalogTemplate({
    ...template,
    cover: `${GPT4O_COVER_ROOT}${caseId}/${cover}`,
    sourceUrl: `https://github.com/jamez-bondos/awesome-gpt4o-images/tree/main/cases/${caseId}`,
    sourceIds: ["jimmylv-nano-banana", "muset-nano-banana-pro", "jamez-gpt4o-images"],
  });
}

const GPT4O_TEMPLATES: CommunityTemplate[] = [
  gpt4oTemplate({ id: "gpt4o-real-object-doodle-ad", name: "Real Object + Doodle Ad", group: "Poster & Ad", description: "A clever real product or object interacting with loose black-ink doodles on white.", tags: ["doodle", "advertising", "minimal", "concept", "product", "涂鸦", "创意广告"], styleBlock: "Place one photoreal object on a pure white ground, let playful hand-drawn black ink interact with it as the central idea, and add one bold headline plus a small brand lockup. Keep it witty, sparse, and high contrast.", caseId: 100, cover: "creative-ad-real-object-hand-drawn-doodle.png", author: "azed_ai", density: "low" }),
  gpt4oTemplate({ id: "gpt4o-ancient-treasure-map", name: "Ancient Treasure Map", group: "Data & Map", description: "A modern route or geography translated into an aged hand-illustrated treasure map.", tags: ["map", "treasure", "vintage", "geography", "route", "地图", "复古"], styleBlock: "Render the geography on warm aged parchment with hand-inked coastlines, landmarks, compass ornament, route markers, and restrained red accents. Preserve spatial relationships while embracing an adventurous archival mood.", caseId: 91, cover: "case.png", author: "umesh_ai" }),
  gpt4oTemplate({ id: "gpt4o-glowing-anatomy", name: "Glowing Anatomy Lines", group: "Diagram", description: "A dark anatomical or systems diagram traced by luminous colored pathways.", tags: ["anatomy", "medical", "glow", "system", "diagram", "医疗", "系统图"], styleBlock: "Isolate the subject against a deep neutral background and reveal its internal structure through precise luminous pathways, nodes, and fine labels. Use one electric accent color and generous black space.", caseId: 83, cover: "case.png", author: "umesh_ai" }),
  gpt4oTemplate({ id: "gpt4o-city-weather-card", name: "City Weather Card", group: "Data & Map", description: "A location-led weather or KPI card combining a miniature city scene with readable data.", tags: ["weather", "city", "data", "dashboard", "map", "城市", "天气"], styleBlock: "Blend an unmistakable city landmark scene with a compact forecast or KPI system: large primary metric, small daily cards, simple icons, and climate-aware atmosphere. Keep the data instantly readable.", caseId: 82, cover: "example.png", author: "dotey", density: "high" }),
  gpt4oTemplate({ id: "gpt4o-code-business-card", name: "Code Business Card", group: "Brand & Identity", description: "A developer identity card styled as a crisp syntax-highlighted code panel.", tags: ["code", "business card", "developer", "identity", "terminal", "代码", "名片"], styleBlock: "Use a dark editor-like panel, accurate monospace syntax colors, a tight personal-information hierarchy, and subtle window chrome. Keep the identity details legible and the code metaphor restrained.", caseId: 80, cover: "example_business_card_code_style.png", author: "umesh_ai" }),
  gpt4oTemplate({ id: "gpt4o-nostalgic-anime-poster", name: "Nostalgic Anime Poster", group: "Poster & Ad", description: "A hand-painted retro anime movie poster with emotional lighting and aged print texture.", tags: ["anime", "poster", "nostalgia", "film", "illustration", "动漫", "电影海报"], styleBlock: "Compose a cinematic illustrated hero scene with expressive 1980s-90s anime linework, painted skies, limited warm-cool color contrast, bold title typography, and subtle aged-print grain.", caseId: 76, cover: "example_anime_nostalgic_poster.png", author: "photis" }),
  gpt4oTemplate({ id: "gpt4o-cyberpunk-miniature", name: "Cyberpunk Miniature City", group: "Architecture & Space", description: "A dense neon city rendered as a tilt-shift tabletop miniature.", tags: ["cyberpunk", "city", "miniature", "architecture", "neon", "赛博朋克", "城市"], styleBlock: "Use a high oblique or isometric view, shallow depth of field, rain-slick neon streets, tiny believable activity, and miniature-model scale cues. Reserve clear space for one title and a few urban facts.", caseId: 71, cover: "example_cyberpunk_tilt_shift_miniature.jpg", author: "terry623" }),
  gpt4oTemplate({ id: "gpt4o-poetic-silhouette", name: "Poetic Silhouette", group: "Photo & Cinematic", description: "A minimal silhouette composition that uses light and negative space for emotional impact.", tags: ["silhouette", "minimal", "poetic", "cinematic", "light", "剪影", "留白"], styleBlock: "Build the frame around one readable silhouette, a single dramatic light source, atmospheric depth, and abundant negative space. Use minimal editorial type and let the emotional image carry the slide.", caseId: 69, cover: "example_silhouette_art.png", author: "umesh_ai", density: "low" }),
  gpt4oTemplate({ id: "gpt4o-futurist-logo-card", name: "Futurist Logo Trading Card", group: "Brand & Identity", description: "A premium metallic trading card that turns a logo into a collectible brand artifact.", tags: ["logo", "trading card", "metallic", "brand", "futuristic", "品牌", "卡片"], styleBlock: "Center the logo as a dimensional emblem on a precision-engineered collectible card with metallic materials, fine borders, serial details, and a restrained futuristic glow.", caseId: 68, cover: "example_trading_card_logo_tesla.png", author: "hewarsaber" }),
  gpt4oTemplate({ id: "gpt4o-color-vector-poster", name: "Color Vector Travel Poster", group: "Poster & Ad", description: "A saturated geometric vector poster built from bold flat shapes and landmark silhouettes.", tags: ["vector", "travel", "poster", "geometric", "color", "矢量", "旅行"], styleBlock: "Use crisp flat vector geometry, simplified landmark silhouettes, a limited saturated palette, a large destination title, and layered depth without gradients or photoreal texture.", caseId: 59, cover: "example_vector_poster_london.png", author: "michaelrabone" }),
  gpt4oTemplate({ id: "gpt4o-miniature-brand-building", name: "Miniature Brand Building", group: "Architecture & Space", description: "A brand or product transformed into a charming miniature architectural storefront.", tags: ["architecture", "miniature", "brand", "store", "3d", "微缩", "店铺"], styleBlock: "Translate the brand's signature object and colors into a tiny believable building, with isometric product-render lighting, miniature people, material detail, and a clean presentation ground.", caseId: 56, cover: "example_miniature_starbucks_cup_building.png", author: "dotey" }),
  gpt4oTemplate({ id: "gpt4o-paper-craft-icon", name: "Paper-Craft Icon", group: "Illustration", description: "A bold icon rebuilt from layered cut paper with tactile shadows and clean color blocks.", tags: ["paper craft", "icon", "cut paper", "layered", "tactile", "纸艺", "图标"], styleBlock: "Construct the subject from crisp layered paper shapes, visible cut edges, soft cast shadows, and a small controlled palette on a simple ground. Keep the silhouette iconic and immediately recognizable.", caseId: 52, cover: "example_paper_craft_emoji_fire.png", author: "egeberkina", density: "low" }),
  gpt4oTemplate({ id: "gpt4o-fashion-magazine-cover", name: "Fashion Magazine Cover", group: "Editorial", description: "A polished fashion cover with exact masthead, assertive crop, and disciplined cover lines.", tags: ["fashion", "magazine", "cover", "editorial", "portrait", "时尚", "杂志"], styleBlock: "Use a confident editorial portrait or product crop, an exact oversized masthead, carefully spaced cover lines, premium retouching, and one restrained accent color. Preserve magazine hierarchy and whitespace.", caseId: 49, cover: "example_fashion_design_cover.png", author: "dotey" }),
  gpt4oTemplate({ id: "gpt4o-voxel-icon-system", name: "Voxel Icon System", group: "Illustration", description: "A subject translated into a compact isometric voxel sculpture with game-like clarity.", tags: ["voxel", "3d", "icon", "isometric", "game", "体素", "图标"], styleBlock: "Build the subject from clean voxel blocks in an isometric view, preserve its recognizable silhouette, use soft studio shadows, and place it on a minimal contrasting ground with concise labels.", caseId: 48, cover: "example_voxel_icon.png", author: "BrettFromDJ", density: "low" }),
  gpt4oTemplate({ id: "gpt4o-3d-brand-mascot", name: "3D Brand Mascot", group: "Brand & Identity", description: "A friendly dimensional mascot built from recognizable brand or institution cues.", tags: ["mascot", "3d", "brand", "character", "institution", "吉祥物", "品牌"], styleBlock: "Create a compact stylized 3D mascot with clear brand-color, costume, and prop anchors. Present hero pose, small expression variants, and a simple identity lockup on a clean board.", caseId: 45, cover: "example_university_mascot_npu.png", author: "dotey" }),
  gpt4oTemplate({ id: "gpt4o-rpg-profile-card", name: "RPG Profile Card", group: "Illustration", description: "A richly framed character or stakeholder profile card with stats and narrative detail.", tags: ["rpg", "profile", "card", "character", "stats", "角色卡", "档案"], styleBlock: "Use a framed hero portrait, a compact attribute or KPI column, emblematic icons, textured borders, and short narrative copy. Keep all text readable and the card hierarchy game-authentic.", caseId: 44, cover: "example_rpg_card_designer.png", author: "berryxia_ai", density: "high" }),
  gpt4oTemplate({ id: "gpt4o-two-panel-manga", name: "Two-Panel Manga", group: "Illustration", description: "A concise two-beat manga sequence with expressive reactions and clear reading order.", tags: ["manga", "comic", "story", "two panel", "expression", "漫画", "分镜"], styleBlock: "Split the slide into two strong manga panels with deliberate pacing, consistent characters, expressive close-ups, speed or emotion marks, and minimal dialogue placed in clean balloons.", caseId: 40, cover: "example_two_panel_manga_president.png", author: "hellokaton" }),
  gpt4oTemplate({ id: "gpt4o-handdrawn-infographic", name: "Hand-Drawn Infographic", group: "Infographic", description: "A friendly educational card of marker lettering, doodled icons, arrows, and grouped facts.", tags: ["hand drawn", "infographic", "education", "doodle", "notes", "手绘", "信息图"], styleBlock: "Organize the content as a hand-drawn knowledge card with a strong title, four to six short modules, marker-style icons, arrows, circled keywords, and a warm paper ground.", caseId: 38, cover: "example_hand_drawn_infographic.png", author: "dotey", density: "high" }),
  gpt4oTemplate({ id: "gpt4o-pastel-3d-ad", name: "Pastel 3D Ad", group: "Poster & Ad", description: "A soft commercial 3D scene with friendly rounded forms and confident product messaging.", tags: ["pastel", "3d", "advertising", "product", "soft", "柔和", "广告"], styleBlock: "Stage one product in a rounded pastel 3D world with soft studio light, playful supporting forms, a bold clean headline, and a compact benefit line. Keep it cheerful and conversion-ready.", caseId: 37, cover: "pastel_power_3d_ads.png", author: "aziz4ai" }),
  gpt4oTemplate({ id: "gpt4o-minimal-3d-illustration", name: "Minimal 3D Illustration", group: "Illustration", description: "A single simple idea expressed through a small polished 3D metaphor.", tags: ["minimal", "3d", "metaphor", "icon", "concept", "极简", "三维"], styleBlock: "Translate the concept into one immediately readable 3D metaphor with rounded materials, soft shadows, one accent color, and ample whitespace for a title and one supporting sentence.", caseId: 36, cover: "example_minimalist_3d_toilet_txt.png", author: "dotey", density: "low" }),
  gpt4oTemplate({ id: "gpt4o-cognition-notes", name: "Cognition Notes", group: "Infographic", description: "A dense hand-drawn thinking map with linked concepts and annotated visual metaphors.", tags: ["mind map", "cognition", "notes", "hand drawn", "diagram", "认知", "思维导图"], styleBlock: "Use a central concept, branching hand-drawn relationships, small explanatory sketches, emphasized keywords, and a disciplined reading path on textured paper. Dense but never chaotic.", caseId: 34, cover: "example_hand_drawn_infographic_cognition.png", author: "dotey", density: "high" }),
  gpt4oTemplate({ id: "gpt4o-popup-book", name: "Paper Pop-Up Story", group: "Illustration", description: "A narrative scene constructed as an open layered paper pop-up book.", tags: ["paper", "popup book", "story", "craft", "scene", "纸雕", "绘本"], styleBlock: "Present the story as an open pop-up book with layered cut-paper scenery, visible folds, tactile fibers, theatrical depth, and a small caption integrated into the page design.", caseId: 32, cover: "3d_papercraft_popup_book.png", author: "dotey" }),
  gpt4oTemplate({ id: "gpt4o-35mm-surreal-landscape", name: "35mm Surreal Landscape", group: "Photo & Cinematic", description: "A dreamlike impossible landscape photographed with warm 35mm film character.", tags: ["35mm", "film", "surreal", "landscape", "cinematic", "胶片", "超现实"], styleBlock: "Photograph an impossible but believable landscape using a natural 35mm perspective, warm film stock, gentle grain, atmospheric haze, and a restrained editorial caption.", caseId: 30, cover: "example_35mm_moscow_flying_island.png", author: "dotey", density: "low" }),
  gpt4oTemplate({ id: "gpt4o-social-notebook-cover", name: "Social Notebook Cover", group: "Poster & Ad", description: "A tactile lifestyle cover designed for social sharing with bold handwritten hierarchy.", tags: ["social", "cover", "notebook", "lifestyle", "handwritten", "社交媒体", "小红书"], styleBlock: "Use a top-down or casual lifestyle composition, tactile notebook and sticker details, a bold handwritten title, two or three benefit callouts, and warm editorial photography suited to a social cover.", caseId: 22, cover: "example_notebook_promo.png", author: "balconychy" }),
  gpt4oTemplate({ id: "gpt4o-retro-crt-interface", name: "Retro CRT Interface", group: "UI & Dashboard", description: "A nostalgic monochrome computer interface glowing inside a curved CRT display.", tags: ["crt", "retro", "terminal", "interface", "computer", "复古", "电脑界面"], styleBlock: "Render a curved CRT screen with phosphor glow, scanlines, authentic low-resolution type, simple boot or terminal UI, and dark surrounding hardware. Keep the onscreen hierarchy exact and legible.", caseId: 17, cover: "retro_crt_computer_boot_screen.png", author: "Gdgtify" }),
  gpt4oTemplate({ id: "gpt4o-satirical-poster", name: "Satirical Editorial Poster", group: "Editorial", description: "A sharp conceptual poster using visual irony, bold symbols, and newspaper-like commentary.", tags: ["satire", "editorial", "poster", "concept", "commentary", "讽刺", "观点"], styleBlock: "Build one clear visual metaphor, combine it with bold editorial type and a restricted print palette, then add a small newspaper-like caption. Make the irony instantly readable without clutter.", caseId: 15, cover: "example_gpt_involution_poster.png", author: "ZHO_ZHO_ZHO" }),
  gpt4oTemplate({ id: "gpt4o-editorial-cartoon", name: "Editorial Cartoon", group: "Illustration", description: "A single-frame satirical cartoon with caricature, symbolic props, and a concise caption.", tags: ["cartoon", "satire", "editorial", "caricature", "symbol", "漫画", "讽刺"], styleBlock: "Use expressive inked caricature, a small number of symbolic props, a readable situation, and one concise caption. Preserve the immediacy of a newspaper editorial cartoon.", caseId: 10, cover: "example_maga_hat_cartoon.png", author: "dotey" }),
  gpt4oTemplate({ id: "gpt4o-minimal-futurist-poster", name: "Minimal Futurist Poster", group: "Poster & Ad", description: "A sparse science-fiction poster with geometric type, one surreal object, and deep space.", tags: ["futurist", "minimal", "poster", "space", "geometric", "未来", "极简"], styleBlock: "Use a near-black or pale neutral field, one precisely rendered surreal object, strict geometric typography, a single luminous accent, and extreme negative space.", caseId: 9, cover: "minimalist_futurist_poster.png", author: "ZHO_ZHO_ZHO", density: "low" }),
  gpt4oTemplate({ id: "gpt4o-vintage-propaganda", name: "Vintage Propaganda Poster", group: "Poster & Ad", description: "A bold screen-printed propaganda composition with heroic geometry and aged paper.", tags: ["vintage", "propaganda", "poster", "screenprint", "retro", "复古", "宣传画"], styleBlock: "Use simplified heroic geometry, a diagonal composition, two or three flat ink colors, large condensed type, halftone texture, and aged paper. Keep the message blunt and iconic.", caseId: 3, cover: "example_vintage_poster.png", author: "dotey" }),
];

export const COMMUNITY_TEMPLATES: CommunityTemplate[] = [
  ...NANO_BANANA_PRO_TEMPLATES.map((template) => ({
    ...template,
    sourceIds: template.sourceIds ?? ["youmind-nano-banana-pro"],
  })),
  ...FREESTYLE_TEMPLATES,
  ...GPT4O_TEMPLATES,
];

export function getCommunitySource(id: CommunitySourceId): CommunitySource | undefined {
  return COMMUNITY_SOURCES.find((source) => source.id === id);
}

export function getCommunityTemplate(id?: string | null): CommunityTemplate | undefined {
  if (!id) return undefined;
  return COMMUNITY_TEMPLATES.find((t) => t.id === id);
}

export function isCommunityTemplateId(id?: string | null): boolean {
  return !!id && COMMUNITY_TEMPLATES.some((t) => t.id === id);
}

/** The <page_style> paragraph for a community template (palette + density folded in). */
export function communityStyleBlock(t: CommunityTemplate): string {
  return [
    t.styleBlock,
    `Palette: ${t.palette.join(", ")} (first color is the accent).`,
    `Text density: ${t.density}.`,
  ].join(" ");
}

export function communityByGroup(): { group: CommunityGroup; templates: CommunityTemplate[] }[] {
  return COMMUNITY_GROUPS.map((group) => ({
    group,
    templates: COMMUNITY_TEMPLATES.filter((t) => t.group === group),
  })).filter((g) => g.templates.length > 0);
}

/**
 * Lightweight, offline requirement→style matching for the inspiration step.
 * Scores each template by keyword overlap of the query against tags/name/group/
 * description (English). Returns templates sorted by score desc; ties keep catalog
 * order. A codex-backed re-rank (POST /api/inspire) refines this when available.
 */
export function scoreCommunityTemplates(query: string): { t: CommunityTemplate; score: number }[] {
  const aliases: [RegExp, string][] = [
    [/(商业|商务|汇报|报告|路演|投资|融资|高管|executive|business|pitch)/i, " business report executive pitch professional "],
    [/(数据|图表|指标|增长|chart|data|metric|analytics)/i, " data chart infographic dashboard analytics "],
    [/(科技|技术|人工智能|智能|ai|tech|software|saas)/i, " technology ai software saas futuristic "],
    [/(教育|科普|教学|课程|education|science|learning)/i, " education science infographic diagram "],
    [/(医疗|健康|生物|medical|health|biology)/i, " medical health scientific anatomy diagram "],
    [/(产品|商品|电商|营销|广告|product|commerce|marketing|ad)/i, " product commerce marketing advertising launch "],
    [/(品牌|标志|视觉识别|brand|logo|identity)/i, " brand logo identity campaign "],
    [/(建筑|室内|城市|空间|architecture|interior|urban)/i, " architecture interior city space map "],
    [/(摄影|电影|纪实|写实|photo|film|cinematic|realistic)/i, " photography cinematic documentary realistic "],
    [/(手绘|插画|漫画|水彩|illustration|drawn|comic|watercolor)/i, " illustration hand-drawn comic watercolor "],
    [/(地图|地理|旅行|map|geography|travel)/i, " map geography travel location "],
    [/(流程|架构|系统|拆解|process|architecture|system|breakdown)/i, " diagram process system technical breakdown "],
    [/(复古|怀旧|历史|retro|vintage|history)/i, " retro vintage history editorial poster "],
    [/(社交|封面|小红书|social|cover)/i, " social cover poster editorial "],
  ];
  const raw = (query || "").toLowerCase();
  const q = aliases.reduce((expanded, [pattern, words]) => pattern.test(raw) ? expanded + words : expanded, raw);
  const tokens = Array.from(new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length >= 3)));
  return COMMUNITY_TEMPLATES.map((t) => {
    const hay = [t.name, t.group, t.description, t.tags.join(" ")].join(" ").toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (t.tags.some((tag) => tag.includes(tok) || tok.includes(tag))) score += 3;
      else if (hay.includes(tok)) score += 1;
    }
    return { t, score };
  });
}

export function matchCommunityTemplates(query: string, limit?: number): CommunityTemplate[] {
  const scored = scoreCommunityTemplates(query)
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.t);
  return typeof limit === "number" ? scored.slice(0, limit) : scored;
}

// ---- inspiration step helpers ------------------------------------------

/** A short, human-readable search query seeded from the deck's requirement/title. */
export function inspireQueryFor(requirement: string, title?: string): string {
  const base = (title || requirement || "").trim().replace(/\s+/g, " ");
  return base.slice(0, 60) || "presentation design";
}

/** Canonical search phrase for each community group, used for the "Try:" chips. */
export const GROUP_QUERY: Record<CommunityGroup, string> = {
  "Business & Report": "professional business report",
  Infographic: "infographic layout",
  Diagram: "technical diagram",
  "Data & Map": "data visualization",
  "UI & Dashboard": "dashboard interface",
  "Poster & Ad": "bold poster",
  Product: "product showcase",
  "Brand & Identity": "brand identity board",
  "Architecture & Space": "architecture presentation",
  "Photo & Cinematic": "cinematic photography",
  Editorial: "editorial layout",
  Illustration: "illustrated style",
};

/**
 * Offline "Try:" suggestion chips (like the reference gallery's query hints):
 * the groups whose templates best match the query, phrased as re-search queries.
 * Falls back to a sensible popular set when nothing matches (e.g. a CJK query the
 * English catalog can't score — the codex /api/inspire re-rank refines those).
 */
export function inspireChips(query: string, n = 3): string[] {
  const scored = scoreCommunityTemplates(query)
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const groups: CommunityGroup[] = [];
  for (const s of scored) {
    if (!groups.includes(s.t.group)) groups.push(s.t.group);
    if (groups.length >= n) break;
  }
  const fill: CommunityGroup[] = ["Infographic", "Data & Map", "Editorial", "Diagram"];
  for (const g of fill) {
    if (groups.length >= n) break;
    if (!groups.includes(g)) groups.push(g);
  }
  return groups.slice(0, n).map((g) => GROUP_QUERY[g]);
}

/** Full catalog reordered so the given ids come first (in order); rest keep catalog order. */
export function orderedByIds(ids: string[]): CommunityTemplate[] {
  const seen = new Set<string>();
  const head: CommunityTemplate[] = [];
  for (const id of ids) {
    const t = getCommunityTemplate(id);
    if (t && !seen.has(t.id)) {
      head.push(t);
      seen.add(t.id);
    }
  }
  return [...head, ...COMMUNITY_TEMPLATES.filter((t) => !seen.has(t.id))];
}
