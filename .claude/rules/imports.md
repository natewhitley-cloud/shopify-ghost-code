---
paths:
  - "app/**/*.{ts,tsx}"
  - "inngest/**/*.ts"
  - "tests/**/*.ts"
strength: must
---

# Import Order Convention

The pre-commit hook runs `eslint --max-warnings 0` via `lint-staged` on every staged `.ts`/`.tsx` file. The `import/order` rule is configured as `warn`, so any ordering violation blocks the commit.

## Fastest fix: let the linter order it

`import/order` is auto-fixable. Before committing, run:

```bash
npx eslint --fix <changed files>
```

This reorders imports deterministically to match the config — no manual guessing. This is the recommended workflow; the ordering below is exact enough to write correctly by hand, but the autofixer is authoritative if they ever disagree (trust `--fix`, then update this doc). Note: `tsc --noEmit` and `prettier --write` do NOT catch `import/order` — only eslint does.

## Group Order

Imports appear in this order, with a blank line between each group (config: `groups: ["builtin", "external", "internal", ["parent", "sibling", "index"]]`, `newlines-between: "always"`):

1. **builtin** — Node built-ins (`node:fs`, `node:path`, etc.)
2. **external** — npm packages (`react`, `@shopify/shopify-app-remix`, etc.)
3. **internal** — path-aliased imports starting with `~/`
4. **parent / sibling / index** — relative imports, all **one group** (no blank line between them)

## Ordering Within the Relative Group

This is what bites agents most often. The relative group (`parent` + `sibling` + `index`) is sorted with `alphabetize: { order: "asc", caseInsensitive: true }`, and the enforced result is:

- **Sibling (`./…`) sorts BEFORE parent (`../…`).** This is the counter-intuitive part — the shorter-looking `./` comes first.
- Among parents, sort alphabetically by the path after `../` — so `../../app/*` and `../../inngest/*` come before `../models/*` (`.` < `m`), and `app` < `inngest`.

## Concrete Example

```ts
// CORRECT
// builtin
import { readFile } from "node:fs";

// external (blank line before)
import { authenticate } from "@shopify/shopify-app-remix/server";
import { useLoaderData } from "react-router";

// internal ~/  (blank line before)
import { prisma } from "~/db.server";

// relative — ONE group, sibling (./) before parent (../)  (blank line before)
import { parseFindings } from "./findings";
import { getLibHelper } from "../../app/lib/helpers";
import { scanQueue } from "../../inngest/scan-theme";
import { ShopModel } from "../models/shop.server";
```

```ts
// WRONG — parent (../) placed before sibling (./); the linter wants sibling FIRST
import { ShopModel } from "../models/shop.server";
import { parseFindings } from "./findings";

// WRONG — "inngest" before "app" fails alphabetical check among parents
import { scanQueue } from "../../inngest/scan-theme";
import { getLibHelper } from "../../app/lib/helpers";

// WRONG — missing blank line between external and internal
import { authenticate } from "@shopify/shopify-app-remix/server";
import { prisma } from "~/db.server";
```

## Do This

- When in doubt, run `npx eslint --fix <file>` — it orders imports for you
- Write imports in group order (builtin → external → internal → relative) with a blank line between each group
- Within the relative group, put sibling (`./`) imports before parent (`../`) imports; sort parents alphabetically by path

## Don't Do This

- Do not place parent (`../`) imports before sibling (`./`) imports — sibling comes first
- Do not place `../../inngest/*` imports before `../../app/*` imports — `a` < `i`
- Do not mix groups without a blank line separator
- Do not add `pathGroups` to the config without team discussion — none are currently defined
