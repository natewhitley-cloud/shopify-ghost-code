import type Database from "better-sqlite3";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// We need the REAL better-sqlite3 for the in-memory test DB, but we also
// need to mock the module so the service under test doesn't try to open
// a file on disk. Solution: import the real module via dynamic import
// before mocking, then wire the mock to delegate to our test DB.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RealDatabase: any;
let testDb: Database.Database;

function seedTestDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE categories (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      url         TEXT NOT NULL,
      parent_slug TEXT,
      app_count   INTEGER,
      last_scraped TIMESTAMP
    );

    CREATE TABLE apps (
      id             INTEGER PRIMARY KEY,
      name           TEXT,
      slug           TEXT UNIQUE,
      url            TEXT,
      vendor         TEXT,
      rating         REAL,
      review_count   INTEGER,
      pricing_model  TEXT,
      description    TEXT,
      category_slug  TEXT,
      category_rank  INTEGER,
      last_scraped   TEXT,
      scrape_source  TEXT
    );

    INSERT INTO categories (id, name, slug, url) VALUES
      (1, 'Email marketing', 'email-marketing', 'https://apps.shopify.com/categories/email-marketing'),
      (2, 'Reviews', 'reviews', 'https://apps.shopify.com/categories/reviews');

    INSERT INTO apps (id, name, slug, url, rating, review_count, pricing_model, category_slug, category_rank) VALUES
      (1, 'Klaviyo', 'klaviyo-email-marketing-sms', 'https://apps.shopify.com/klaviyo-email-marketing-sms', 3.8, 1890, 'freemium', 'email-marketing', 1),
      (2, 'Judge.me', 'judgeme', 'https://apps.shopify.com/judgeme', 5.0, 28000, 'freemium', 'reviews', 1),
      (3, 'No Category App', 'no-category-app', 'https://apps.shopify.com/no-category-app', 4.2, 50, 'free', 'nonexistent-category', 5);
  `);
}

// Mock better-sqlite3 — the mock factory returns a proxy to our testDb.
// vi.mock is hoisted, so it runs before any imports. The mock constructor
// delegates to testDb which is set up in beforeEach.
vi.mock("better-sqlite3", () => {
  // Use a function declaration (not arrow) so it can be called with `new`.
  function MockDatabase() {
    return {
      prepare: (sql: string) => testDb.prepare(sql),
      close: vi.fn(),
    };
  }
  return { default: MockDatabase };
});

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Dynamically import the real (unmocked) better-sqlite3.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await vi.importActual("better-sqlite3")) as any;
  RealDatabase = mod.default;
});

beforeEach(() => {
  process.env.MARKET_RESEARCH_DB_PATH = "/fake/path/shopify_apps.db";
  testDb = new RealDatabase(":memory:");
  seedTestDb(testDb);
});

afterEach(() => {
  testDb?.close();
  delete process.env.MARKET_RESEARCH_DB_PATH;
  vi.clearAllMocks();
});

// Import the service under test AFTER the mock is set up (vi.mock is hoisted).
const { enrichApp, enrichApps } = await import("../../app/services/app-enrichment.server");

// ---------------------------------------------------------------------------
// enrichApp
// ---------------------------------------------------------------------------

describe("enrichApp", () => {
  it("returns enrichment data for a known app handle", () => {
    const result = enrichApp("klaviyo-email-marketing-sms");

    expect(result).not.toBeNull();
    expect(result).toEqual({
      categorySlug: "email-marketing",
      categoryName: "Email marketing",
      rating: 3.8,
      reviewCount: 1890,
      pricingModel: "freemium",
      appStoreUrl: "https://apps.shopify.com/klaviyo-email-marketing-sms",
    });
  });

  it("returns null for an unknown app handle", () => {
    const result = enrichApp("totally-unknown-app");
    expect(result).toBeNull();
  });

  it("returns null categoryName when category slug has no match in categories table", () => {
    const result = enrichApp("no-category-app");

    expect(result).not.toBeNull();
    expect(result!.categorySlug).toBe("nonexistent-category");
    expect(result!.categoryName).toBeNull();
    expect(result!.rating).toBe(4.2);
  });

  it("returns null for empty string handle", () => {
    expect(enrichApp("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enrichApps
// ---------------------------------------------------------------------------

describe("enrichApps", () => {
  it("returns a map with matched entries for multiple handles", () => {
    const result = enrichApps(["klaviyo-email-marketing-sms", "judgeme"]);

    expect(result.size).toBe(2);
    expect(result.get("klaviyo-email-marketing-sms")).toEqual(
      expect.objectContaining({
        categorySlug: "email-marketing",
        rating: 3.8,
      }),
    );
    expect(result.get("judgeme")).toEqual(
      expect.objectContaining({
        categorySlug: "reviews",
        categoryName: "Reviews",
        rating: 5.0,
        reviewCount: 28000,
      }),
    );
  });

  it("omits handles not found in the database", () => {
    const result = enrichApps(["judgeme", "nonexistent-app"]);

    expect(result.size).toBe(1);
    expect(result.has("judgeme")).toBe(true);
    expect(result.has("nonexistent-app")).toBe(false);
  });

  it("returns an empty map for an empty input array", () => {
    const result = enrichApps([]);
    expect(result.size).toBe(0);
  });

  it("returns an empty map when no handles match", () => {
    const result = enrichApps(["unknown-1", "unknown-2"]);
    expect(result.size).toBe(0);
  });
});
