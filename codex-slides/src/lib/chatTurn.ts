// One shared chat-turn orchestrator for both the home live workspace
// (app/page.tsx) and the project workspace (components/DeckView.tsx). It turns a
// natural-language turn into an interleaved transcript of Markdown text + tool
// blocks, and — for deck changes only — appends to the conversation-wide
// checklist. Conversations that are just questions/summaries answer in text and
// never touch the deck (fixes "总结一下" silently adding a slide).

import type { Dispatch, SetStateAction } from "react";
import type { ChatMsg } from "@/components/ChatColumn";
import {
  createAgentRunId,
  elapsedRunLabel,
  patchBlockTool,
  stopRunningBlocks,
  upsertBlock,
  type AgentToolCall,
  type GlobalTodoItem,
  type MessageBlock,
} from "@/lib/agentActivity";
import {
  addProjectSlide,
  fileUrl,
  generateSingleSlide,
  planChatEdit,
  regenerateSlide,
  type ChatRequest,
  type SlideChatContext,
  type UiSlide,
} from "@/lib/deckEdit";
import type { MessageKey, MessageValues, UiLocale } from "@/i18n/messages";

export interface ChatTurnDeps {
  projectId: string;
  locale: UiLocale;
  t: (key: MessageKey, params?: MessageValues) => string;
  /** Append a message to the active conversation. */
  say: (message: ChatMsg) => void;
  /** Patch the assistant turn by id. */
  update: (id: string, updater: (message: ChatMsg) => ChatMsg) => void;
  /** Current slides (read through a ref so async steps see fresh state). */
  getSlides: () => UiSlide[];
  setSlides: Dispatch<SetStateAction<UiSlide[]>>;
  /** Global (cross-turn) checklist controls. */
  appendTodos: (items: GlobalTodoItem[]) => void;
  patchTodo: (id: string, patch: Partial<GlobalTodoItem>) => void;
  /** Home view omits @-referenced design files; project view supplies them. */
  supportsDesignFiles?: boolean;
}

function groupLabel(message: string) {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine || "编辑";
}

/**
 * Drive one conversational turn end-to-end, writing interleaved blocks onto a
 * single assistant message. Deck mutations reuse the validated per-slide routes.
 */
export async function runChatTurn(request: ChatRequest, deps: ChatTurnDeps): Promise<void> {
  const { projectId, locale, t, say, update, getSlides, setSlides, appendTodos, patchTodo } = deps;
  const { message, context } = request;
  const attachments = request.attachments ?? [];
  const designFiles = deps.supportsDesignFiles ? request.designFiles ?? [] : [];

  say({ role: "user", content: message, attachment: context, contextItems: attachments, designFiles });

  const runId = createAgentRunId("deck-edit");
  const startedAt = Date.now();

  // Block helpers scoped to this assistant turn.
  const setBlocks = (updater: (blocks: MessageBlock[]) => MessageBlock[]) =>
    update(runId, (current) => ({ ...current, blocks: updater(current.blocks ?? []) }));
  const putText = (id: string, text: string) => setBlocks((blocks) => upsertBlock(blocks, { id, type: "text", text }));
  const putTool = (id: string, tool: Omit<AgentToolCall, "id">) =>
    setBlocks((blocks) => upsertBlock(blocks, { id, type: "tool", tool: { id, ...tool } }));
  const patchTool = (id: string, patch: Partial<Omit<AgentToolCall, "id">>) =>
    setBlocks((blocks) => patchBlockTool(blocks, id, patch));

  // Opening blocks: read any @-referenced files, then "understand the request".
  const openingBlocks: MessageBlock[] = [
    ...designFiles.map((file, index) => ({
      id: `read-${index}`,
      type: "tool" as const,
      tool: {
        id: `read-${index}`,
        name: "read",
        kind: "read" as const,
        label: t("agent.readDesignFile"),
        detail: file.relativePath,
        path: file.path,
        relativePath: file.relativePath,
        state: "running" as const,
      },
    })),
    {
      id: "understand",
      type: "tool" as const,
      tool: {
        id: "understand",
        name: "understand_request",
        kind: "tool" as const,
        label: t("agent.plan"),
        detail: t("agent.planDetail"),
        state: "running" as const,
      },
    },
  ];
  say({ id: runId, role: "assistant", content: "", blocks: openingBlocks });

  try {
    const plan = await planChatEdit(projectId, message, context, attachments, designFiles);

    // Fold real CLI tool events (Codex JSONL) into the transcript.
    (plan.activities ?? []).forEach((tool, index) => {
      const id = `cli-${tool.id || index}`;
      const label = tool.kind === "bash"
        ? t("agent.runCommand")
        : tool.kind === "read"
          ? t("agent.readFile")
          : tool.kind === "write" || tool.kind === "edit"
            ? t("agent.editFiles")
            : tool.kind === "search"
              ? t("agent.search")
              : tool.kind === "todo"
                ? t("agent.taskList")
                : t("agent.useTool");
      putTool(id, { ...tool, label });
    });

    // Settle the opening blocks.
    designFiles.forEach((_, index) => patchTool(`read-${index}`, { state: "complete" }));

    // ---- ANSWER: converse / analyze / summarize, no deck change ------------
    if (plan.action === "answer") {
      patchTool("understand", {
        state: "complete",
        label: t("agent.answering"),
        detail: plan.readFiles ? t("agent.readContext") : t("agent.replyOnly"),
      });
      putText("answer", plan.reply || t("agent.noChange"));
      update(runId, (current) => ({ ...current, ran: elapsedRunLabel(startedAt, locale) }));
      return;
    }

    patchTool("understand", {
      state: "complete",
      detail: plan.action === "add"
        ? t("agent.addRender")
        : t(plan.targets.length === 1 ? "agent.targetOne" : "agent.targetMany", { targets: plan.targets.join(", ") }),
    });
    // A short line of narration before the tools do their work.
    if (plan.reply) putText("intro", plan.reply);

    // ---- ADD: insert one new slide ----------------------------------------
    if (plan.action === "add") {
      const afterIndex = plan.afterIndex ?? getSlides().length;
      appendTodos([{
        id: `${runId}-add`,
        content: t("agent.addTask", { index: afterIndex + 1 }),
        status: "in_progress",
        group: groupLabel(message),
        turnId: runId,
        ts: startedAt,
      }]);
      putTool("add", { name: "add_slide", kind: "write", label: t("agent.insert"), detail: t("agent.after", { index: afterIndex }), state: "running" });
      putTool("generate", { name: "generate_slide", kind: "edit", label: t("agent.renderSlide"), detail: t("agent.matchStyle"), state: "pending" });

      const next = await addProjectSlide(projectId, afterIndex, plan.title, {
        prompt: message,
        groupId: runId,
      });
      const insertedIndex = Math.min(Math.max(afterIndex + 1, 1), next.length);
      setSlides(next.map((slide) => (slide.index === insertedIndex ? { ...slide, status: "working" } : slide)));
      patchTool("add", { state: "complete", detail: t("agent.inserted", { index: insertedIndex }) });
      patchTool("generate", { state: "running", detail: t("agent.renderingSlide", { index: insertedIndex }) });
      patchTodo(`${runId}-add`, { content: t("agent.addTask", { index: insertedIndex }) });

      try {
        const generated = await generateSingleSlide(
          projectId,
          insertedIndex,
          plan.instruction || message,
          plan.title,
          { prompt: message, groupId: runId },
        );
        setSlides((items) => items.map((slide) => (slide.index === insertedIndex ? generated : slide)));
        patchTool("generate", { state: "complete", detail: t("agent.renderedSlide", { index: insertedIndex }) });
        patchTodo(`${runId}-add`, { status: "complete" });
        putText("done", t("agent.addedReply", { reply: "", index: insertedIndex }).trim());
        update(runId, (current) => ({
          ...current,
          ran: elapsedRunLabel(startedAt, locale),
          attachment: {
            slideIndex: insertedIndex,
            title: generated.title || t("chat.slide", { index: insertedIndex }),
            imageUrl: fileUrl(projectId, generated.image, generated.bust),
          },
        }));
      } catch (error: any) {
        setSlides((items) => items.map((slide) => (slide.index === insertedIndex ? { ...slide, status: "error", error: String(error?.message ?? error) } : slide)));
        patchTodo(`${runId}-add`, { status: "error" });
        throw error;
      }
      return;
    }

    // ---- EDIT: regenerate targeted slides in order ------------------------
    if (!plan.targets.length) {
      putText("answer", plan.reply || t("agent.noChange"));
      update(runId, (current) => ({ ...current, ran: elapsedRunLabel(startedAt, locale) }));
      return;
    }

    appendTodos(plan.targets.map((target) => ({
      id: `${runId}-slide-${target}`,
      content: t("agent.updateSlide", { index: target }),
      status: "pending" as const,
      group: groupLabel(message),
      turnId: runId,
      ts: startedAt,
    })));
    plan.targets.forEach((target) => putTool(`regenerate-${target}`, {
      name: "regenerate_slide",
      kind: "edit",
      label: t("agent.updateSlide", { index: target }),
      detail: t("agent.waitPrevious"),
      state: "pending",
    }));

    const failedTargets: number[] = [];
    let lastAttachment: SlideChatContext | undefined;
    for (const target of plan.targets) {
      patchTool(`regenerate-${target}`, { state: "running", detail: t("agent.redrawing") });
      patchTodo(`${runId}-slide-${target}`, { status: "in_progress" });
      setSlides((slides) => slides.map((slide) => (slide.index === target ? { ...slide, status: "working" } : slide)));
      try {
        const image = await regenerateSlide(
          projectId,
          target,
          plan.instruction,
          plan.targets.length === 1 ? plan.title : undefined,
          { prompt: message, groupId: runId },
        );
        const bust = Date.now();
        setSlides((slides) => slides.map((slide) => (
          slide.index === target
            ? { ...slide, title: plan.targets.length === 1 && plan.title ? plan.title : slide.title, status: "rendered", image, bust }
            : slide
        )));
        lastAttachment = {
          slideIndex: target,
          title: (plan.targets.length === 1 ? plan.title : undefined)
            || getSlides().find((slide) => slide.index === target)?.title
            || t("chat.slide", { index: target }),
          imageUrl: fileUrl(projectId, image, bust),
        };
        patchTool(`regenerate-${target}`, { state: "complete", detail: t("agent.updatedSlide", { index: target }) });
        patchTodo(`${runId}-slide-${target}`, { status: "complete" });
      } catch (error: any) {
        failedTargets.push(target);
        setSlides((slides) => slides.map((slide) => (slide.index === target ? { ...slide, status: "error", error: String(error?.message ?? error) } : slide)));
        patchTool(`regenerate-${target}`, { state: "error", detail: String(error?.message ?? error) });
        patchTodo(`${runId}-slide-${target}`, { status: "error" });
      }
    }

    putText("done", failedTargets.length
      ? t("agent.partialFailure", { reply: "", targets: failedTargets.join(", ") }).trim()
      : t("agent.updatedReply", { reply: "", targets: plan.targets.join(", ") }).trim());
    update(runId, (current) => ({ ...current, ran: elapsedRunLabel(startedAt, locale), attachment: lastAttachment }));
  } catch (error: any) {
    setBlocks((blocks) => stopRunningBlocks(blocks, String(error?.message ?? error)));
    putText("error", `⚠ ${error?.message ?? error}`);
    update(runId, (current) => ({ ...current, ran: elapsedRunLabel(startedAt, locale) }));
    throw error;
  }
}
