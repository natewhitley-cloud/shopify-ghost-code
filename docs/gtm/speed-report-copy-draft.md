# Store speed report: listing copy (DRAFT, NOT LIVE)

> **Status:** DRAFT for gc-itfc, written 2026-10-11. Nothing here is in the App Store
> listing or the Partner Dashboard yet. The feature itself is built but DARK
> (`SPEED_REPORT_LIVE_ENABLED`, gc-wt3y); do not publish any of this before it is live.
> Sits next to `listing-v2.md`; char counts are against the same Shopify field limits.

## (a) App Store

### Feature bullet (80 max), 65 chars

```
See which apps slow your store, with a weekly mobile speed report
```

If it replaces a live bullet, the candidate to drop is bullet 5 ("Track findings over time
and re-scan to confirm they're gone. First scan free"), whose "track over time" idea the
description already carries. Decide when the feature goes live.

### Description sentences (1 to 2)

```
On Professional, GhostCode tests your homepage and a product page every week with Google PageSpeed Insights and shows what each app costs: how long it keeps the page busy and how much it adds to the download. See the change from last week, or run a new test once a day.
```

## (b) Partner Dashboard: Professional plan bullet (40 max), 39 chars

```
Weekly store speed report, cost per app
```

Alternative (38): `See which apps slow your store, weekly`.

## (c) Honest limits: keep these OUT of any claim

- **Password-protected stores can't be tested.** Google can't load a storefront behind the
  password page, so these stores get no report until the password is removed. Do not say
  "every store" or imply it works during pre-launch.
- **Some apps skip loading during speed tests.** Some apps detect Google's test and don't
  load, so their real cost can be higher than reported (the page says so, gc-xewx). Do not
  claim we measure "every app" or "the full cost" of an app.
- **It is a lab test on a simulated phone, not real-user data.** Lighthouse runs a mobile
  test from Google's servers; it is not what your shoppers experienced and not Core Web
  Vitals field data. Avoid "real", "your customers' experience", "Core Web Vitals score"
  or ranking promises ("boost your Google ranking").
- **Two pages only.** The homepage and one product page (the oldest published product), not
  the whole store. Without the optional Products access, the product is picked from the
  public storefront; if that is unavailable, only the homepage is tested.
- **Scores move between runs.** We report the middle of 3 runs, but a few points of change
  week to week can be noise. Do not promise a score or a fixed improvement.
- **Professional only.** Free and Standard see a locked preview. Keep it off the Free and
  Standard cards.
