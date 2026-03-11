import { vi } from "vitest";

// Silence console.log in tests unless debugging
vi.spyOn(console, "log").mockImplementation(() => {});
