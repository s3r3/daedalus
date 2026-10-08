import type { ChatMsg } from "@/components/ChatColumn";
import { getCommunityTemplate } from "@/lib/community";
import type { OutlinePage } from "@/lib/types";

export function outlineSnapshotMessage(title: string, outline: OutlinePage[]): ChatMsg {
  return {
    role: "assistant",
    content: "已确认最终大纲。接下来的视觉参考与页面生成都会以这个版本为准；你可以随时再次打开查看。",
    doc: {
      title: title || "演示文稿大纲",
      subtitle: `已确认 · ${outline.length} 页`,
      pages: outline.map((page) => ({ title: page.title, points: [...page.points] })),
      artifactId: "outline",
    },
  };
}

export function styleSnapshotMessage(templateId: string, query = "当前演示"): ChatMsg {
  const template = getCommunityTemplate(templateId);
  return {
    role: "assistant",
    content: `已确认视觉参考：${template?.name ?? templateId}。生成页面会沿用它的配色、材质与版式语言；下方可以再次预览。`,
    inspiration: {
      query,
      coverIds: [templateId],
      total: 1,
      chosen: templateId,
      resolved: true,
    },
  };
}
