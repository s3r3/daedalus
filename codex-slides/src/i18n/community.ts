import type { CommunityGroup } from "@/lib/community";
import type { MessageKey } from "@/i18n/messages";

export const COMMUNITY_GROUP_KEYS: Record<CommunityGroup, MessageKey> = {
  "Business & Report": "community.group.businessReport",
  Infographic: "community.group.infographic",
  Diagram: "community.group.diagram",
  "Data & Map": "community.group.dataMap",
  "UI & Dashboard": "community.group.uiDashboard",
  "Poster & Ad": "community.group.posterAd",
  Product: "community.group.product",
  "Brand & Identity": "community.group.brandIdentity",
  "Architecture & Space": "community.group.architectureSpace",
  "Photo & Cinematic": "community.group.photoCinematic",
  Editorial: "community.group.editorial",
  Illustration: "community.group.illustration",
};

export const COMMUNITY_QUERY_KEYS: Record<string, MessageKey> = {
  "professional business report": "inspire.query.businessReport",
  "infographic layout": "inspire.query.infographic",
  "technical diagram": "inspire.query.diagram",
  "data visualization": "inspire.query.data",
  "dashboard interface": "inspire.query.uiDashboard",
  "bold poster": "inspire.query.poster",
  "product showcase": "inspire.query.product",
  "brand identity board": "inspire.query.brandIdentity",
  "architecture presentation": "inspire.query.architectureSpace",
  "cinematic photography": "inspire.query.photoCinematic",
  "editorial layout": "inspire.query.editorial",
  "illustrated style": "inspire.query.illustration",
};
