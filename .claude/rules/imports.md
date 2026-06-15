---
paths:
  - "app/**/*.{ts,tsx}"
  - "inngest/**/*.ts"
  - "tests/**/*.ts"
strength: must
---

# Import Order Convention

The pre-commit hook runs `eslint --max-warnings 0` via `lint-staged` on every staged `.ts`/`.tsx` file. The `import/order` rule is configured as `warn`, so any ordering violation blocks the commit. Fix imports before committing — not after.

## Group Order

Imports must appear in this order, with a blank line between each group:

1. **builtin** — Node built-ins (`node:fs`, `node:path`, etc.)
2. **external** — npm packages (`react`, `@shopify/shopify-app-remix`, etc.)
3. **internal** — path-aliased imports starting with `~/`
4. **parent / sibling / index** — relative imports (`../`, `./`) — all treated as one group

## Alphabetical Sorting

Within each group, imports are sorted **A–Z, case-insensitive**. This is what bites agents most often with relative imports — the full path string is compared, so directory prefix matters.

## Concrete Example

```ts
// CORRECT — builtin first
import { readFile } from "node:fs";

// external (blank line before)
import { authenticate } from "@shopify/shopify-app-remix/server";
import { useLoaderData } from "react-router";

// internal ~/  (blank line before)
import { prisma } from "~/db.server";

// parent/sibling — alphabetical by full path (blank line before)
import { getLibHelper } from "../../app/lib/helpers";   // "app" < "inngest"
import { scanQueue } from "../../inngest/scan-theme";
import { ShopModel } from "../models/shop.server";
import { parseFindings } from "./findings";
```

```ts
// WRONG — "inngest" before "app/lib" fails alphabetical check
import { scanQueue } from "../../inngest/scan-theme";
import { getLibHelper } from "../../app/lib/helpers";

// WRONG — missing blank line between external and internal
import { authenticate } from "@shopify/shopify-app-remix/server";
import { prisma } from "~/db.server";
```

## Do This

- Write imports in group order (builtin → external → internal → relative) with a blank line between each group
- Within each group, sort paths A–Z; when unsure, sort by the full import string
- When adding a relative import, place it alphabetically among the existing relative imports before committing

## Don't Do This

- Do not mix groups without a blank line separator
- Do not place `../../inngest/*` imports before `../../app/*` imports — `a` < `i`
- Do not assume the linter auto-fixes on commit; it rejects and you must reorder manually
- Do not add `pathGroups` to the config without team discussion — none are currently defined
