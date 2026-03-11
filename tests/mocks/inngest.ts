import { vi } from "vitest";

export function createMockInngestStep() {
  return {
    run: vi.fn((name: string, fn: () => any) => fn()),
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
    sendEvent: vi.fn(),
    waitForEvent: vi.fn(),
    invoke: vi.fn(),
  };
}

export function createMockInngestEvent(
  name: string,
  data: Record<string, any>
) {
  return {
    name,
    data,
    ts: Date.now(),
    id: `test-event-${Date.now()}`,
  };
}
