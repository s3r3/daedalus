import type { QuestionSpec } from "@/lib/onboard";
import type { OutlinePage } from "@/lib/types";

export type DesignFile =
  | {
      id: "questions";
      kind: "questions";
      title: string;
      subtitle: string;
      questions: QuestionSpec[];
      answerSummary?: string;
    }
  | {
      id: "outline";
      kind: "outline";
      title: string;
      subtitle: string;
      pages: OutlinePage[];
    }
  | {
      id: "research";
      kind: "research";
      title: string;
      subtitle: string;
      markdown: string;
      status: "running" | "complete" | "error";
    }
  | {
      id: "inspiration";
      kind: "inspiration";
      title: string;
      subtitle: string;
      selectedTemplateId?: string;
      candidateTemplateIds: string[];
      skipped?: boolean;
    };

export type WorkspaceMode = "canvas" | "files";
