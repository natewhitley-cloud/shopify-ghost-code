# Design: Missing AppInstallation Fields

**Task**: GC-zse.7
**Date**: 2026-03-21
**Status**: Draft

## Problem

Shopify's `AppInstallation` GraphQL object lacks three fields merchants would expect in a permission audit: installation date, last API call timestamp, and active/inactive status. This document decides how Ghost Code handles each gap.

---

## Decision 1: Installation Date

**What Shopify provides:** Nothing.

**Decision:** Track install dates going forward via the `app/installed` and `app/uninstalled` webhooks that other apps fire. However, Ghost Code only receives webhooks for _its own_ installs — it cannot receive webhooks when _other_ apps are installed on the merchant's store. Therefore, the only viable approach is to record a `firstSeenAt` timestamp when Ghost Code first discovers an app via the `AppInstallation` API query.

**Model field:**

```
firstSeenAt  DateTime  @default(now())  // when Ghost Code first saw this app installed
```

**UX approach:**

- Do NOT label this as "Installed on" — that would be dishonest.
- Display: "First seen [date]" with a tooltip: "The date Ghost Code first detected this app on your store. The actual install date may be earlier."
- For apps discovered on the merchant's first Permission Audit run, all will share the same `firstSeenAt`. This is expected and honest.

**What we don't show:** We never display or infer an install date. We don't say "installed X months ago" because we don't know that.

---

## Decision 2: Activity Signal

**What Shopify provides:** No `lastApiCall` or usage data. We get `activeSubscriptions` (billing status) and `accessScopes` (granted permissions).

**Decision:** Do not claim to know whether an app is "active" or "inactive." Instead, offer two factual proxy signals where available:

1. **Subscription status** — derived from `activeSubscriptions`. Display as:
   - "Has active subscription" (app has a paid plan)
   - "No active subscription" (free app or expired/cancelled subscription)
   - This is factual, not a judgment. Some free apps are legitimately active.

2. **Ghost code cross-reference** — if Ghost Code's existing scan findings attribute orphaned code to an app name (`Finding.appName`), and that app is still installed, surface this: "This app is installed AND has ghost code findings — it may have been partially uninstalled or updated." This is a unique insight only Ghost Code can provide.

**Model fields:**

```
hasActiveSubscription  Boolean?   // null = unknown/not yet fetched
subscriptionPlanName   String?    // e.g. "Pro Plan" if available
```

No `isActive` boolean. No `lastActivityAt`. We don't model what we can't know.

**What we don't show:** No "Last active" timestamp. No "Active/Inactive" badge. No "dormant app" warnings. These would be misleading claims based on data we don't have.

---

## Decision 3: Status Display

**What Shopify provides:** The app is in the `AppInstallation` query results (installed) or it isn't (uninstalled). Binary.

**Decision:** Model a simple lifecycle status based solely on what we can observe:

```
enum AppPresence {
  INSTALLED    // currently returned by AppInstallation API
  REMOVED      // was in a previous audit but absent from latest
}
```

**Model field:**

```
presence     AppPresence  @default(INSTALLED)
lastSeenAt   DateTime     @default(now())  // updated each time the audit runs and finds the app still installed
```

When a Permission Audit runs, any previously-tracked app not found in the current `AppInstallation` results gets marked `REMOVED` with its `lastSeenAt` unchanged (preserving when we last confirmed it was present).

**UX approach:**

- Installed apps: show normally.
- Removed apps: show in a separate "Previously installed" section with: "Last confirmed installed on [lastSeenAt]. This app is no longer on your store but may have left behind code or settings."
- This naturally connects to Ghost Code's core value prop: linking removed apps to orphaned code findings.

---

## Recommended Prisma Model Fields

These fields should be added to the `InstalledApp` model (to be created in GC-zse.12):

```prisma
model InstalledApp {
  id                     String       @id @default(cuid())
  shopId                 String
  shop                   Shop         @relation(fields: [shopId], references: [id], onDelete: Cascade)

  // Shopify-provided identifiers
  shopifyAppId           String       // from AppInstallation.app.id
  appTitle               String       // from app.title
  appHandle              String?      // from app.handle (nullable: some apps lack handles)

  // Ghost Code tracking (not from Shopify)
  firstSeenAt            DateTime     @default(now())
  lastSeenAt             DateTime     @default(now())
  presence               AppPresence  @default(INSTALLED)

  // Subscription signal (factual proxy, not activity claim)
  hasActiveSubscription  Boolean?     // null = not yet fetched
  subscriptionPlanName   String?

  // Permission snapshots live in a separate model (GC-zse.12)

  @@unique([shopId, shopifyAppId])
  @@index([shopId, presence])
}

enum AppPresence {
  INSTALLED
  REMOVED
}
```

---

## UX Copy Recommendations

### What we say

| Data point                      | Label        | Copy                                                                          |
| ------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| `firstSeenAt`                   | "First seen" | "Mar 21, 2026" with tooltip "Date Ghost Code first detected this app"         |
| `presence` = INSTALLED          | Badge        | "Installed" (neutral tone)                                                    |
| `presence` = REMOVED            | Badge        | "Removed"                                                                     |
| `hasActiveSubscription` = true  | Subscription | "Active subscription: [planName]"                                             |
| `hasActiveSubscription` = false | Subscription | "No active subscription"                                                      |
| `hasActiveSubscription` = null  | Subscription | Omit entirely (don't show "Unknown")                                          |
| Cross-ref with findings         | Inline note  | "Ghost Code found orphaned code attributed to this app" with link to findings |

### What we never say

| Tempting claim                         | Why we omit it                                         |
| -------------------------------------- | ------------------------------------------------------ |
| "Installed on [date]"                  | We don't know the actual install date                  |
| "Last active [date]"                   | No API call tracking exists                            |
| "Inactive app" / "Dormant"             | We can't determine app activity                        |
| "This app is unused"                   | Subscription status is not a reliable usage signal     |
| "Risk: app hasn't been used in X days" | Fabricating risk signals from absent data erodes trust |

### Overall positioning

The Permission Audit header copy should set expectations:

> "Permission Audit shows what each installed app **can access** on your store. It reports granted permissions, not actual usage — Shopify does not expose app activity data to other apps."

This one sentence preempts the most common merchant question ("is this app actually using these permissions?") and positions Ghost Code as honest rather than hand-wavy.

---

## Downstream Impact

- **GC-zse.12 (Prisma models)**: Use the field definitions above as the starting point for the `InstalledApp` model.
- **GC-zse.14 (risk scoring)**: Risk algorithm should NOT factor in "inactivity" since we can't measure it. Stick to scope count, sensitivity tiers, and category mismatch.
- **GC-zse.13 (permission-fetcher)**: Service must update `lastSeenAt` on every audit run and flip `presence` to `REMOVED` for apps that disappear.
- **GC-zse.16 (detail view)**: App detail page uses "First seen" / subscription / cross-ref copy from the table above.
