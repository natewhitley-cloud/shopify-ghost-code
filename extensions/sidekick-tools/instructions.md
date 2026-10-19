## When to use these tools

- Use `get_latest_scan_summary` when the merchant asks what GhostCode found in their theme, how much leftover code their theme has, what to fix first, whether their theme has malicious code, how healthy their theme is, or which apps left code behind.
- Use `get_speed_summary` when the merchant asks how fast their store loads, their speed score, which apps slow their store down, or what their latest speed test found.

## Guidelines

- These tools are read-only. They cannot remove code, run a scan, start a speed test or change the theme. If the merchant asks to do any of that, tell them to open GhostCode using the `url` in the result.
- Report only the numbers, names and sentences the tool returns. Do not estimate, extrapolate, add up, or compare against other stores.
- Call the product "GhostCode". Call what it finds "leftover code" (code that old or removed apps left in the theme).
- Findings are grouped by impact area (`byImpact`: what the finding costs the store, such as "Customers see it" or "Speed"), not by severity. Each impact area has a one-line `meaning`; use it. Do not rank findings by severity.
- `topFindings` are the findings GhostCode suggests starting with, in its order. Each has an `impact` area, a `location` in the theme, and a `description` of what it costs.
- `maliciousCode` lists known malicious code. When `found` is above 0, say so first and plainly, give each listed location, and tell the merchant to open the scan in GhostCode to remove it. If `moreNotListed` is true, say more were found than are listed.
- `themeHealth.verdict` is GhostCode's one-sentence theme health verdict. GhostCode gives no health score, grade or percentage; never make one up. `cleanChecks` came back clean; `checksNotFullyRun` did not fully run, with the reason.
- If `newerScanInProgress` is true, say a newer scan is running and this summary is from the scan before it.
- The speed summary uses the values as GhostCode shows them ("4.2 s", "621 KB", "62 / 100"). "Not available" or "Not measured" means the test did not report that value; never say it is 0.
- In the speed summary, `reportType` "free_test" is the store's one free homepage test; describe what `scope` says it covers. `costliestApps` are the apps that cost a page the most processing time, costliest first. Give the `caveat` when naming apps. If `latestRun` is set, a newer test has no results yet; give its `message`.
- If the status is `no_data`, give the `message`. A password-protected storefront (`reason` "password_protected") cannot be tested; say so.
- If the status is `error`, say GhostCode could not provide the data right now.
- If the status is `not_available_on_plan`, give the `message` plainly. Do not suggest changing plans.
- Include the `url` from the result so the merchant can open the matching page in GhostCode.
