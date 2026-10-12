import type { Event, EventType } from "./contracts.ts";
import type { TaskStore } from "./persistence.ts";

/**
 * In-process, concurrency-safe event bus stub (Phase 1).
 * It backs the append-only event log: subscribers receive events in seq order.
 */
export type EventHandler = (event: Event) => void | Promise<void>;

export class EventBus {
  #handlers = new Map<EventType | "*", Set<EventHandler>>();
  #queue: Promise<void> = Promise.resolve();

  on(type: EventType | "*", handler: EventHandler): () => void {
    const set = this.#handlers.get(type) ?? new Set();
    set.add(handler);
    this.#handlers.set(type, set);
    return () => set.delete(handler);
  }

  /** Publish serializes delivery so concurrent emitters cannot interleave handlers. */
  publish(event: Event): void {
    this.#queue = this.#queue.then(async () => {
      const specific = this.#handlers.get(event.type);
      const wildcard = this.#handlers.get("*");
      for (const handler of [...(specific ?? []), ...(wildcard ?? [])]) {
        await handler(event);
      }
    });
  }

  /** Await queue drain — tests use this to assert delivery completed. */
  async drain(): Promise<void> {
    await this.#queue;
  }
}

export type EventTarget = { bus: EventBus; store?: TaskStore };

/**
 * Single authority for seq allocation + append + publish (PLAN.md §3.2, §3.6).
 * Every producer (agent loop, execution harness, runtime) emits through here so
 * the append-only log stays the one ordered feed both interfaces replay.
 */
export function emitEvent(
  target: EventTarget,
  taskId: string,
  turnId: string | undefined,
  type: EventType,
  payload: unknown,
): Event {
  const seq = target.store ? target.store.replay(taskId).length + 1 : 0;
  const event: Event = { seq, task_id: taskId, turn_id: turnId, type, payload, ts: new Date().toISOString() };
  target.store?.append(taskId, event);
  target.bus.publish(event);
  return event;
}
