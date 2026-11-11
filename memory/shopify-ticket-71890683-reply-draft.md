# DRAFT: reply to Shopify ticket 71890683 (write_themes exemption)

Status: DRAFT for Nathan to review, edit and send. Not sent.
Attach: the screenshots listed below. Nathan captures the 4 admin screenshots (4-7).

---

Hi Cy,

Thanks for the quick reply. Here are screenshots of the feature that needs write_themes, running on our development store (nw-dev-store-2).

**What the feature does**

GhostCode scans a store's live theme for code left behind by apps the merchant has uninstalled. The new feature, Clean copy, removes that leftover code safely:

1. The merchant picks the leftover code to remove and confirms they've uninstalled each app.
2. GhostCode duplicates the live theme into a new unpublished copy (`themeDuplicate`).
3. GhostCode removes only the selected code from the copy (`themeFilesUpsert`), then reads each file back to confirm the change.
4. The merchant previews the copy and publishes it themselves from Online Store > Themes.

GhostCode never edits or publishes the live theme. Before every write, the app checks that the target is an unpublished theme other than the one it copied from, and only Liquid files in layout/, sections/, snippets/, templates/ and blocks/ can be written. These two mutations are the only uses of write_themes.

**Screenshots**

1. GhostCode scan results on the live theme, showing the leftover code it found
2. Clean copy: selecting the code to remove (1-select-1280.png)
3. Clean copy: the result, 13 of 13 pieces removed from the copy (2-result-1280.png)
4. Shopify admin, theme library: the live theme unchanged, the new unpublished copy "test-data - clean copy pa4zrdal"
5. Shopify admin: preview of the copy
6. Shopify admin, code editor on the copy: the removed lines are gone
7. Shopify admin, code editor on the live theme: the same lines are still there

**A note on how this was recorded**

Our app can't call `themeDuplicate` or `themeFilesUpsert` until write_themes is approved. For this recording, the copy and file writes ran through a development harness that uses the Shopify CLI signed in as store staff on the development store. Everything else is the production code: the scan, the selection, the safety checks, the removal and the read-back. In production, the app makes exactly those two calls with write_themes, and nothing else changes.

Happy to record a screencast or answer anything else.

Thanks,
Nathan

---

## Notes for Nathan (not part of the email)
- Screenshot 1: a prod GhostCode scan page, or the harness scan page (your call). Shots 2-3 are in `~/shopify/gc-preview-harness/cleancopy/png/`.
- For screenshots 6-7, good lines to show: `layout/theme.liquid` lines 33-40 (Klaviyo, Judge.me, Hotjar tags).
- On the select page, the button reads "Allow theme changes" because the app doesn't have write_themes yet. That's accurate today, and it shows the scope request.
- Allowed-paths sentence verified against `ALLOWED_FIX_PATH` (clean-copy-admin.server.ts:42).
- Copy theme id 153007784113; run cmwbjlsa70017uy1vpa4zrdal (local demo DB).
