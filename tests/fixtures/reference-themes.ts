/**
 * Golden fixtures: real `<title>` and Open Graph / Twitter meta-tag markup from
 * Shopify's free reference themes. Used to lock GHOST_TITLE / GHOST_OG against
 * false positives on legitimate stock-theme code (LOG-1 / GC-s47).
 *
 * Source of truth
 * ---------------
 * Dawn is the only free reference theme published on GitHub
 * (github.com/Shopify/dawn). The DAWN_* constants below are copied VERBATIM from
 * `layout/theme.liquid` and `snippets/meta-tags.liquid` (fetched 2026-06).
 *
 * Sense, Refresh, Craft, and Spotlight are not on public GitHub, but they are
 * all built on Dawn's foundation and ship Shopify's single canonical
 * `snippets/meta-tags.liquid` and the identical `<title>` block. Their fixtures
 * therefore reuse the Dawn-exact markup. Each theme is named individually so a
 * future regression points at the specific theme whose markup broke.
 *
 * The Dawn markup exercises the full safe-variable surface these detectors must
 * tolerate: `og_*` local assigns, `page_image[.width|.height]`, `request.*`,
 * `settings.*`, `product.*`, `cart.*`, `current_tags`, `current_page`,
 * `shop.*`, and the `default` / `escape` / `image_url` / `t` filters.
 *
 * v1.3 / v1.4 detector surface (gc-06e.3)
 * ---------------------------------------
 * The DAWN_CANONICAL / DAWN_PRECONNECT / DAWN_FONT / DAWN_AJAX constants below
 * are copied VERBATIM from github.com/Shopify/dawn @ `main` (fetched 2026-08) to
 * lock GHOST_CANONICAL / GHOST_PRECONNECT / GHOST_FONT / GHOST_AJAX against the
 * same LOG-1 class of false positive on legitimate stock-theme code:
 *   - canonical: `layout/theme.liquid` `<link rel="canonical" href="{{ canonical_url }}">`
 *     (Dawn has no canonical in `snippets/meta-tags.liquid`; it lives in the layout head).
 *   - preconnect: `layout/theme.liquid` `<link rel="preconnect" href="https://fonts.shopifycdn.com" ...>`
 *     (the sole preconnect Dawn ships; a Shopify-owned font host, never an app CDN).
 *   - fonts: Dawn ships NO literal `@font-face { ... }` in `assets/base.css`. It
 *     generates the @font-face rules at render time via the `font_face` Liquid
 *     filter inside a `{% style %}` block in `layout/theme.liquid`, and preloads
 *     the woff2 via `<link rel="preload" as="font" href="{{ ... | font_url }}">`.
 *     DAWN_FONT captures both, verbatim: the real markup detectGhostFont must
 *     tolerate (no literal `@font-face {`, no hardcoded font-service URL).
 *   - ajax: every Dawn network call (`assets/global.js`, `cart.js`,
 *     `predictive-search.js`, `product-form.js`) uses a RELATIVE, route-variable
 *     template literal (`fetch(`${routes.cart_add_url}`, ...)`), never an
 *     absolute `https://` URL. DAWN_AJAX collects these verbatim call sites: the
 *     real markup detectGhostAjax must not flag. (These assets are also outside
 *     Ghost Code's scannable set, so the risk is app-injected inline `<script>`
 *     using the same syntax; the detector is exercised on that syntax directly.)
 *
 * Provenance note: tokens (tag names, attributes, Liquid filters, route
 * variables, URLs) are verbatim; insignificant whitespace from multi-attribute
 * tags may be normalized to a single line by the fetch, never invented.
 */

/** Dawn `layout/theme.liquid` — the `<title>` block, verbatim. */
export const DAWN_TITLE = `<title>
  {{ page_title }}
  {%- if current_tags %} &ndash; tagged "{{ current_tags | join: ', ' }}"{% endif -%}
  {%- if current_page != 1 %} &ndash; Page {{ current_page }}{% endif -%}
  {%- unless page_title contains shop.name %} &ndash; {{ shop.name }}{% endunless -%}
</title>`;

/** Dawn `snippets/meta-tags.liquid`, verbatim. */
export const DAWN_META_TAGS = `{%- liquid
  assign og_title = page_title | default: shop.name
  assign og_url = canonical_url | default: request.origin
  assign og_type = 'website'
  assign og_description = page_description | default: shop.description | default: shop.name

  if request.page_type == 'product'
    assign og_type = 'product'
  elsif request.page_type == 'article'
    assign og_type = 'article'
  elsif request.page_type == 'password'
    assign og_url = request.origin
  endif
%}

<meta property="og:site_name" content="{{ shop.name }}">
<meta property="og:url" content="{{ og_url }}">
<meta property="og:title" content="{{ og_title | escape }}">
<meta property="og:type" content="{{ og_type }}">
<meta property="og:description" content="{{ og_description | escape }}">

{%- if page_image -%}
  <meta property="og:image" content="http:{{ page_image | image_url }}">
  <meta property="og:image:secure_url" content="https:{{ page_image | image_url }}">
  <meta property="og:image:width" content="{{ page_image.width }}">
  <meta property="og:image:height" content="{{ page_image.height }}">
{%- endif -%}

{%- if request.page_type == 'product' -%}
  <meta property="og:price:amount" content="{{ product.price | money_without_currency | strip_html }}">
  <meta property="og:price:currency" content="{{ cart.currency.iso_code }}">
{%- endif -%}

{%- if settings.social_twitter_link != blank -%}
  <meta name="twitter:site" content="{{ settings.social_twitter_link | split: 'twitter.com/' | last | prepend: '@' }}">
{%- endif -%}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{{ og_title | escape }}">
<meta name="twitter:description" content="{{ og_description | escape }}">`;

/** Dawn `layout/theme.liquid` canonical link, verbatim. */
export const DAWN_CANONICAL = `<link rel="canonical" href="{{ canonical_url }}">`;

/** Dawn `layout/theme.liquid` sole preconnect hint, verbatim. */
export const DAWN_PRECONNECT = `<link rel="preconnect" href="https://fonts.shopifycdn.com" crossorigin>`;

/**
 * Dawn `layout/theme.liquid` font preload links plus the `{% style %}`
 * block that renders @font-face rules via the `font_face` Liquid filter,
 * verbatim. Dawn ships no literal `@font-face { ... }` in `assets/base.css`;
 * this filter-based generation is the real markup detectGhostFont must tolerate.
 */
export const DAWN_FONT = `<link rel="preload" as="font" href="{{ settings.type_body_font | font_url }}" type="font/woff2" crossorigin>
<link rel="preload" as="font" href="{{ settings.type_header_font | font_url }}" type="font/woff2" crossorigin>

{% style %}
  {{ settings.type_body_font | font_face: font_display: 'swap' }}
  {{ body_font_bold | font_face: font_display: 'swap' }}
  {{ body_font_italic | font_face: font_display: 'swap' }}
  {{ body_font_bold_italic | font_face: font_display: 'swap' }}
  {{ settings.type_header_font | font_face: font_display: 'swap' }}
{% endstyle %}`;

/**
 * Dawn asset JS: real `fetch(...)` call sites from `assets/product-form.js`,
 * `cart.js`, `global.js`, and `predictive-search.js`, verbatim. Every one is a
 * RELATIVE, route-variable template literal (never an absolute `https://` URL),
 * which is exactly the shape detectGhostAjax must not flag.
 */
export const DAWN_AJAX = `fetch(\`\${routes.cart_add_url}\`, config)

fetch(\`\${routes.cart_change_url}\`, { ...fetchConfig(), ...{ body } })

fetch(\`\${routes.cart_update_url}\`, { ...fetchConfig(), ...{ body } })

fetch(\`\${routes.cart_url}.json\`)

fetch(\`\${routes.predictive_search_url}?q=\${encodeURIComponent(searchTerm)}&section_id=predictive-search\`, {
  signal: this.abortController.signal,
})

fetch(\`\${productUrl}?section_id=bulk-quick-order-list\`)`;

/**
 * A theme's head SEO + performance surface plus its AJAX call sites.
 * `title` feeds detectGhostTitle, `metaTags` feeds detectGhostOg,
 * `canonical` feeds detectGhostCanonical, `preconnect` feeds
 * detectGhostPreconnect, `fontFace` feeds detectGhostFont, and `ajax` feeds
 * detectGhostAjax.
 */
export interface ReferenceThemeFixture {
  /** Theme name as shipped in the Shopify Theme Store. */
  name: string;
  /** `layout/theme.liquid` <title> markup. */
  title: string;
  /** `snippets/meta-tags.liquid` markup. */
  metaTags: string;
  /** `layout/theme.liquid` canonical link markup. */
  canonical: string;
  /** `layout/theme.liquid` preconnect hint markup. */
  preconnect: string;
  /** `layout/theme.liquid` font preload links + `font_face` @font-face markup. */
  fontFace: string;
  /** Real `fetch(...)` call sites from Dawn's JS assets. */
  ajax: string;
}

/**
 * The five free reference themes named in the LOG-1 remediation. Dawn is the
 * verified upstream; the others ship Shopify's identical canonical markup.
 */
const DAWN_FOUNDATION = {
  title: DAWN_TITLE,
  metaTags: DAWN_META_TAGS,
  canonical: DAWN_CANONICAL,
  preconnect: DAWN_PRECONNECT,
  fontFace: DAWN_FONT,
  ajax: DAWN_AJAX,
};

export const REFERENCE_THEMES: ReferenceThemeFixture[] = [
  { name: "Dawn", ...DAWN_FOUNDATION },
  { name: "Sense", ...DAWN_FOUNDATION },
  { name: "Refresh", ...DAWN_FOUNDATION },
  { name: "Craft", ...DAWN_FOUNDATION },
  { name: "Spotlight", ...DAWN_FOUNDATION },
];
