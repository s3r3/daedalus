import { DEFAULT_TIMEOUT_MS } from './config.js';

export { DEFAULT_TIMEOUT_MS };
export function timeoutFor(task) {
  return task.fast ? 1000 : DEFAULT_TIMEOUT_MS;
}
