/**
 * Shared textarea submit contract:
 * - Enter submits
 * - Shift+Enter inserts a newline
 * - Enter used to confirm an IME candidate never submits
 *
 * keyCode 229 is a Safari/WebKit fallback for composition keydowns that can
 * report `isComposing` incorrectly at the end of a candidate selection.
 */
export function shouldSubmitTextarea(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}
