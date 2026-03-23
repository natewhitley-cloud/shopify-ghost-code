# Design: Merchant-Guided Permission Audit Flow

## Overview

The Permission Audit tab has three possible states depending on feature availability and data. This document specifies the UX copy, information hierarchy, and Polaris Web Component structure for each state.

---

## State 1: Feature-Gated (Permission Audit is OFF)

**When:** The admin-controlled feature flag for Permission Audit is disabled. This is the state at launch — shown to all merchants until we decide to flip the flag.

**Goal:** Build anticipation, signal competence, avoid making timeline promises.

**Information hierarchy:**

1. Feature name and one-sentence value prop
2. Brief context on why this matters (without being alarmist)
3. Signup for notification (optional, stretch — can omit for v1)

### Layout

```
<s-page heading="Permission Audit">
  <s-link slot="primary-action" href="/app">Back to Dashboard</s-link>

  <s-card>
    <s-stack direction="block" gap="loose">
      <s-heading>Permission Audit is Coming Soon</s-heading>
      <s-paragraph>
        Every Shopify app you install gets access to parts of your store —
        orders, customers, products, and more. Permission Audit will help
        you see exactly what each app can access and flag permissions that
        deserve a closer look.
      </s-paragraph>
      <s-paragraph>
        <s-text>
          In the meantime, you can review your app permissions manually.
          Go to <strong>Settings > Apps and sales channels</strong> in your
          Shopify admin, click any app, and review its "Store access" section.
        </s-text>
      </s-paragraph>
    </s-stack>
  </s-card>
</s-page>
```

**Notes:**

- No timeline language ("coming in Q2", "launching soon"). Just "Coming Soon" in the heading.
- No email capture in v1 — adds complexity for marginal value at current install volume.
- The manual review nudge provides immediate value even in this gated state.

---

## State 2: Onboarding (Feature ON, No App Data Yet)

**When:** Permission Audit feature flag is ON, but we either (a) don't have `read_apps` scope approved yet, or (b) the merchant just installed and we haven't fetched app data yet.

**Goal:** Educate on WHY this matters (with a real breach example), then guide the merchant through a manual review with a concrete checklist.

**Information hierarchy:**

1. Why permission auditing matters (the hook)
2. Real-world breach example (credibility + urgency)
3. Step-by-step manual review guide
4. Checklist of high-risk permissions to look for

### Layout

```
<s-page heading="Permission Audit">
  <s-link slot="primary-action" href="/app">Back to Dashboard</s-link>

  <!-- WHY THIS MATTERS -->
  <s-banner tone="warning">
    Every app you install gets API access to your store. If an app is
    compromised or its data is leaked, those permissions become attack
    vectors. Most merchants never review what access they've granted.
  </s-banner>

  <!-- REAL-WORLD CONTEXT -->
  <s-card>
    <s-stack direction="block" gap="base">
      <s-heading>Why This Matters: A Real Example</s-heading>
      <s-paragraph>
        In 2024, a popular chargeback management app (Disputifier) suffered
        an API credential leak. Because the app had <strong>write access to
        orders</strong>, attackers were able to issue unauthorized refunds —
        some merchants reported losses exceeding $12,000 before the breach
        was contained.
      </s-paragraph>
      <s-paragraph>
        The root issue wasn't the breach itself — breaches happen. The issue
        was that merchants had no visibility into what permissions the app
        held, and no habit of reviewing them.
      </s-paragraph>
    </s-stack>
  </s-card>

  <!-- MANUAL REVIEW GUIDE -->
  <s-card>
    <s-stack direction="block" gap="base">
      <s-heading>Review Your App Permissions Now</s-heading>
      <s-paragraph>
        While we work on automating this audit, you can review your app
        permissions manually in under 5 minutes:
      </s-paragraph>
      <s-ordered-list>
        <s-list-item>
          In your Shopify admin, go to <strong>Settings > Apps and sales
          channels</strong>
        </s-list-item>
        <s-list-item>
          Click on each installed app and expand the <strong>"Store
          access"</strong> section
        </s-list-item>
        <s-list-item>
          Look for the permissions listed below — these deserve the most
          scrutiny
        </s-list-item>
        <s-list-item>
          For any app you no longer use, uninstall it. Unused apps with
          active permissions are unnecessary risk.
        </s-list-item>
      </s-ordered-list>
    </s-stack>
  </s-card>

  <!-- HIGH-RISK PERMISSIONS CHECKLIST -->
  <s-card>
    <s-stack direction="block" gap="base">
      <s-heading>Permissions That Deserve Scrutiny</s-heading>
      <s-paragraph>
        Not all permissions are equal. These carry the most risk if an app
        is compromised:
      </s-paragraph>

      <s-data-table>
        <table>
          <thead>
            <tr>
              <th>Permission</th>
              <th>Risk Level</th>
              <th>What It Means</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>write_orders</code></td>
              <td><s-badge tone="critical">Critical</s-badge></td>
              <td>Can create, edit, or refund orders — direct financial risk</td>
            </tr>
            <tr>
              <td><code>write_customers</code></td>
              <td><s-badge tone="critical">Critical</s-badge></td>
              <td>Can modify or export customer PII — privacy and compliance risk</td>
            </tr>
            <tr>
              <td><code>read_all_orders</code></td>
              <td><s-badge tone="critical">Critical</s-badge></td>
              <td>Access to full order history, not just last 60 days</td>
            </tr>
            <tr>
              <td><code>write_products</code></td>
              <td><s-badge tone="warning">High</s-badge></td>
              <td>Can modify product listings, prices, and inventory</td>
            </tr>
            <tr>
              <td><code>write_themes</code></td>
              <td><s-badge tone="warning">High</s-badge></td>
              <td>Can inject code into your storefront theme</td>
            </tr>
            <tr>
              <td><code>read_analytics</code></td>
              <td><s-badge tone="info">Low</s-badge></td>
              <td>Read-only access to store analytics — limited risk</td>
            </tr>
          </tbody>
        </table>
      </s-data-table>

      <s-paragraph>
        <s-text>
          Ask yourself: does this app actually need this permission for
          what it does? A reviews app shouldn't need
          <code>write_orders</code>. A shipping app shouldn't need
          <code>write_customers</code>.
        </s-text>
      </s-paragraph>
    </s-stack>
  </s-card>
</s-page>
```

**Notes:**

- The warning banner at the top sets urgency without being alarmist. Tone is "this is worth your time" not "you're in danger."
- The Disputifier example is real and specific — this builds trust. We name the app and the dollar amount, both publicly reported.
- The checklist is ordered by risk, critical first. The table uses the same `<s-badge tone="...">` pattern the app already uses for scan severity.
- The manual steps are deliberately simple — 4 steps, under 5 minutes. We want the merchant to actually do this, not bookmark it.
- "While we work on automating this audit" is honest framing that sets expectations without committing to a date.

---

## State 3: Active Audit (Feature ON, App Data Available)

**When:** Permission Audit is ON and we have `read_apps` data (either from the scope or a future manual input mechanism). This is the "full experience" state.

**Goal:** Show the automated audit results alongside education that helps merchants interpret what they're seeing.

**Information hierarchy:**

1. Audit summary (apps scanned, issues found)
2. App-by-app permission breakdown with risk ratings
3. Educational context (granted vs. used scopes, sensitivity explainer)
4. Link to Shopify docs

### Layout

```
<s-page heading="Permission Audit">
  <s-link slot="primary-action" href="/app">Back to Dashboard</s-link>

  <!-- AUDIT SUMMARY -->
  <s-card>
    <s-stack direction="block" gap="base">
      <s-heading>Audit Summary</s-heading>
      <s-stack direction="inline" gap="base">
        <s-badge tone="critical">{criticalCount} Critical</s-badge>
        <s-badge tone="warning">{highCount} High</s-badge>
        <s-badge tone="info">{lowCount} Low Risk</s-badge>
      </s-stack>
      <s-paragraph>
        {totalApps} apps scanned. {issueCount} permissions flagged for
        review.
      </s-paragraph>
    </s-stack>
  </s-card>

  <!-- TRANSPARENCY NOTE -->
  <s-banner tone="info">
    <s-stack direction="block" gap="base">
      <s-text>
        <strong>What you're seeing:</strong> Ghost Code shows the
        permissions each app has been <em>granted</em> — what they
        <em>can</em> access. We cannot determine what an app actually
        reads or writes. A permission flagged here doesn't mean the app
        is misusing it — it means the access exists and is worth knowing
        about.
      </s-text>
    </s-stack>
  </s-banner>

  <!-- APP-BY-APP RESULTS (repeated per app) -->
  <s-card>
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="base">
        <s-heading>{appName}</s-heading>
        <s-badge tone={worstScopeTone}>{worstScopeLabel}</s-badge>
      </s-stack>
      <s-data-table>
        <table>
          <thead>
            <tr>
              <th>Permission</th>
              <th>Sensitivity</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <!-- One row per granted scope -->
            <tr>
              <td><code>{scopeName}</code></td>
              <td><s-badge tone={sensitivityTone}>{sensitivityLabel}</s-badge></td>
              <td>{humanDescription}</td>
            </tr>
          </tbody>
        </table>
      </s-data-table>
    </s-stack>
  </s-card>

  <!-- EDUCATION FOOTER -->
  <s-card>
    <s-stack direction="block" gap="base">
      <s-heading>Understanding Permission Levels</s-heading>
      <s-unordered-list>
        <s-list-item>
          <strong>Critical:</strong> Permissions that allow financial
          transactions or access to full customer data
          (<code>write_orders</code>, <code>write_customers</code>,
          <code>read_all_orders</code>)
        </s-list-item>
        <s-list-item>
          <strong>High:</strong> Permissions that allow modification of
          store content or theme code
          (<code>write_products</code>, <code>write_themes</code>)
        </s-list-item>
        <s-list-item>
          <strong>Low:</strong> Read-only permissions with limited blast
          radius (<code>read_analytics</code>,
          <code>read_products</code>)
        </s-list-item>
      </s-unordered-list>
      <s-paragraph>
        <s-text>
          For more details, see
          <a href="https://shopify.dev/docs/api/usage/access-scopes"
             target="_blank" rel="noopener">
            Shopify's access scopes documentation
          </a>.
        </s-text>
      </s-paragraph>
    </s-stack>
  </s-card>
</s-page>
```

**Notes:**

- The transparency banner is critical. We must not imply that a "critical" permission means the app is doing something wrong. "Granted" vs. "used" is the most important conceptual distinction for merchants to understand.
- Apps are listed one card per app, sorted by worst permission severity (critical apps first). This matches the scan findings pattern where highest-severity items surface first.
- The education footer uses the same severity language as the scan detail view (`critical`, `warning`, `info` tones) for consistency.
- External link to Shopify docs opens in a new tab — standard for embedded apps linking outside the admin.

---

## Component Pattern Summary

| Pattern               | Polaris Web Component                             | Existing Precedent                                          |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------------- | ----------- | ------------------------------------ |
| Page container        | `<s-page heading="...">`                          | All routes                                                  |
| Navigation back       | `<s-link slot="primary-action" href="/app">`      | Settings, scan detail                                       |
| Content sections      | `<s-card>` with `<s-stack direction="block">`     | Dashboard, settings                                         |
| Severity/risk badges  | `<s-badge tone="critical                          | warning                                                     | info">`     | Scan detail findings                 |
| Alert/context banners | `<s-banner tone="warning                          | info                                                        | critical">` | Dashboard nudges, scan detail errors |
| Data tables           | `<s-data-table>` wrapping `<table>`               | Scan detail findings table                                  |
| Ordered steps         | `<s-ordered-list>` with `<s-list-item>`           | (new, but consistent with `<s-unordered-list>` in settings) |
| Feature lists         | `<s-unordered-list>` with `<s-list-item>`         | Settings plan features                                      |
| Inline code           | `<code>` tags inside `<s-text>` / `<s-paragraph>` | Scan detail file/snippet display                            |

---

## State Determination Logic (Loader)

The route loader needs to resolve which state to render. Pseudocode:

```
1. Check feature flag → if OFF, return { state: "feature-gated" }
2. Check if app permission data exists for this shop → if NO, return { state: "onboarding" }
3. Load app permission data → return { state: "active", apps: [...] }
```

The feature flag is an admin-controlled value (database row or env var), not a per-merchant toggle. When we flip it ON, all merchants transition from state 1 to state 2 (or state 3 if data exists).

---

## Tone Guide

The existing app copy is:

- **Direct and concise** — short paragraphs, no filler language
- **Empowering, not alarming** — "flags everything that can be safely removed" not "your store is at risk"
- **Technical but accessible** — uses terms like "scripts" and "snippets" without over-explaining
- **Action-oriented** — every card has a clear next step

The Permission Audit copy should match this tone. The Disputifier example is the one place we lean into urgency, and even there we frame it as "here's what happened, here's what you can do about it" rather than fear-mongering.

---

## Open Questions

1. **`<s-ordered-list>` availability:** The existing codebase uses `<s-unordered-list>` but not `<s-ordered-list>`. Need to verify this component exists in the Polaris Web Components CDN. Fallback: use numbered text within `<s-unordered-list>` items.

2. **External links in embedded apps:** The Shopify docs link uses `target="_blank"`. Verify this works correctly within App Bridge's iframe context — some embedded app frameworks intercept link clicks. May need `shopify.navigation.redirect.remote()` instead.

3. **"Settings > Apps" deep link:** Ideally we'd link directly to the merchant's app permissions page rather than giving text instructions. The URL pattern is `https://{shop}.myshopify.com/admin/settings/apps`. Investigate whether App Bridge supports navigating to admin settings pages via `shopify.navigation.redirect.admin()`.
