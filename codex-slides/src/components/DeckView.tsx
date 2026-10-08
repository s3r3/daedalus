"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClockCounterClockwise, DotsThree, Palette } from "@phosphor-icons/react";
import {
  BrandDesignSystemPanel,
  type BrandDesignSystemSubmit,
} from "@/components/BrandDesignSystemPanel";
import DesignFiles from "@/components/DesignFiles";
import DeckVersionDialog from "@/components/DeckVersionDialog";
import ChatColumn, { type ChatMsg } from "@/components/ChatColumn";
import type { MaterialTrayItem } from "@/components/MaterialTray";
import InspirationStage from "@/components/InspirationStage";
import OutlineBoard from "@/components/OutlineBoard";
import InspireDialog from "@/components/InspireDialog";
import SaveProjectTemplateButton from "@/components/SaveProjectTemplateButton";
import SlideStage, { type MarkAgentEvent } from "@/components/SlideStage";
import WorkspaceModeTabs from "@/components/WorkspaceModeTabs";
import type { DesignFile } from "@/lib/designFiles";
import {
  COMMUNITY_TEMPLATES,
  getCommunityTemplate,
  inspireQueryFor,
  matchCommunityTemplates,
} from "@/lib/community";
import { getTemplate } from "@/lib/templates";
import {
  addProjectSlide,
  cacheProjectCheckpoint,
  deriveStatus,
  fileUrl,
  generateSingleSlide,
  patchProjectStyle,
  planChatEdit,
  regenerateSlide,
  reviseOutlineChat,
  saveConversations,
  saveOutline,
  saveProjectCheckpoint,
  startProjectRun as startDetachedProjectRun,
  stopProjectRun as stopDetachedProjectRun,
  type ChatRequest,
  type GenStatus,
  type ProjectCheckpointPatch,
  type SlideChatContext,
  type UiSlide,
} from "@/lib/deckEdit";
import type { OutlinePage, ProgressEvent, Project, ProjectRunInput } from "@/lib/types";
import { runChatTurn } from "@/lib/chatTurn";
import { normalizeDeckDesignSystem } from "@/lib/designSystem";
import { outlineSnapshotMessage, styleSnapshotMessage } from "@/lib/chatArtifacts";
import {
  createQueuedChatRequest,
  loadQueuedChatRequests,
  prioritizeQueuedChatRequest,
  reorderConversationQueue,
  saveQueuedChatRequests,
  snapshotChatRequest,
  updateQueuedChatRequest,
  type QueuedChatRequest,
} from "@/lib/chatQueue";
import { useChatConversations } from "@/lib/useChatConversations";
import { buildWorkflowProgress } from "@/lib/workflowProgress";
import { useI18n } from "@/i18n/I18nProvider";
import { translate, type UiLocale } from "@/i18n/messages";
import {
  createAgentRunId,
  elapsedRunLabel,
  patchAgentTool,
  patchAgentTools,
  stopRunningTools,
} from "@/lib/agentActivity";
import {
  ACTIVE_PROJECT_POLL_MS,
  IDLE_PROJECT_POLL_MS,
  checkpointSignature,
  jsonEqual,
  projectResponseEtag,
  slideImageVersion,
} from "@/lib/projectSync";

function projectSlides(project: Project): UiSlide[] {
  return project.pages.map((slide) => ({
    index: slide.index,
    title: slide.title,
    status: project.activeRun?.status === "running" && project.activeRun.targetSlide === slide.index
      ? "working"
      : (slide.status as UiSlide["status"]) ?? "pending",
    image: slide.image,
    error: slide.error,
    bust: slideImageVersion(project, slide),
    transition: slide.transition ?? "none",
    speakerNotes: slide.speakerNotes,
  }));
}

/** Rehydrate slide state written by another Browser tab, Codex MCP call, or
 * CLI process without changing URLs for images whose bytes did not change. */
function reconcileProjectSlides(_current: UiSlide[], latest: Project): UiSlide[] {
  const next = projectSlides(latest);
  return jsonEqual(_current, next) ? _current : next;
}

function projectOutline(project: Project): OutlinePage[] {
  return (project.outline?.length ? project.outline : project.pages).map((page) => ({
    title: page.title,
    points: [...(page.points ?? [])],
  }));
}

/** Upgrade legacy chat history in memory so projects created before persistent
 * workflow cards still expose the decisions that produced the current deck.
 * The debounced conversation save writes this enriched shape on the next open. */
function enrichProjectChat(project: Project, messages: ChatMsg[], locale: UiLocale): ChatMsg[] {
  if (!messages.length) return messages;
  const outline = projectOutline(project);
  const hasWorkflowEvidence = messages.some((message) => (
    Boolean(message.doc || message.inspiration || message.process || message.artifact)
      || /大纲|outline|视觉参考|visual reference|逐页生成|generating slides/i.test(message.content)
  ));
  if (!hasWorkflowEvidence) return messages;

  const next = messages.map((message) => ({ ...message }));
  const workflowQuestionCount = project.workflow?.questions?.length ?? 0;
  if (workflowQuestionCount) {
    const questionsConfirmed = Boolean(project.workflow?.clarifyAnswerSummary?.trim());
    for (let index = 0; index < next.length; index += 1) {
      if (next[index].artifact?.kind !== "questions") continue;
      next[index] = {
        ...next[index],
        artifact: {
          ...next[index].artifact!,
          subtitle: translate(
            locale,
            questionsConfirmed ? "designFiles.questionsConfirmed" : "designFiles.questionsPending",
            { count: workflowQuestionCount },
          ),
        },
      };
    }
  }
  const outlineIndex = next.findIndex((message) => message.doc);
  if (outline.length && outlineIndex >= 0 && !next[outlineIndex].doc?.pages?.length) {
    next[outlineIndex] = {
      ...next[outlineIndex],
      doc: {
        ...next[outlineIndex].doc!,
        pages: outline.map((page) => ({ title: page.title, points: [...page.points] })),
        artifactId: "outline",
      },
    };
  } else if (outline.length && outlineIndex < 0) {
    next.push({
      ...outlineSnapshotMessage(project.title, outline),
      id: `legacy-outline-${project.id}`,
    });
  }

  if (!next.some((message) => message.artifact?.kind === "questions")) {
    const confirmationIndex = next.findIndex((message) => (
      message.role === "user" && /^(已确认|confirmed)[:：]/i.test(message.content.trim())
    ));
    const confirmedLines = confirmationIndex >= 0
      ? next[confirmationIndex].content.split("\n").filter((line) => /[:：]/.test(line)).length - 1
      : 0;
    const insertIndex = confirmationIndex >= 0 ? confirmationIndex + 1 : Math.min(2, next.length);
    next.splice(insertIndex, 0, {
      id: `legacy-questions-${project.id}`,
      role: "assistant",
      content: "",
      artifact: {
        id: "questions",
        kind: "questions",
        title: translate(locale, "designFiles.questionsTitle"),
        subtitle: confirmedLines > 0
          ? translate(locale, "designFiles.questionsConfirmed", { count: confirmedLines })
          : translate(locale, "designFiles.questionsConfirmedOpenBrief"),
      },
    });
  }

  if (project.config.template && !next.some((message) => message.inspiration?.resolved)) {
    let inspirationIndex = -1;
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const message = next[index];
      if (message.id?.startsWith("inspire-") || /视觉参考|visual reference|ビジュアルリファレンス|挑一个|pick a style|スタイルを選/i.test(message.content)) {
        inspirationIndex = index;
        break;
      }
    }
    const snapshot = styleSnapshotMessage(project.config.template, project.config.requirement);
    const localizedContent = translate(locale, "flow.styleConfirmed", {
      name: getCommunityTemplate(project.config.template)?.name ?? project.config.template,
    });
    if (inspirationIndex >= 0) {
      next[inspirationIndex] = {
        ...next[inspirationIndex],
        content: localizedContent,
        inspiration: snapshot.inspiration,
      };
    } else {
      next.push({
        ...snapshot,
        id: `legacy-inspiration-${project.id}`,
        content: localizedContent,
      });
    }
  }

  const hasRenderProcess = next.some((message) => (
    message.process?.tools.some((tool) => tool.name === "render_deck")
  ));
  if (project.status !== "draft" && !hasRenderProcess) {
    const rendered = project.pages.filter((page) => page.status === "rendered").length;
    const failed = project.pages.filter((page) => page.status === "error").length;
    next.push({
      id: `legacy-render-${project.id}`,
      role: "assistant",
      content: translate(locale, "project.readyIntro", {
        title: project.title,
        count: project.pages.length,
        rendered,
      }),
      process: {
        state: failed ? "error" : "complete",
        title: failed
          ? translate(locale, "flow.renderFinishedWithErrors")
          : translate(locale, "flow.renderFinished"),
        notes: [translate(locale, "flow.renderRestored")],
        tools: [{
          id: "render",
          name: "render_deck",
          label: translate(locale, "flow.renderTool"),
          detail: `${rendered} / ${project.pages.length}${failed ? ` · ${translate(locale, "flow.failedCount", { count: failed })}` : ""}`,
          state: failed ? "error" : "complete",
        }],
      },
    });
  }
  return next;
}

function projectChat(project: Project, locale: UiLocale): ChatMsg[] {
  if (Array.isArray(project.chat) && project.chat.length) {
    return enrichProjectChat(project, project.chat as unknown as ChatMsg[], locale);
  }
  const rendered = project.pages.filter((slide) => slide.status === "rendered").length;
  const fallback: ChatMsg[] = [
    project.status === "draft"
      ? {
          role: "assistant",
          content: translate(locale, "project.draftIntro", { title: project.title, count: project.pages.length }),
          doc: {
            title: project.title,
            subtitle: translate(locale, "flow.outlineDoc", { count: project.pages.length }),
            pages: projectOutline(project),
            artifactId: "outline",
          },
        }
      : {
          role: "assistant",
          content: translate(locale, "project.readyIntro", { title: project.title, count: project.pages.length, rendered }),
          doc: { title: project.title, subtitle: `${project.config.aspect} · ${project.agent}`, icon: "▤" },
        },
  ];
  return enrichProjectChat(project, fallback, locale);
}

/** Shows a persisted project immediately from server-provided data. */
export default function DeckView({ projectId, initialProject }: { projectId: string; initialProject: Project }) {
  const { locale, t } = useI18n();
  const [project, setProject] = useState<Project>(initialProject);
  const [workspaceView, setWorkspaceView] = useState<"deck" | "files">(
    initialProject.workflow?.workspaceMode === "files" ? "files" : "deck",
  );
  const [designFilePath, setDesignFilePath] = useState<string | undefined>();
  const [designFileOpenKey, setDesignFileOpenKey] = useState(0);
  const [slides, setSlides] = useState<UiSlide[]>(() => projectSlides(initialProject));
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [launchingRun, setLaunchingRun] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [stage, setStage] = useState<"outline" | "inspire" | "deck">(() => {
    if (initialProject.workflow?.stage === "inspire") return "inspire";
    if (initialProject.workflow?.stage === "rendering" || initialProject.workflow?.stage === "deck") return "deck";
    if (initialProject.workflow?.stage === "outline" || initialProject.status === "draft") return "outline";
    return "deck";
  });
  const [outline, setOutline] = useState<OutlinePage[]>(() => projectOutline(initialProject));
  const initialConversations = initialProject.conversations?.map((conversation) => ({
    ...conversation,
    messages: enrichProjectChat(initialProject, conversation.messages as unknown as ChatMsg[], locale),
  }));
  const conversationState = useChatConversations({
    initialConversations,
    initialActiveConversationId: initialProject.activeConversationId,
    initialMessages: projectChat(initialProject, locale),
    initialTitle: initialProject.title,
  });
  const chat = conversationState.messages;
  const setChat = conversationState.setMessages;
  const [queue, setQueue] = useState<QueuedChatRequest[]>(
    () => (initialProject.workflow?.queuedRequests ?? []) as QueuedChatRequest[],
  );
  const queueRef = useRef<QueuedChatRequest[]>(queue);
  const [editingQueuedRequestId, setEditingQueuedRequestId] = useState<string | null>(null);
  const [chatContext, setChatContext] = useState<SlideChatContext | null>(null);
  const [chatFocusKey, setChatFocusKey] = useState(0);
  const [focusSlideIndex, setFocusSlideIndex] = useState<number | null>(null);
  const [focusSlideKey, setFocusSlideKey] = useState(0);
  const [inspireOpen, setInspireOpen] = useState(false);
  const [inspireMsgId, setInspireMsgId] = useState<string | null>(null);
  const [inspireSelection, setInspireSelection] = useState<string | undefined>(
    initialProject.workflow?.inspirationSelection,
  );
  const [inspirationSkipped, setInspirationSkipped] = useState(
    initialProject.workflow?.inspirationSkipped
      ?? (initialProject.status !== "draft"
        && !initialProject.config.template
        && !initialProject.config.designSystem),
  );
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCheckpointRef = useRef<{
    patch: ProjectCheckpointPatch;
    signature: string;
  } | null>(null);
  const resumeRenderRef = useRef(false);
  const projectRef = useRef<Project>(initialProject);
  const slidesRef = useRef<UiSlide[]>(slides);
  slidesRef.current = slides;
  const localWorkRef = useRef({ busy: false, running: false });
  const latestProjectVersionRef = useRef(new Date(initialProject.updatedAt).getTime() || 0);
  const projectResponseEtagRef = useRef(projectResponseEtag(initialProject));
  const projectSyncInFlightRef = useRef(false);
  const skipNextConversationSaveRef = useRef(false);
  const persistedConversationSignatureRef = useRef(JSON.stringify(initialProject.conversations ?? []));
  const lastCheckpointSignatureRef = useRef(checkpointSignature({
    config: initialProject.config,
    title: initialProject.title,
    researchDoc: initialProject.researchDoc ?? "",
    workflow: {
      stage: initialProject.status === "rendering" || initialProject.workflow?.stage === "rendering"
        ? "rendering"
        : stage,
      workspaceMode: workspaceView === "files" ? "files" : "canvas",
      researchMode: initialProject.config.mode === "research",
      inspirationSkipped,
      inspirationSelection: initialProject.workflow?.inspirationSelection,
      queuedRequests: queue,
    },
  }));
  const markRunRef = useRef<{ id: string; startedAt: number; slideIndex: number } | null>(null);

  const [showDesignSystem, setShowDesignSystem] = useState(false);
  const [designSystemSaving, setDesignSystemSaving] = useState(false);
  const [designSystemError, setDesignSystemError] = useState("");
  const [retuning, setRetuning] = useState(false);
  const [designSystemProgress, setDesignSystemProgress] = useState(0);
  const [headerActionsOpen, setHeaderActionsOpen] = useState(false);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [versionDeepLinkId, setVersionDeepLinkId] = useState<string | undefined>();
  const [versionDeepLinkSlide, setVersionDeepLinkSlide] = useState<number | undefined>();
  const [slideDeepLinkAction, setSlideDeepLinkAction] = useState<{
    key: number;
    slideIndex?: number;
    panel?: "speaker-notes" | "export" | "play";
    mode?: "workspace" | "play" | "presenter";
  }>();
  const designSystemTriggerRef = useRef<HTMLButtonElement>(null);
  const headerActionsRef = useRef<HTMLDivElement>(null);
  const deepLinkConsumedRef = useRef(false);

  const currentConversationQueue = queue.filter(
    (item) => item.conversationId === conversationState.activeConversationId,
  );
  const activeRun = project.activeRun?.status === "running" || project.activeRun?.status === "stopping"
    ? project.activeRun
    : undefined;
  const workspaceBusy = busy || running || launchingRun || Boolean(activeRun);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    localWorkRef.current = { busy, running };
  }, [busy, running]);

  /** Pull the canonical on-disk project without replacing local chat drafts or
   * an edit currently running in this tab. This is what makes a project opened
   * in Chrome follow generation started from the Codex Browser (and vice
   * versa). */
  const refreshPersistedProject = useCallback(async () => {
    if (projectSyncInFlightRef.current || localWorkRef.current.busy || localWorkRef.current.running) {
      return projectRef.current;
    }
    projectSyncInFlightRef.current = true;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/runs`, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "If-None-Match": projectResponseEtagRef.current,
        },
      });
      if (response.status === 304) return projectRef.current;
      if (!response.ok) return projectRef.current;
      const payload = await response.json() as { project?: Project } & Partial<Project>;
      const latest = (payload.project ?? payload) as Project;
      projectResponseEtagRef.current = response.headers.get("etag") ?? projectResponseEtag(latest);
      const latestVersion = new Date(latest.updatedAt).getTime() || 0;
      if (latestVersion <= latestProjectVersionRef.current) return latest;

      latestProjectVersionRef.current = latestVersion;
      const current = projectRef.current;
      const sameConfig = JSON.stringify(current.config) === JSON.stringify(latest.config);
      const synchronized: Project = {
        ...latest,
        // Keep the config reference stable when only render/page state changed,
        // otherwise the checkpoint autosave would write an unnecessary PATCH.
        config: sameConfig ? current.config : latest.config,
      };
      projectRef.current = synchronized;
      setProject(synchronized);
      setSlides((slidesNow) => reconcileProjectSlides(slidesNow, latest));
      const persistedQueue = (latest.workflow?.queuedRequests ?? []) as QueuedChatRequest[];
      if (!jsonEqual(queueRef.current, persistedQueue)) {
        queueRef.current = persistedQueue;
        setQueue(persistedQueue);
        saveQueuedChatRequests(projectId, persistedQueue);
      }
      // A run may start and finish between two polls. Restore persisted chat on
      // every newer snapshot so fast Codex/MCP edits are visible as well.
      const conversationSignature = JSON.stringify(latest.conversations ?? []);
      if (latest.conversations?.length && conversationSignature !== persistedConversationSignatureRef.current) {
        persistedConversationSignatureRef.current = conversationSignature;
        skipNextConversationSaveRef.current = true;
        conversationState.restoreConversations(
          latest.conversations,
          conversationState.activeConversationId,
          projectChat(latest, locale),
          latest.title,
        );
      }

      if (!localWorkRef.current.busy && !localWorkRef.current.running) {
        const workflowStage = latest.workflow?.stage;
        if (workflowStage === "inspire") {
          setStage("inspire");
          setInspireSelection(latest.workflow?.inspirationSelection);
        } else if (workflowStage === "outline" || (!workflowStage && latest.status === "draft")) {
          setStage("outline");
        } else if (workflowStage === "rendering" || workflowStage === "deck" || latest.status === "ready") {
          setStage("deck");
          const nextOutline = projectOutline(latest);
          setOutline((currentOutline) => jsonEqual(currentOutline, nextOutline) ? currentOutline : nextOutline);
        }
      }
      return synchronized;
    } catch {
      // A transient refresh failure must never interrupt local editing.
      return projectRef.current;
    } finally {
      projectSyncInFlightRef.current = false;
    }
  }, [conversationState.activeConversationId, conversationState.restoreConversations, locale, projectId]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (!disposed && document.visibilityState !== "hidden") void refreshPersistedProject();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };

    // Active work stays near-live. An idle, server-rendered project already has
    // a canonical snapshot, so focus/visibility plus a slower safety poll are
    // enough to discover work started from Codex, MCP, CLI, or another tab.
    if (activeRun) refresh();
    const timer = window.setInterval(
      refresh,
      activeRun ? ACTIVE_PROJECT_POLL_MS : IDLE_PROJECT_POLL_MS,
    );
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeRun?.id, activeRun?.status, refreshPersistedProject]);

  useEffect(() => {
    if (deepLinkConsumedRef.current) return;
    deepLinkConsumedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    const panel = params.get("panel");
    const requestedSlide = Number(params.get("slide"));
    const slideIndex = Number.isInteger(requestedSlide) && requestedSlide > 0
      ? requestedSlide
      : undefined;
    if (slideIndex) {
      setFocusSlideIndex(slideIndex);
      setFocusSlideKey((key) => key + 1);
    }
    if (view === "design-files" || panel === "design-files") {
      setDesignFilePath(params.get("file") || undefined);
      setDesignFileOpenKey((key) => key + 1);
      setWorkspaceView("files");
    } else if (view === "brand-system" || panel === "brand-system") {
      setShowDesignSystem(true);
    }
    if (panel === "versions" || params.get("version")) {
      setVersionDeepLinkId(params.get("version") || undefined);
      setVersionDeepLinkSlide(slideIndex);
      setVersionHistoryOpen(true);
    }
    const mode = params.get("mode");
    if (["speaker-notes", "export", "play"].includes(panel || "") || ["play", "presenter"].includes(mode || "")) {
      setSlideDeepLinkAction({
        key: Date.now(),
        slideIndex,
        panel: ["speaker-notes", "export", "play"].includes(panel || "")
          ? panel as "speaker-notes" | "export" | "play"
          : undefined,
        mode: ["workspace", "play", "presenter"].includes(mode || "")
          ? mode as "workspace" | "play" | "presenter"
          : undefined,
      });
    }
    const conversationId = params.get("conversation");
    if (conversationId && conversationState.summaries.some((item) => item.id === conversationId)) {
      conversationState.selectConversation(conversationId);
    }
  }, [conversationState.selectConversation, conversationState.summaries]);

  useEffect(() => {
    if (!showDesignSystem) return;
    requestAnimationFrame(() => document.getElementById("brand-design-system-panel")?.focus());
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || retuning || designSystemSaving) return;
      setShowDesignSystem(false);
      designSystemTriggerRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [designSystemSaving, retuning, showDesignSystem]);

  useEffect(() => {
    if (!headerActionsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!headerActionsRef.current?.contains(event.target as Node)) setHeaderActionsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHeaderActionsOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [headerActionsOpen]);

  const say = (m: ChatMsg) => setChat((c) => [...c, m]);

  function updateChatMessage(id: string, update: (message: ChatMsg) => ChatMsg) {
    setChat((messages) => messages.map((message) => (message.id === id ? update(message) : message)));
  }

  function locateChatSlide(index: number) {
    setWorkspaceView("deck");
    setFocusSlideIndex(index);
    setFocusSlideKey((key) => key + 1);
  }

  function openDesignFile(id: string) {
    const pathByArtifact: Record<string, string> = {
      questions: "generated/brief.md",
      outline: "generated/outline.md",
      inspiration: "generated/inspiration.json",
    };
    setDesignFilePath(pathByArtifact[id] ?? id);
    setDesignFileOpenKey((key) => key + 1);
    setWorkspaceView("files");
  }

  function commitQueue(next: QueuedChatRequest[]) {
    queueRef.current = next;
    setQueue(next);
    saveQueuedChatRequests(projectId, next);
  }

  function addQueuedRequest(conversationId: string, request: ChatRequest) {
    commitQueue([...queueRef.current, createQueuedChatRequest(conversationId, request)]);
  }

  function removeQueuedRequest(id: string) {
    commitQueue(queueRef.current.filter((item) => item.id !== id));
    if (editingQueuedRequestId === id) setEditingQueuedRequestId(null);
  }

  function updateQueuedRequest(id: string, request: ChatRequest) {
    commitQueue(queueRef.current.map((item) => (
      item.id === id ? updateQueuedChatRequest(item, request) : item
    )));
  }

  function reorderQueuedRequests(orderedIds: string[]) {
    commitQueue(reorderConversationQueue(
      queueRef.current,
      conversationState.activeConversationId,
      orderedIds,
    ));
  }

  function prioritizeQueuedRequest(id: string) {
    commitQueue(prioritizeQueuedChatRequest(queueRef.current, id));
  }

  function adoptRunProject(latest: Project) {
    latestProjectVersionRef.current = new Date(latest.updatedAt).getTime() || Date.now();
    projectResponseEtagRef.current = projectResponseEtag(latest);
    projectRef.current = latest;
    setProject(latest);
    setSlides(projectSlides(latest));
    if (latest.conversations?.length) {
      persistedConversationSignatureRef.current = JSON.stringify(latest.conversations);
      skipNextConversationSaveRef.current = true;
      conversationState.restoreConversations(
        latest.conversations,
        conversationState.activeConversationId,
        projectChat(latest, locale),
        latest.title,
      );
    }
    commitQueue((latest.workflow?.queuedRequests ?? []) as QueuedChatRequest[]);
  }

  async function startBackgroundRun(input: ProjectRunInput) {
    setLaunchingRun(true);
    try {
      const result = await startDetachedProjectRun(projectId, input);
      adoptRunProject(result.project);
    } catch (error: any) {
      say({ role: "assistant", content: `⚠ ${error?.message ?? error}` });
    } finally {
      setLaunchingRun(false);
    }
  }

  useEffect(() => {
    if (resumeRenderRef.current || activeRun || launchingRun) return;
    const hasUnfinishedPages = project.pages.some((page) => page.status !== "rendered");
    const wasInterrupted = project.status === "rendering"
      || project.workflow?.stage === "rendering";
    if (!wasInterrupted || !hasUnfinishedPages) return;

    // Older/client-owned renders could leave a durable page checkpoint without
    // an active run when their tab closed. Adopt that orphan once and let the
    // normal render pipeline skip every page that was already persisted.
    resumeRenderRef.current = true;
    void startBackgroundRun({
      kind: "render",
      conversationId: conversationState.activeConversationId,
      locale,
    });
    // startBackgroundRun intentionally stays outside the dependency list: this
    // recovery effect is keyed only by durable project/run state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeRun?.id,
    launchingRun,
    locale,
    project.id,
    project.pages,
    project.status,
    project.workflow?.stage,
  ]);

  /** Every project turn is server-owned. Route changes only detach this view;
   * they never own or cancel the underlying work. */
  function runRequest(request: ChatRequest): Promise<void> {
    return startBackgroundRun({
      kind: stage === "outline" ? "outline" : "chat",
      conversationId: conversationState.activeConversationId,
      locale,
      request,
    });
  }

  /** Queue follow-ups typed while work is in flight. A pre-existing queue also
   * wins over a fresh send so a late click can never jump ahead of FIFO order. */
  function enqueueOrRun(request: ChatRequest) {
    void runRequest(snapshotChatRequest(request));
  }

  useEffect(() => {
    const cached = loadQueuedChatRequests(projectId);
    const restored = cached.length
      ? cached
      : (initialProject.workflow?.queuedRequests ?? []) as QueuedChatRequest[];
    if (!cached.length && restored.length) saveQueuedChatRequests(projectId, restored);
    if (!jsonEqual(queueRef.current, restored)) {
      queueRef.current = restored;
      setQueue(restored);
    }
    setEditingQueuedRequestId(null);
  }, [projectId]);

  // Persist every conversation (debounced) so switching/reloading never loses a turn.
  useEffect(() => {
    if (!conversationState.conversations.length) return;
    if (activeRun) return;
    if (skipNextConversationSaveRef.current) {
      skipNextConversationSaveRef.current = false;
      return;
    }
    const t = setTimeout(() => saveConversations(
      projectId,
      conversationState.conversations,
      conversationState.activeConversationId,
    ), 600);
    return () => clearTimeout(t);
  }, [activeRun, conversationState.activeConversationId, conversationState.conversations, projectId]);

  const persistProjectCheckpoint = useCallback(async (
    patch: ProjectCheckpointPatch,
    signature: string,
  ) => {
    const saved = await saveProjectCheckpoint(projectId, patch);
    lastCheckpointSignatureRef.current = signature;
    const savedVersion = new Date(saved.updatedAt).getTime() || 0;
    if (savedVersion >= latestProjectVersionRef.current) {
      latestProjectVersionRef.current = savedVersion;
      projectResponseEtagRef.current = projectResponseEtag(saved);
      projectRef.current = { ...projectRef.current, updatedAt: saved.updatedAt };
    }
    if (latestCheckpointRef.current?.signature === signature) latestCheckpointRef.current = null;
  }, [projectId]);

  useEffect(() => {
    const externalRendering = !running
      && (project.status === "rendering" || project.workflow?.stage === "rendering");
    const patch = {
      config: project.config,
      title: project.title,
      researchDoc: project.researchDoc ?? "",
      workflow: {
        stage: running || externalRendering ? "rendering" as const : stage,
        workspaceMode: workspaceView === "files" ? "files" as const : "canvas" as const,
        researchMode: project.config.mode === "research",
        inspirationSkipped,
        inspirationSelection: inspireSelection,
        queuedRequests: queue,
      },
    };
    const signature = checkpointSignature(patch);
    if (signature === lastCheckpointSignatureRef.current) {
      latestCheckpointRef.current = null;
      return;
    }
    latestCheckpointRef.current = { patch, signature };
    cacheProjectCheckpoint(projectId, patch);
    if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
    checkpointTimer.current = setTimeout(() => {
      checkpointTimer.current = null;
      void persistProjectCheckpoint(patch, signature).catch(() => {});
    }, 450);
    return () => {
      if (checkpointTimer.current) {
        clearTimeout(checkpointTimer.current);
        checkpointTimer.current = null;
      }
    };
  }, [inspirationSkipped, inspireSelection, persistProjectCheckpoint, project.config, project.researchDoc, project.title, projectId, queue, running, stage, workspaceView]);

  useEffect(() => {
    const flush = () => {
      const pending = latestCheckpointRef.current;
      if (pending && pending.signature !== lastCheckpointSignatureRef.current) {
        void persistProjectCheckpoint(pending.patch, pending.signature).catch(() => {});
      }
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [persistProjectCheckpoint]);

  // --- draft outline stage (编辑大纲 → 确认 → 渲染) ---

  function onOutlineChange(pages: OutlinePage[]) {
    setOutline(pages);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveOutline(projectId, pages).catch(() => {});
    }, 700);
  }

  async function handleOutlineChat(request: ChatRequest) {
    const designFiles = request.designFiles ?? [];
    say({
      role: "user",
      content: request.message,
      attachment: request.context,
      contextItems: request.attachments,
      designFiles,
    });
    const runId = createAgentRunId("outline-edit");
    const startedAt = Date.now();
    say({
      id: runId,
      role: "assistant",
      content: "",
      process: {
        state: "running",
        title: t("agent.revisingOutline"),
        notes: [t("agent.revisingOutlineNote")],
        tools: [
          ...designFiles.map((file, index) => ({
            id: `read-${index}`,
            name: "read",
            kind: "read" as const,
            label: t("agent.readDesignFile"),
            detail: file.relativePath,
            path: file.path,
            relativePath: file.relativePath,
            state: "running" as const,
          })),
          {
            id: "revise-outline",
            name: "revise_outline",
            kind: "edit" as const,
            label: t("agent.reviseOutline"),
            detail: t("agent.reviseOutlineDetail"),
            state: "running" as const,
          },
        ],
      },
    });
    setBusy(true);
    try {
      const { pages, reply } = await reviseOutlineChat(projectId, request.message, designFiles);
      setOutline(pages);
      updateChatMessage(runId, (current) => {
        const withReads = patchAgentTools(current.process!, (tool) => tool.kind === "read", { state: "complete" });
        return {
          ...current,
          content: reply || t("flow.outlineUpdated"),
          ran: elapsedRunLabel(startedAt, locale),
          process: {
            ...patchAgentTool(withReads, "revise-outline", { state: "complete", detail: t("agent.outlineRevised", { count: pages.length }) }),
            state: "complete",
            title: t("agent.outlineComplete"),
          },
        };
      });
    } catch (e: any) {
      updateChatMessage(runId, (current) => ({
        ...current,
        content: `⚠ ${e?.message ?? e}`,
        ran: elapsedRunLabel(startedAt, locale),
        process: {
          ...stopRunningTools(current.process!, String(e?.message ?? e)),
          state: "error",
          title: t("agent.outlineFailed"),
        },
      }));
    } finally {
      setBusy(false);
    }
  }

  function handleRenderEvent(ev: ProgressEvent) {
    switch (ev.type) {
      case "page_start":
        setSlides((s) => s.map((x) => (x.index === ev.index ? { ...x, status: "working" } : x)));
        break;
      case "page_rendered":
        setSlides((s) =>
          s.map((x) => (x.index === ev.index ? { ...x, status: "rendered", image: ev.image, bust: Date.now() } : x)),
        );
        break;
      case "page_error":
        setSlides((s) => s.map((x) => (x.index === ev.index ? { ...x, status: "error", error: ev.error } : x)));
        break;
      case "done":
        setRunning(false);
        setProject((current) => ({
          ...current,
          status: "ready",
          workflow: { ...(current.workflow ?? {}), stage: "deck" },
        }));
        break;
      case "error":
        say({ role: "assistant", content: `⚠ ${ev.error}` });
        break;
    }
  }

  /** Outline confirmed. Detour to the inspiration step if no style is chosen. */
  async function confirmOutline() {
    if (running || busy || !outline.length) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      await saveOutline(projectId, outline);
    } catch (e: any) {
      say({ role: "assistant", content: `⚠ ${e?.message ?? e}` });
      return;
    }
    say(outlineSnapshotMessage(project.title, outline));
    if (!project?.config.template && !project?.config.designSystem) {
      // Detour to the inspiration step: pending skeleton deck + an in-chat card
      // whose Browse button opens the style popup. Render waits for pick/skip.
      setSlides(outline.map((o, i) => ({ index: i + 1, title: o.title, status: "pending" })));
      setStage("inspire");
      setInspireSelection("");
      void saveProjectCheckpoint(projectId, {
        config: project.config,
        title: project.title,
        researchDoc: project.researchDoc ?? "",
        workflow: {
          stage: "inspire",
          researchMode: project.config.mode === "research",
          workspaceMode: "canvas",
          selectedDesignFileId: "inspiration",
          inspirationSkipped: false,
        },
      }).catch(() => {});
      const matchQuery = [project?.config.requirement ?? "", ...outline.map((o) => o.title)]
        .filter(Boolean)
        .join(" ");
      const msgId = createAgentRunId("inspire");
      setInspireMsgId(msgId);
      say({
        id: msgId,
        role: "assistant",
        content: t("flow.stylePrompt"),
        inspiration: {
          query: inspireQueryFor(project?.config.requirement ?? "", outline[0]?.title),
          coverIds: matchCommunityTemplates(matchQuery, 4).map((t) => t.id),
          total: COMMUNITY_TEMPLATES.length,
        },
      });
      return;
    }
    setInspirationSkipped(false);
    if (project.config.designSystem) {
      say({ role: "assistant", content: t("brandSystem.renderContext") });
    } else if (project.config.template) {
      say(styleSnapshotMessage(project.config.template, project.config.requirement));
    }
    renderNow();
  }

  /** Browse opens the popup; skip resolves the step with the default style. */
  function onInspire(action: "browse" | "skip") {
    if (action === "browse" && stage === "inspire") setWorkspaceView("deck");
    else if (action === "browse") setInspireOpen(true);
    else void handleInspireGenerate(undefined);
  }

  /** Apply an inspiration pick (or skip) then render. */
  async function handleInspireGenerate(templateId?: string) {
    if (running || busy || retuning) return;
    const redrawExisting = Boolean(templateId) && stage === "deck" && slides.some((slide) => slide.status === "rendered");
    const versionGroupId = createAgentRunId("restyle-version");
    const versionPrompt = templateId
      ? t("flow.styleSelected", { name: getCommunityTemplate(templateId)?.name ?? templateId })
      : t("flow.styleSkipped");
    setInspireOpen(false);
    setInspireSelection("");
    if (templateId) {
      setInspirationSkipped(false);
      const tpl = getCommunityTemplate(templateId);
      say({ role: "user", content: t("flow.styleSelected", { name: tpl?.name ?? templateId }) });
      try {
        await patchProjectStyle(projectId, { template: templateId }, {
          prompt: versionPrompt,
          groupId: versionGroupId,
        });
        setProject((p) => ({ ...p, config: { ...p.config, template: templateId } }));
      } catch (e: any) {
        say({ role: "assistant", content: `⚠ ${t("flow.styleFailed", { error: e?.message ?? String(e) })}` });
        return;
      }
    } else {
      const useBrandSystem = Boolean(project.config.designSystem);
      setInspirationSkipped(!useBrandSystem);
      say({
        role: "user",
        content: useBrandSystem ? t("brandSystem.useSaved") : t("flow.styleSkipped"),
      });
    }
    if (inspireMsgId) {
      updateChatMessage(inspireMsgId, (m) => ({
        ...m,
        inspiration: m.inspiration
          ? { ...m.inspiration, chosen: templateId, resolved: true }
          : undefined,
      }));
    }
    if (redrawExisting && templateId) {
      setRetuning(true);
      setDesignSystemProgress(1);
      setBusy(true);
      say({ role: "assistant", content: t("restyle.started", { count: slides.length }) });
      for (const [position, slide] of slides.entries()) {
        setDesignSystemProgress(position + 1);
        setSlides((items) => items.map((item) => item.index === slide.index ? { ...item, status: "working" } : item));
        try {
          const image = await regenerateSlide(projectId, slide.index, undefined, undefined, {
            prompt: versionPrompt,
            groupId: versionGroupId,
          });
          setSlides((items) => items.map((item) => item.index === slide.index
            ? { ...item, status: "rendered", image, bust: Date.now() }
            : item));
        } catch (error: any) {
          setSlides((items) => items.map((item) => item.index === slide.index
            ? { ...item, status: "error", error: String(error?.message ?? error) }
            : item));
        }
      }
      say({ role: "assistant", content: t("restyle.done", { count: slides.length }) });
      setDesignSystemProgress(0);
      setRetuning(false);
      setBusy(false);
      return;
    }
    renderNow();
  }

  async function renderNow() {
    if (activeRun || launchingRun) return;
    setWorkspaceView("deck");
    setStage("deck");
    setSlides((current) => current.length
      ? current
      : outline.map((page, index) => ({ index: index + 1, title: page.title, status: "pending" })));
    await startBackgroundRun({
      kind: "render",
      conversationId: conversationState.activeConversationId,
      locale,
    });
  }

  /** Conversational edit: plan → apply to targeted slides in order. */
  async function handleChat(request: ChatRequest) {
    setBusy(true);
    try {
      await runChatTurn(request, {
        projectId,
        locale,
        t,
        say,
        update: updateChatMessage,
        getSlides: () => slidesRef.current,
        setSlides,
        appendTodos: conversationState.appendTodos,
        patchTodo: conversationState.patchTodo,
        supportsDesignFiles: true,
      });
    } catch {
      /* runChatTurn writes the failure into the transcript */
    } finally {
      setBusy(false);
    }
  }

  async function startBackgroundMark({
    slide,
    note,
    source,
  }: {
    slide: UiSlide;
    note: string;
    source: string;
  }) {
    await startBackgroundRun({
      kind: "mark",
      conversationId: conversationState.activeConversationId,
      locale,
      mark: {
        index: slide.index,
        source,
        note,
        title: slide.title,
      },
    });
  }

  async function stopBackgroundRun() {
    if (!activeRun || stoppingRun) return;
    setStoppingRun(true);
    try {
      const result = await stopDetachedProjectRun(projectId);
      adoptRunProject(result.project);
    } catch (error: any) {
      say({ role: "assistant", content: `⚠ ${error?.message ?? error}` });
    } finally {
      setStoppingRun(false);
      void refreshPersistedProject();
    }
  }

  function askAboutSlide(slide: UiSlide) {
    setChatContext({
      slideIndex: slide.index,
      title: slide.title || t("chat.slide", { index: slide.index }),
      imageUrl: fileUrl(projectId, slide.image, slide.bust),
    });
    setChatFocusKey((key) => key + 1);
  }

  function mirrorMarkToChat(event: MarkAgentEvent) {
    if (event.type === "request") {
      say({
        role: "user",
        content: event.note || t("agent.markRequest", { index: event.slide.index }),
        attachment: {
          slideIndex: event.slide.index,
          title: `${event.slide.title} · ${t("agent.visualMark")}`,
          imageUrl: fileUrl(projectId, event.markedImage),
        },
      });
      const runId = createAgentRunId("visual-mark");
      markRunRef.current = { id: runId, startedAt: Date.now(), slideIndex: event.slide.index };
      say({
        id: runId,
        role: "assistant",
        content: "",
        process: {
          state: "running",
          title: t("agent.editingSlide", { index: event.slide.index }),
          notes: [
            t("agent.markNoteOne"),
            t("agent.markNoteTwo"),
          ],
          tools: [
            {
              id: "mark-edit",
              name: "mark_edit_page",
              label: t("agent.applyVisual"),
              detail: t("agent.processMark", { index: event.slide.index }),
              state: "running",
            },
          ],
        },
      });
    } else if (event.type === "complete") {
      const run = markRunRef.current;
      if (!run) return;
      updateChatMessage(run.id, (current) => ({
        ...current,
        content: t("agent.markApplied", { index: event.slide.index }),
        ran: elapsedRunLabel(run.startedAt, locale),
        attachment: {
          slideIndex: event.slide.index,
          title: `${event.slide.title} · ${t("agent.updated")}`,
          imageUrl: fileUrl(projectId, event.image, Date.now()),
        },
        process: {
          ...patchAgentTool(current.process!, "mark-edit", { state: "complete", detail: t("agent.updatedSaved") }),
          state: "complete",
          title: t("agent.updatedSlide", { index: event.slide.index }),
        },
      }));
      markRunRef.current = null;
    } else if (event.type === "error") {
      const run = markRunRef.current;
      if (!run) return;
      updateChatMessage(run.id, (current) => ({
        ...current,
        content: `⚠ ${event.error}`,
        ran: elapsedRunLabel(run.startedAt, locale),
        process: {
          ...patchAgentTool(current.process!, "mark-edit", { state: "error", detail: event.error }),
          state: "error",
          title: t("agent.notUpdated", { index: event.slide.index }),
        },
      }));
      markRunRef.current = null;
    }
  }

  function closeBrandDesignSystem() {
    if (retuning || designSystemSaving) return;
    setShowDesignSystem(false);
    designSystemTriggerRef.current?.focus();
  }

  /** Persist always-on brand context; optionally apply it to every existing slide. */
  async function saveBrandDesignSystem(input: BrandDesignSystemSubmit) {
    if (retuning || designSystemSaving || busy || running) return;
    const redraw = input.redraw && stage === "deck";
    setDesignSystemError("");
    setDesignSystemSaving(true);
    const versionGroupId = createAgentRunId("brand-version");
    const versionPrompt = [input.designSystem.style.direction, input.designSystem.style.keywords]
      .filter(Boolean)
      .join(". ") || t("brandSystem.saved");
    if (redraw) {
      setRetuning(true);
      setDesignSystemProgress(1);
      setBusy(true);
      say({ role: "assistant", content: t("restyle.started", { count: slides.length }) });
    }
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template: input.template ?? "",
          style: [input.designSystem.style.direction, input.designSystem.style.keywords].filter(Boolean).join(". "),
          materialIds: input.materialIds,
          designSystem: input.designSystem,
          versionPrompt,
          versionGroupId,
        }),
      });
      const saved = await response.json().catch(() => null);
      if (!response.ok || !saved) throw new Error(saved?.error || t("brandSystem.saveFailed"));
      setProject(saved as Project);
      setInspirationSkipped(false);

      if (redraw) {
        for (const [position, slide] of slides.entries()) {
          setDesignSystemProgress(position + 1);
          setSlides((items) => items.map((item) => (item.index === slide.index ? { ...item, status: "working" } : item)));
          try {
            const image = await regenerateSlide(projectId, slide.index, undefined, undefined, {
              prompt: versionPrompt,
              groupId: versionGroupId,
            });
            setSlides((items) =>
              items.map((item) =>
                item.index === slide.index ? { ...item, status: "rendered", image, bust: Date.now() } : item,
              ),
            );
          } catch {
            /* Keep applying the shared system to the remaining slides. */
          }
        }
      }

      setShowDesignSystem(false);
      requestAnimationFrame(() => designSystemTriggerRef.current?.focus());
      say({
        role: "assistant",
        content: redraw
          ? t("restyle.done", { count: slides.length })
          : t("brandSystem.saved"),
      });
    } catch (error: any) {
      const message = String(error?.message ?? error);
      setDesignSystemError(message);
      if (redraw) say({ role: "assistant", content: `⚠ ${message}` });
    } finally {
      setDesignSystemProgress(0);
      setDesignSystemSaving(false);
      setRetuning(false);
      if (redraw) setBusy(false);
    }
  }

  const status: GenStatus | null = activeRun
    ? {
        phase: activeRun.kind === "render"
          ? "rendering"
          : activeRun.kind === "outline"
            ? "outlining"
            : "editing",
        total: activeRun.progress?.total ?? slides.length,
        done: activeRun.progress?.current ?? 0,
        current: activeRun.targetSlide,
        note: activeRun.detail || activeRun.label,
      }
    : stage === "outline"
      ? running
        ? { phase: "outlining", total: 0, done: 0 }
        : null
      : deriveStatus(slides, {
          streaming: running,
          editing: busy,
          note: retuning ? t("brandSystem.redrawProgress", { current: designSystemProgress, total: slides.length }) : undefined,
        });
  const renderedSlides = slides.filter((slide) => slide.status === "rendered").length;
  const templateLabel = project.config.template
    ? getTemplate(project.config.template)?.name
      ?? getCommunityTemplate(project.config.template)?.name
      ?? project.config.template
    : project.config.designSystem?.brand.name
      || project.config.designSystem?.style.direction
      || undefined;
  const workflow = buildWorkflowProgress({
    stage,
    outlineCount: outline.length,
    researchEnabled: project.config.mode === "research" || Boolean(project.researchDoc),
    researchStatus: project.research?.status ?? (project.researchDoc ? "complete" : undefined),
    researchPhase: project.research?.phase,
    researchRound: project.research?.round,
    researchTotalRounds: project.research?.totalRounds,
    researchSearchCount: project.research?.searchCount,
    researchSourceCount: project.research?.sources.length,
    templateLabel,
    inspirationSkipped,
    running: stage === "deck" && (running || activeRun?.kind === "render"),
    rendered: renderedSlides,
    total: slides.length || outline.length,
      renderDetail: status?.phase === "rendering"
      ? status.note
        || (status.current
            ? t("status.renderingNamed", { index: status.current, title: status.currentTitle ? ` · ${status.currentTitle}` : "" })
            : t("status.renderingCount", { done: status.done, total: status.total }))
        : undefined,
      locale,
    });
  const workspaceTabs = (
    <WorkspaceModeTabs
      mode={workspaceView === "files" ? "files" : "canvas"}
      onChange={(mode) => setWorkspaceView(mode === "files" ? "files" : "deck")}
    />
  );
  const persistedWorkflowFiles = useMemo<DesignFile[]>(() => {
    const files: DesignFile[] = [];
    const questions = project.workflow?.questions ?? [];
    const answerSummary = project.workflow?.clarifyAnswerSummary?.trim();
    if (questions.length) {
      files.push({
        id: "questions",
        kind: "questions",
        title: t("designFiles.questionsTitle"),
        subtitle: answerSummary
          ? t("designFiles.questionsConfirmed", { count: questions.length })
          : t("designFiles.questionsPending", { count: questions.length }),
        questions,
        answerSummary: answerSummary || undefined,
      });
    }
    if (outline.length) {
      files.push({
        id: "outline",
        kind: "outline",
        title: project.title || t("designFiles.outlineTitle"),
        subtitle: stage === "outline"
          ? t("designFiles.outlineEditing", { count: outline.length })
          : t("designFiles.outlineConfirmed", { count: outline.length }),
        pages: outline.map((page) => ({ title: page.title, points: [...page.points] })),
      });
    }
    const researchMarkdown = project.research?.markdown || project.researchDoc || "";
    if (researchMarkdown || project.research) {
      const researchStatus = project.research?.status ?? "complete";
      files.push({
        id: "research",
        kind: "research",
        title: t("designFiles.researchTitle"),
        subtitle: researchStatus === "running"
          ? t("designFiles.researchRunning", { count: project.research?.sources.length ?? 0 })
          : researchStatus === "error"
            ? t("designFiles.researchError")
            : t("designFiles.researchComplete", { count: project.research?.sources.length ?? 0 }),
        markdown: researchMarkdown,
        status: researchStatus,
      });
    }
    const inspiration = [...chat].reverse().find((message) => message.inspiration)?.inspiration;
    if (stage === "inspire" || project.config.template || inspirationSkipped || inspiration) {
      const selectedTemplateId = project.config.template || inspiration?.chosen || inspireSelection;
      const fallbackQuery = [project.config.requirement, ...outline.map((page) => page.title)]
        .filter(Boolean)
        .join(" ");
      files.push({
        id: "inspiration",
        kind: "inspiration",
        title: t("designFiles.inspirationTitle"),
        subtitle: inspirationSkipped
          ? t("designFiles.inspirationSkipped")
          : selectedTemplateId
            ? t("designFiles.inspirationSelected")
            : t("designFiles.inspirationPending"),
        selectedTemplateId,
        candidateTemplateIds: inspiration?.coverIds?.length
          ? [...inspiration.coverIds]
          : matchCommunityTemplates(fallbackQuery, 4).map((template) => template.id),
        skipped: inspirationSkipped,
      });
    }
    return files;
  }, [chat, inspirationSkipped, inspireSelection, outline, project, stage, t]);
  const designSystem = normalizeDeckDesignSystem(project.config.designSystem, {
    template: project.config.template,
    style: project.config.style,
  });
  const activeBrandMaterialIds = new Set(designSystem.brand.assetMaterialIds);
  const designSystemMaterials: MaterialTrayItem[] = (project.materials ?? [])
    .filter((item) => activeBrandMaterialIds.has(item.id) && item.kind !== "file")
    .map((item) => ({
      id: item.id,
      name: item.name,
      url: `/api/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(item.file)}`,
    }));
  const projectHeaderActions = (
    <div className="deck-header-extras" ref={headerActionsRef}>
      <button
        type="button"
        className={`iconbtn version-history-trigger${versionHistoryOpen ? " active" : ""}`}
        disabled={workspaceBusy}
        onClick={() => {
          setHeaderActionsOpen(false);
          setVersionHistoryOpen(true);
        }}
        title={t("versions.title")}
      >
        <ClockCounterClockwise size={18} weight="regular" aria-hidden="true" />
        <span className="stage-action-label">{t("versions.entry")}</span>
      </button>
      <button
        ref={designSystemTriggerRef}
        type="button"
        className={`iconbtn project-actions-trigger${headerActionsOpen || showDesignSystem ? " active" : ""}`}
        onClick={() => setHeaderActionsOpen((open) => !open)}
        aria-expanded={headerActionsOpen}
        aria-controls="project-header-actions-menu"
        aria-haspopup="menu"
        title={t("topbar.moreActionsHelp")}
      >
        <DotsThree size={18} weight="bold" aria-hidden="true" />
        <span className="stage-action-label">{t("topbar.moreActions")}</span>
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {headerActionsOpen ? (
        <div id="project-header-actions-menu" className="pop down project-actions-pop" role="menu">
          <SaveProjectTemplateButton
            projectId={projectId}
            projectTitle={project.title}
            disabled={workspaceBusy}
            variant="menu-item"
            onModalClose={() => setHeaderActionsOpen(false)}
          />
          <button
            type="button"
            className="pop-item project-actions-menu-item"
            role="menuitem"
            disabled={workspaceBusy || retuning || designSystemSaving}
            onClick={() => {
              setHeaderActionsOpen(false);
              setDesignSystemError("");
              setShowDesignSystem(true);
            }}
          >
            <Palette size={17} weight="regular" aria-hidden="true" />
            <span className="grow">
              <b>{t("brandSystem.button")}</b>
              <em>{t("brandSystem.open")}</em>
            </span>
            <span className="brand-system-trigger-swatches" aria-hidden="true">
              {[designSystem.colors.primary, designSystem.colors.accent, designSystem.colors.ink, designSystem.colors.surface]
                .map((color, index) => <i key={`${color}-${index}`} style={{ background: color }} />)}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="ws project-ws">
      <ChatColumn
        projectId={projectId}
        workspaceTitle={project.title}
        homeHref="/"
        messages={chat}
        busy={workspaceBusy}
        backgroundRun={activeRun}
        backgroundRunStopping={stoppingRun}
        onStopBackgroundRun={() => void stopBackgroundRun()}
        onSend={enqueueOrRun}
        status={status}
        queued={currentConversationQueue}
        editingQueuedId={editingQueuedRequestId}
        onEditingQueuedChange={setEditingQueuedRequestId}
        onUpdateQueued={updateQueuedRequest}
        onRemoveQueued={removeQueuedRequest}
        onReorderQueued={reorderQueuedRequests}
        onPrioritizeQueued={prioritizeQueuedRequest}
        context={chatContext}
        onClearContext={() => setChatContext(null)}
        focusKey={chatFocusKey}
        onSelectSlide={locateChatSlide}
        onInspire={onInspire}
        onOpenDesignFile={openDesignFile}
        workflow={workflow}
        todos={conversationState.todos}
        conversations={conversationState.summaries}
        activeConversationId={conversationState.activeConversationId}
        onSelectConversation={(id) => {
          if (workspaceBusy) return;
          setEditingQueuedRequestId(null);
          setChatContext(null);
          conversationState.selectConversation(id);
        }}
        onCreateConversation={() => {
          if (workspaceBusy) return;
          setEditingQueuedRequestId(null);
          setChatContext(null);
          conversationState.createConversation();
        }}
        onRenameConversation={conversationState.renameConversation}
        onDeleteConversation={(id) => {
          conversationState.deleteConversation(id);
          commitQueue(queueRef.current.filter((item) => item.conversationId !== id));
          setEditingQueuedRequestId(null);
        }}
        conversationManagementDisabled={workspaceBusy}
        placeholder={
          stage === "outline"
            ? t("flow.placeholderOutline")
            : stage === "inspire"
              ? t("flow.placeholderInspire")
              : t("flow.placeholderDeck")
        }
      />
      <div className="deckpane">
        {workspaceView === "files" ? (
          <DesignFiles
            projectId={projectId}
            title={project.title}
            showProjectTitle={false}
            initialPath={designFilePath}
            selectionRequestKey={designFileOpenKey}
            workflowFiles={persistedWorkflowFiles}
            headerPrefix={workspaceTabs}
            onClose={() => setWorkspaceView("deck")}
          />
        ) : stage === "outline" ? (
          <OutlineBoard
            title={project.title}
            showTitle={false}
            aspect={project.config.aspect}
            outline={outline}
            onChange={onOutlineChange}
            onConfirm={confirmOutline}
            busy={workspaceBusy && outline.length > 0}
            streaming={false}
            researchDoc={project.researchDoc}
            headerPrefix={workspaceTabs}
            headerExtra={projectHeaderActions}
          />
        ) : stage === "inspire" ? (
          <InspirationStage
            requirement={project.config.requirement}
            outlineTitles={outline.map((page) => page.title).filter(Boolean)}
            selected={inspireSelection}
            busy={workspaceBusy}
            headerPrefix={workspaceTabs}
            headerExtra={projectHeaderActions}
            onSelect={(templateId) => setInspireSelection(templateId ?? "")}
            onSkip={() => void handleInspireGenerate(undefined)}
            onConfirm={(templateId) => void handleInspireGenerate(templateId)}
          />
        ) : (
          <SlideStage
            projectId={projectId}
            aspect={project.config.aspect}
            title={project.title}
            showTitle={false}
            slides={slides}
            onSlides={(u) => setSlides(u)}
            busy={workspaceBusy}
            setBusy={setBusy}
            streaming={running || activeRun?.kind === "render"}
            headerPrefix={workspaceTabs}
            onAskSlide={askAboutSlide}
            onStartMarkRun={startBackgroundMark}
            focusSlideIndex={focusSlideIndex}
            focusSlideKey={focusSlideKey}
            deepLinkAction={slideDeepLinkAction}
            headerExtra={projectHeaderActions}
          />
        )}
        {showDesignSystem && (
          <>
            <button
              className="retune-scrim"
              aria-label={t("brandSystem.close")}
              onClick={closeBrandDesignSystem}
            />
            <BrandDesignSystemPanel
              value={designSystem}
              initialTemplate={project.config.template}
              initialMaterials={designSystemMaterials}
              slideCount={stage === "deck" ? slides.length : 0}
              saving={designSystemSaving}
              redrawing={retuning}
              progress={designSystemProgress}
              error={designSystemError}
              onClose={closeBrandDesignSystem}
              onSubmit={(input) => void saveBrandDesignSystem(input)}
            />
          </>
        )}
      </div>
      {inspireOpen && (
        <InspireDialog
          requirement={project.config.requirement}
          outlineTitles={outline.map((o) => o.title).filter(Boolean)}
          selected={project.config.template}
          intent={stage === "deck" ? "apply" : "generate"}
          onClose={() => setInspireOpen(false)}
          onSkip={stage === "deck" ? undefined : () => handleInspireGenerate(undefined)}
          onSubmit={(id) => handleInspireGenerate(id)}
        />
      )}
      {versionHistoryOpen ? (
        <DeckVersionDialog
          projectId={projectId}
          initialVersionId={versionDeepLinkId}
          initialSlideIndex={versionDeepLinkSlide}
          onClose={() => setVersionHistoryOpen(false)}
          onRestored={(restored) => {
            projectRef.current = restored;
            setProject(restored);
            setSlides(projectSlides(restored));
            setOutline(projectOutline(restored));
            setStage("deck");
            latestProjectVersionRef.current = new Date(restored.updatedAt).getTime() || Date.now();
            projectResponseEtagRef.current = projectResponseEtag(restored);
          }}
        />
      ) : null}
    </div>
  );
}
