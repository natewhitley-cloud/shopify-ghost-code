/**
 * Advisory precision over REAL public theme settings (gc-q5z8, flag-on bar).
 *
 * Dev-store installs are impossible for these apps (Hulk Product Options,
 * Swym Wishlist Plus, Selleasy and 17TRACK are delisted), so the verification bar for
 * turning the advisory on is: each embed handle is seen in several unrelated
 * public `config/settings_data.json` files, and the detector is precise over
 * those real files. The fixtures in tests/fixtures/advisory-embeds/ are the
 * app embed block entries of twelve public themes (three per entry), copied verbatim (types, ids,
 * disabled flags) with each file's source URL in its header comment.
 *
 * Each fixture must fire ONLY its own entry, once; the sibling embeds in the
 * same files (Swym's wishlist-collections-embed, Logbase's DealEasy
 * `app-embed`, HulkApps' Hulk Discounts and Hulk Form Builder `app-embed`,
 * Klaviyo, Judge.me...)
 * fire nothing; and a disabled embed never fires (none of the real Hulk, Swym,
 * Selleasy entries is disabled, so each is also run with its own entry
 * flipped to disabled; a control flips it back and it fires again).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FindingType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import {
  advisoryDescription,
  APP_INCIDENT_ADVISORIES,
} from "../../app/data/app-incident-advisories.server";
import { detectAppIncidentAdvisories } from "../../app/services/scan-engine.server";

const DIR = join(__dirname, "../fixtures/advisory-embeds");
const SETTINGS = "config/settings_data.json";
const ACTIVE = new Date("2026-10-20T12:00:00Z");

const entry = (name: string) => APP_INCIDENT_ADVISORIES.find((a) => a.appName === name)!;
const SWYM = entry("Swym Wishlist Plus");
const SELLEASY = entry("Selleasy");
const HULK = entry("Hulk Product Options");
const TRACK17 = entry("17TRACK");
const EXPECTED: Record<string, string> = {
  hulk: advisoryDescription({ advisory: HULK, embedHandle: HULK.embedHandles[0] }),
  swym: advisoryDescription({ advisory: SWYM, embedHandle: SWYM.embedHandles[0] }),
  selleasy: advisoryDescription({ advisory: SELLEASY, embedHandle: SELLEASY.embedHandles[0] }),
  "17track": advisoryDescription({ advisory: TRACK17, embedHandle: TRACK17.embedHandles[0] }),
};
const OWN_HANDLE: Record<string, string> = {
  hulk: HULK.embedHandles[0],
  swym: SWYM.embedHandles[0],
  selleasy: SELLEASY.embedHandles[0],
  "17track": TRACK17.embedHandles[0],
};

type Block = { type: string; disabled: boolean };
type Fixture = {
  name: string;
  app: string;
  content: string;
  header: string;
  blocks: Record<string, Block>;
};

const FIXTURES: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((name) => {
    const content = readFileSync(join(DIR, name), "utf8");
    const header = content.slice(0, content.indexOf("*/") + 2);
    const json = JSON.parse(content.slice(header.length)) as {
      current: { blocks: Record<string, Block> };
    };
    return { name, app: name.split("--")[0], content, header, blocks: json.current.blocks };
  });

const detect = (content: string) =>
  detectAppIncidentAdvisories([{ filename: SETTINGS, content }], ACTIVE);

/** The fixture with its own entry's disabled flag set to `disabled` (everything else verbatim). */
function withOwnDisabled(f: Fixture, disabled: boolean): string {
  const blocks = Object.fromEntries(
    Object.entries(f.blocks).map(([id, b]) => [
      id,
      b.type.startsWith(`${OWN_HANDLE[f.app]}/`) ? { ...b, disabled } : b,
    ]),
  );
  return `${f.header}\n${JSON.stringify({ current: { blocks } }, null, 2)}`;
}

describe("advisory precision over real public settings_data.json fixtures", () => {
  it("has three unrelated public themes for each embed entry, each citing its source", () => {
    expect(FIXTURES.filter((f) => f.app === "hulk")).toHaveLength(3);
    expect(FIXTURES.filter((f) => f.app === "swym")).toHaveLength(3);
    expect(FIXTURES.filter((f) => f.app === "selleasy")).toHaveLength(3);
    expect(FIXTURES.filter((f) => f.app === "17track")).toHaveLength(3);
    for (const f of FIXTURES) {
      expect(f.header, f.name).toMatch(
        /Source: https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/[^/\s]+\/config\/settings_data\.json/,
      );
      expect(f.header, f.name).toMatch(/fetched 2026-10-\d{2}\./);
      // Each holds its own app's real embed entry, verbatim.
      expect(
        Object.values(f.blocks).some((b) => b.type.startsWith(`${OWN_HANDLE[f.app]}/`)),
        f.name,
      ).toBe(true);
    }
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    "%s fires exactly its own entry, once, on the embed signal",
    (_name, f) => {
      const findings = detect(f.content);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        findingType: FindingType.APP_INCIDENT_ADVISORY,
        filename: SETTINGS,
        lineNumber: 1,
        description: EXPECTED[f.app],
      });
    },
  );

  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    "%s with its own entry DISABLED fires nothing (siblings and other apps never fire)",
    (_name, f) => {
      expect(detect(withOwnDisabled(f, true))).toEqual([]);
      // Control: the same edit with disabled false fires again.
      expect(detect(withOwnDisabled(f, false))).toHaveLength(1);
    },
  );

  it("the real sibling and look-alike embeds in these files fire nothing on their own", () => {
    const siblings = FIXTURES.flatMap((f) =>
      Object.entries(f.blocks).filter(([, b]) => !b.type.startsWith(`${OWN_HANDLE[f.app]}/`)),
    );
    const types = siblings.map(([, b]) => b.type.split("/").slice(0, 6).join("/"));
    // Non-vacuous: the files really hold the near misses that matter.
    expect(types).toEqual(
      expect.arrayContaining([
        "shopify://apps/wishlist-plus/blocks/wishlist-collections-embed",
        "shopify://apps/dealeasy/blocks/app-embed",
        "shopify://apps/hulk-discounts/blocks/app-embed",
        "shopify://apps/hulk-form-builder/blocks/app-embed",
      ]),
    );
    const content = JSON.stringify({ current: { blocks: Object.fromEntries(siblings) } });
    expect(detect(content)).toEqual([]);
  });

  it("all twelve files together (the union of their blocks) fire one finding per entry", () => {
    const blocks = Object.assign({}, ...FIXTURES.map((f) => f.blocks));
    const findings = detect(JSON.stringify({ current: { blocks } }));
    expect(findings.map((f) => f.description).sort()).toEqual(
      [EXPECTED.hulk, EXPECTED.selleasy, EXPECTED.swym, EXPECTED["17track"]].sort(),
    );
  });
});
