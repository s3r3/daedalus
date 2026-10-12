export const DEFAULT_TIMEOUT_MS = 30000;

export function timeoutFor(task) {
  return task.fast ? 1000 : DEFAULT_TIMEOUT_MS;
}
