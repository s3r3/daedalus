import type {
  ResearchActivity,
  ResearchProgress,
  ResearchProgressEvent,
  ResearchSource,
} from "./types";

const MAX_ACTIVITIES = 80;
const MAX_SOURCES = 80;

export function researchSourceId(url: string): string {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `source-${(hash >>> 0).toString(36)}`;
}

export function createResearchProgress(
  totalRounds = 2,
  now = Date.now(),
): ResearchProgress {
  return {
    status: "running",
    phase: "starting",
    round: 0,
    totalRounds: Math.max(1, totalRounds),
    searchCount: 0,
    activities: [],
    sources: [],
    markdown: "",
    startedAt: now,
    updatedAt: now,
  };
}

function settleRunning(activities: ResearchActivity[]): ResearchActivity[] {
  return activities.map((activity) => (
    activity.state === "running" ? { ...activity, state: "complete" as const } : activity
  ));
}

function upsertActivity(
  activities: ResearchActivity[],
  activity: ResearchActivity,
): ResearchActivity[] {
  const next = activities.some((item) => item.id === activity.id)
    ? activities.map((item) => item.id === activity.id ? { ...item, ...activity } : item)
    : [...activities, activity];
  return next.slice(-MAX_ACTIVITIES);
}

function sourceQuality(source: ResearchSource) {
  const host = (() => {
    try { return new URL(source.url).hostname.replace(/^www\./, ""); } catch { return source.url; }
  })();
  return (source.title && source.title !== host ? 2 : 0) + (source.snippet ? 1 : 0);
}

function upsertSource(sources: ResearchSource[], incoming: ResearchSource): ResearchSource[] {
  const normalized = { ...incoming, id: incoming.id || researchSourceId(incoming.url) };
  const existing = sources.find((source) => source.url === normalized.url);
  if (!existing) return [...sources, normalized].slice(-MAX_SOURCES);
  const preferred = sourceQuality(normalized) >= sourceQuality(existing) ? normalized : existing;
  const merged = {
    ...existing,
    ...preferred,
    snippet: normalized.snippet || existing.snippet,
    title: normalized.title || existing.title,
  };
  return sources.map((source) => source.url === normalized.url ? merged : source);
}

/** Apply one streamed research event to the durable client/server state. */
export function reduceResearchProgress(
  current: ResearchProgress | undefined,
  event: ResearchProgressEvent,
  now = Date.now(),
): ResearchProgress {
  const totalRounds = Math.max(1, event.totalRounds ?? current?.totalRounds ?? 2);
  if (event.phase === "starting") return createResearchProgress(totalRounds, now);

  const base = current ?? createResearchProgress(totalRounds, now);
  const round = Math.max(0, event.round ?? base.round);
  let next: ResearchProgress = {
    ...base,
    round,
    totalRounds,
    updatedAt: now,
  };

  if (event.phase === "planning") {
    const activities = settleRunning(next.activities);
    next = {
      ...next,
      status: "running",
      phase: "planning",
      activities: upsertActivity(activities, {
        id: `round-${round}`,
        kind: "round",
        round,
        detail: event.detail,
        state: "running",
        ts: now,
      }),
    };
  } else if (event.phase === "searching") {
    const id = `search-${event.callId || `${round}-${next.searchCount + 1}`}`;
    const existed = next.activities.some((activity) => activity.id === id);
    next = {
      ...next,
      phase: "searching",
      searchCount: existed ? next.searchCount : next.searchCount + 1,
      activities: upsertActivity(next.activities, {
        id,
        kind: "search",
        round,
        detail: event.detail,
        state: event.state ?? "running",
        ts: now,
      }),
    };
  } else if (event.phase === "source" && event.source?.url) {
    next = {
      ...next,
      phase: next.phase === "starting" ? "searching" : next.phase,
      sources: upsertSource(next.sources, { ...event.source, round: event.source.round ?? round }),
    };
  } else if (event.phase === "writing") {
    next = {
      ...next,
      phase: "writing",
      activities: upsertActivity(settleRunning(next.activities), {
        id: `writing-${round}`,
        kind: "writing",
        round,
        detail: event.detail,
        state: "running",
        ts: now,
      }),
    };
  } else if (event.phase === "delta" && event.delta) {
    const changingRound = next.draftRound !== round;
    next = {
      ...next,
      phase: "writing",
      draftRound: round,
      markdown: `${changingRound ? "" : next.markdown}${event.delta}`,
    };
  } else if (event.phase === "brief") {
    next = {
      ...next,
      phase: "writing",
      markdown: event.markdown ?? next.markdown,
      draftRound: round,
      activities: next.activities.map((activity) => (
        activity.id === `writing-${round}` ? { ...activity, state: "complete" as const } : activity
      )),
    };
  } else if (event.phase === "complete") {
    next = {
      ...next,
      status: "complete",
      phase: "complete",
      markdown: event.markdown ?? next.markdown,
      activities: settleRunning(next.activities),
      completedAt: now,
    };
  } else if (event.phase === "error") {
    next = {
      ...next,
      status: "error",
      phase: "error",
      error: event.detail,
      activities: next.activities.map((activity) => (
        activity.state === "running" ? { ...activity, state: "error" as const } : activity
      )),
      completedAt: now,
    };
  }

  return next;
}
