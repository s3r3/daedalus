export interface ChatScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function chatBottomDistance(metrics: ChatScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

export function isNearChatBottom(metrics: ChatScrollMetrics, threshold = 72): boolean {
  return chatBottomDistance(metrics) <= threshold;
}

