// Shared request → PptConfig coercion, used by /api/generate and /api/outline so
// the one-shot and staged flows validate the incoming config identically.

import { DEFAULT_CONFIG, type PptConfig } from "./types";
import { normalizeDeckDesignSystem } from "./designSystem";
import { projectTemplateDefaults } from "./projectTemplates";
import { getScenario } from "./scenarios";

export function coerceConfig(body: any): PptConfig {
  const projectTemplateId = typeof body?.projectTemplateId === "string"
    ? body.projectTemplateId.trim().slice(0, 140)
    : undefined;
  const projectTemplate = projectTemplateDefaults(projectTemplateId);
  const scenario = getScenario(String(body?.scenarioId ?? ""));
  const hasExplicitStyle = typeof body?.style === "string"
    && (body.style.trim().length > 0 || !projectTemplate.projectTemplateId);
  const effectiveStyle = hasExplicitStyle
    ? body.style
    : projectTemplate.style ?? scenario?.defaults.style ?? DEFAULT_CONFIG.style;
  const effectiveTemplate = typeof body?.template === "string"
    ? body.template || undefined
    : projectTemplate.template;
  const designSystemInput = body?.designSystem && typeof body.designSystem === "object"
    ? body.designSystem
    : projectTemplate.designSystem;
  const designSystem = designSystemInput && typeof designSystemInput === "object"
    ? normalizeDeckDesignSystem(designSystemInput, {
        template: effectiveTemplate,
        style: effectiveStyle,
      })
    : undefined;
  const materialContexts = Array.isArray(body?.materialContexts)
    ? body.materialContexts.slice(0, 24).flatMap((item: any) => {
        const id = String(item?.id ?? "").slice(0, 220);
        const name = String(item?.name ?? "").slice(0, 180);
        const role = String(item?.role ?? "").slice(0, 120);
        return id && name && role ? [{ id, name, role }] : [];
      })
    : undefined;
  return {
    ...DEFAULT_CONFIG,
    ...body,
    requirement: String(body?.requirement ?? "").trim(),
    pages: Math.max(1, Math.min(30, Number(body?.pages ?? scenario?.defaults.pages) || DEFAULT_CONFIG.pages)),
    aspect: body?.aspect ?? projectTemplate.aspect ?? scenario?.defaults.aspect ?? DEFAULT_CONFIG.aspect,
    resolution: body?.resolution || projectTemplate.resolution || DEFAULT_CONFIG.resolution,
    style: effectiveStyle,
    template: effectiveTemplate,
    projectTemplateId: projectTemplate.projectTemplateId,
    mode: body?.mode ?? (scenario?.defaults.research ? "research" : undefined),
    designSystem,
    scenarioId: scenario?.id,
    materialContexts,
  };
}
