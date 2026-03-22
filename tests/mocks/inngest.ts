import { vi } from "vitest";

/**
 * Extract the handler function from an Inngest function for testing.
 * Inngest marks .fn as private, so we cast through unknown.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getInngestHandler<T = any>(fn: unknown): (...args: any[]) => Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (fn as Record<string, any>).fn as (...args: any[]) => Promise<T>;
}

export function createMockInngestStep() {
  return {
    run: vi.fn((name: string, fn: () => unknown) => fn()),
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
    sendEvent: vi.fn(),
    waitForEvent: vi.fn(),
    invoke: vi.fn(),
  };
}

export function createMockInngestEvent(name: string, data: Record<string, unknown>) {
  return {
    name,
    data,
    ts: Date.now(),
    id: `test-event-${Date.now()}`,
  };
}
