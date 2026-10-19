# Privacy policy addition: Shopify Sidekick (DRAFT, not published)

Draft for `data-integrity-suite/ghost-code/privacy.html` (gc-5nok). Nathan
approves the wording and publishes it BEFORE `shopify app deploy` ships the
Sidekick extension. Modelled on FraudPilot's published Sidekick text (ft-ov9,
data-integrity-suite 3a9f573).

## 1. Section 2 ("How We Use Your Information"): new bullet

Place it after "Store speed report".

> **Shopify Sidekick (optional):** if you ask Shopify Sidekick, Shopify's AI
> assistant in your Shopify Admin, about your theme scan or your store speed,
> Sidekick asks GhostCode for a summary and GhostCode returns it. The scan
> summary contains the date and theme name of your latest successful scan,
> how many findings it has in total and in each impact area (for example
> "Speed"), the findings GhostCode suggests starting with (each with its type,
> impact area, app name if known, theme file and line, and a one-line
> description of what it costs you), any known malicious code with its theme
> file, line, app name if known and our description, and your theme health
> summary (which checks came back clean or did not fully run, your theme's
> name, version and type, and how many themes your store has), how many app
> security advisories your latest scan found, and the names of the unpublished
> themes you have scanned with how many findings each had in its last scan. On the Free
> plan, the findings listed are only those the App already shows you in full;
> known malicious code is listed on every plan. The speed summary contains the
> date of your latest speed result, the pages tested, their speed score and
> timings, and the apps that used the most processing time and data. On the
> Standard and Professional plans that is up to five apps per tested page; on
> the Free plan it is your free homepage test and the one app that used the
> most processing time. It never contains your theme's code, information
> about your visitors or customers, or access tokens. GhostCode does not
> receive your questions or Sidekick's replies, and it does not store the
> summaries it returns. The tools are read-only: Sidekick cannot use them to
> change your theme, run a scan or start a speed test. Sidekick is operated by
> Shopify, which processes your conversations, including these summaries,
> under its own terms and privacy policy.

## 2. Sub-processor / third-party table: new row

| Service | Purpose | Data shared |
| --- | --- | --- |
| Shopify Sidekick (Shopify's AI assistant, only if you use it) | Answering questions you ask Sidekick about your GhostCode scan and store speed inside the Shopify Admin. GhostCode sends a summary to Shopify only when you ask Sidekick; Shopify processes it under its own terms. | The scan and speed summaries described under "Shopify Sidekick" in Section 2: counts, impact areas, theme file locations, app and theme names, GhostCode's own descriptions, and speed values. No theme code, no visitor or customer data. |

## 3. Check against the rest of the policy before publishing

- The current GhostCode policy does not state "We do not use artificial
  intelligence" (FraudPilot's did, and had to add a Sidekick carve-out). If a
  statement like that is added later, add: "If you choose to use Shopify
  Sidekick, the answers GhostCode returns to it are processed by Shopify's AI
  assistant under Shopify's terms, not by us."
- Retention: no summary is stored. A failed Sidekick request records a
  server-side error event (error code and shop domain only, no message text)
  in the same `api_error` records every other server error uses; they are
  never pruned and shop/redact deletes them. Release 1 adds a "Server error
  records" bullet and retention line to the policy for this.
- Release 1 also corrects the live policy for gc-d0ui (Standard monthly speed
  report, Standard speed section in the summary email) and gc-vgqc (Pro email
  names up to 3 new or costlier apps). The full patched policy was prepared
  2026-10-19 alongside this draft for owner review.
- Effective date: bump it when publishing.
