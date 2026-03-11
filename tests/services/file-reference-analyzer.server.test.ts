/**
 * Tests for app/services/file-reference-analyzer.server.ts
 *
 * analyzeFileReferences is a pure function — no mocks needed.
 * Tests cover:
 *   - Empty input
 *   - Referenced snippets (not orphans)
 *   - Unreferenced snippets (orphans)
 *   - Transitive references (snippet referenced by another snippet)
 *   - Variable-based render calls (cannot be resolved — snippet should be treated as orphan)
 *   - Non-liquid files ignored for snippet detection
 *   - Single and double quote render/include tag variants
 *   - Alphabetical sort of orphan output
 *   - Files outside snippets/ directory are never treated as orphan candidates
 */

import { describe, it, expect } from "vitest";
import {
  analyzeFileReferences,
  type OrphanFile,
} from "../../app/services/file-reference-analyzer.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function file(key: string, value: string) {
  return { key, value };
}

function orphanFilenames(orphans: OrphanFile[]): string[] {
  return orphans.map((o) => o.filename);
}

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe("analyzeFileReferences — empty input", () => {
  it("returns empty array when no files are provided", () => {
    expect(analyzeFileReferences([])).toEqual([]);
  });

  it("returns empty array when there are only non-snippet files", () => {
    const files = [
      file("layout/theme.liquid", "<html>{{ content_for_layout }}</html>"),
      file("sections/header.liquid", "<header>{{ shop.name }}</header>"),
      file("assets/styles.css", "body { margin: 0; }"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("returns empty array when there are no liquid files at all", () => {
    const files = [
      file("assets/theme.js", "console.log('hello');"),
      file("config/settings_data.json", "{}"),
      file("locales/en.default.json", "{}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Snippet referenced by templates — not orphan
// ---------------------------------------------------------------------------

describe("analyzeFileReferences — referenced snippets (not orphans)", () => {
  it("does not flag a snippet referenced with double-quote render tag", () => {
    const files = [
      file("snippets/product-form.liquid", "<form>...</form>"),
      file("sections/product.liquid", '{% render "product-form" %}'),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("does not flag a snippet referenced with single-quote render tag", () => {
    const files = [
      file("snippets/product-form.liquid", "<form>...</form>"),
      file("sections/product.liquid", "{% render 'product-form' %}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("does not flag a snippet referenced with include tag (legacy Liquid)", () => {
    const files = [
      file("snippets/legacy-widget.liquid", "<div>widget</div>"),
      file("layout/theme.liquid", "{% include 'legacy-widget' %}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("does not flag a snippet referenced with whitespace-stripping render tag (dash variant)", () => {
    const files = [
      file("snippets/dash-widget.liquid", "<span>x</span>"),
      file("sections/header.liquid", "{%- render 'dash-widget' -%}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("does not flag a snippet referenced from a template file", () => {
    const files = [
      file("snippets/cart-form.liquid", "<form>cart</form>"),
      file("templates/cart.liquid", "{% render 'cart-form' %}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("does not flag a snippet referenced from a layout file", () => {
    const files = [
      file("snippets/footer.liquid", "<footer>...</footer>"),
      file("layout/theme.liquid", "{% render 'footer' %}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("does not flag a snippet referenced multiple times across different files", () => {
    const files = [
      file("snippets/shared.liquid", "<div>shared</div>"),
      file("sections/header.liquid", "{% render 'shared' %}"),
      file("sections/footer.liquid", "{% render 'shared' %}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unreferenced snippets — orphans
// ---------------------------------------------------------------------------

describe("analyzeFileReferences — unreferenced snippets (orphans)", () => {
  it("flags a snippet that is never referenced", () => {
    const files = [
      file("snippets/ghost-widget.liquid", "<div>ghost</div>"),
      file("layout/theme.liquid", "{{ content_for_layout }}"),
    ];
    const orphans = analyzeFileReferences(files);

    expect(orphans).toHaveLength(1);
    expect(orphans[0].filename).toBe("snippets/ghost-widget.liquid");
    expect(orphans[0].reason).toContain("ghost-widget");
  });

  it("flags multiple unreferenced snippets", () => {
    const files = [
      file("snippets/orphan-a.liquid", "<div>a</div>"),
      file("snippets/orphan-b.liquid", "<div>b</div>"),
      file("layout/theme.liquid", "{{ content_for_layout }}"),
    ];
    const orphans = analyzeFileReferences(files);

    expect(orphans).toHaveLength(2);
    expect(orphanFilenames(orphans)).toContain("snippets/orphan-a.liquid");
    expect(orphanFilenames(orphans)).toContain("snippets/orphan-b.liquid");
  });

  it("includes the snippet base name in the reason message", () => {
    const files = [
      file("snippets/old-app-widget.liquid", "<div>old</div>"),
    ];
    const orphans = analyzeFileReferences(files);

    expect(orphans[0].reason).toContain("old-app-widget");
    expect(orphans[0].reason).toContain("never referenced");
  });

  it("flags an orphan snippet even when other snippets are referenced", () => {
    const files = [
      file("snippets/referenced.liquid", "<div>used</div>"),
      file("snippets/unreferenced.liquid", "<div>unused</div>"),
      file("sections/header.liquid", "{% render 'referenced' %}"),
    ];
    const orphans = analyzeFileReferences(files);

    expect(orphans).toHaveLength(1);
    expect(orphans[0].filename).toBe("snippets/unreferenced.liquid");
  });
});

// ---------------------------------------------------------------------------
// Transitive references — snippet rendered by another snippet
// ---------------------------------------------------------------------------

describe("analyzeFileReferences — transitive snippet references", () => {
  it("does not flag a snippet that is only rendered by another snippet", () => {
    // snippets/inner.liquid is never referenced by templates/sections/layout —
    // only by snippets/outer.liquid. The analyzer scans snippet files too,
    // so inner should NOT be an orphan.
    const files = [
      file("snippets/outer.liquid", "{% render 'inner' %} outer content"),
      file("snippets/inner.liquid", "<span>inner</span>"),
      file("sections/header.liquid", "{% render 'outer' %}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("flags a snippet only when it has no referencing file anywhere (including other snippets)", () => {
    const files = [
      file("snippets/deep-orphan.liquid", "<span>deep</span>"),
      file("snippets/outer.liquid", "{% render 'some-other-snippet' %}"),
      file("sections/header.liquid", "{% render 'outer' %}"),
    ];
    const orphans = analyzeFileReferences(files);

    // deep-orphan is never rendered by anything.
    expect(orphanFilenames(orphans)).toContain("snippets/deep-orphan.liquid");
    // some-other-snippet isn't in the file list, so no orphan entry for it.
    // outer is referenced by header.liquid.
    expect(orphanFilenames(orphans)).not.toContain("snippets/outer.liquid");
  });
});

// ---------------------------------------------------------------------------
// Variable-based render calls (unresolvable at static analysis time)
// ---------------------------------------------------------------------------

describe("analyzeFileReferences — variable-based render calls", () => {
  it("treats a snippet as orphan when only referenced via a variable render call", () => {
    // {% render variable %} cannot be resolved statically — the snippet name
    // is unknown, so the snippet remains an orphan from the analyzer's view.
    const files = [
      file("snippets/dynamic.liquid", "<div>dynamic</div>"),
      file(
        "sections/header.liquid",
        "{% assign widget = 'dynamic' %}{% render widget %}",
      ),
    ];
    const orphans = analyzeFileReferences(files);

    // The variable-based call is correctly skipped; the snippet has no static reference.
    expect(orphanFilenames(orphans)).toContain("snippets/dynamic.liquid");
  });
});

// ---------------------------------------------------------------------------
// Non-liquid snippet files are ignored
// ---------------------------------------------------------------------------

describe("analyzeFileReferences — non-liquid files in snippets/", () => {
  it("ignores non-liquid files in the snippets/ directory", () => {
    // Only .liquid files in snippets/ are orphan candidates.
    const files = [
      file("snippets/widget.js", "console.log('widget');"),
      file("snippets/styles.css", ".widget { color: red; }"),
      file("layout/theme.liquid", "{{ content_for_layout }}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Files outside snippets/ are never orphan candidates
// ---------------------------------------------------------------------------

describe("analyzeFileReferences — only snippets/ files are candidates", () => {
  it("does not flag unreferenced sections as orphans", () => {
    const files = [
      file("sections/unused-section.liquid", "<section>unused</section>"),
      file("layout/theme.liquid", "{{ content_for_layout }}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("does not flag unreferenced layout files as orphans", () => {
    const files = [
      file("layout/password.liquid", "<html>password page</html>"),
      file("layout/theme.liquid", "{{ content_for_layout }}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Alphabetical sort of output
// ---------------------------------------------------------------------------

describe("analyzeFileReferences — output sorting", () => {
  it("sorts orphan files alphabetically by filename", () => {
    const files = [
      file("snippets/z-widget.liquid", "<div>z</div>"),
      file("snippets/a-widget.liquid", "<div>a</div>"),
      file("snippets/m-widget.liquid", "<div>m</div>"),
      file("layout/theme.liquid", "{{ content_for_layout }}"),
    ];
    const orphans = analyzeFileReferences(files);

    expect(orphanFilenames(orphans)).toEqual([
      "snippets/a-widget.liquid",
      "snippets/m-widget.liquid",
      "snippets/z-widget.liquid",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases with snippet naming
// ---------------------------------------------------------------------------

describe("analyzeFileReferences — snippet naming edge cases", () => {
  it("strips snippets/ prefix and .liquid extension when matching render tag names", () => {
    // render tag uses bare name: 'product-card', file key is 'snippets/product-card.liquid'
    const files = [
      file("snippets/product-card.liquid", "<div>card</div>"),
      file("sections/collection.liquid", "{% render 'product-card' %}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("handles snippet files that already lack the .liquid extension in the key", () => {
    // Unlikely in practice, but the code handles it — file without .liquid extension
    // won't be included as a snippet candidate (doesn't end with .liquid).
    const files = [
      file("snippets/no-extension", "<div>no ext</div>"),
      file("layout/theme.liquid", "{{ content_for_layout }}"),
    ];
    // File doesn't end with .liquid — not a snippet candidate, no orphan.
    expect(analyzeFileReferences(files)).toEqual([]);
  });

  it("handles snippet names containing hyphens and underscores", () => {
    const files = [
      file("snippets/my-snippet_v2.liquid", "<div>v2</div>"),
      file("sections/product.liquid", "{% render 'my-snippet_v2' %}"),
    ];
    expect(analyzeFileReferences(files)).toEqual([]);
  });
});
