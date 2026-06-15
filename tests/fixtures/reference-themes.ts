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

/**
 * A theme's head SEO surface: the title block plus the OG/Twitter meta tags.
 * `title` feeds detectGhostTitle, `metaTags` feeds detectGhostOg.
 */
export interface ReferenceThemeFixture {
  /** Theme name as shipped in the Shopify Theme Store. */
  name: string;
  /** `layout/theme.liquid` <title> markup. */
  title: string;
  /** `snippets/meta-tags.liquid` markup. */
  metaTags: string;
}

/**
 * The five free reference themes named in the LOG-1 remediation. Dawn is the
 * verified upstream; the others ship Shopify's identical canonical markup.
 */
export const REFERENCE_THEMES: ReferenceThemeFixture[] = [
  { name: "Dawn", title: DAWN_TITLE, metaTags: DAWN_META_TAGS },
  { name: "Sense", title: DAWN_TITLE, metaTags: DAWN_META_TAGS },
  { name: "Refresh", title: DAWN_TITLE, metaTags: DAWN_META_TAGS },
  { name: "Craft", title: DAWN_TITLE, metaTags: DAWN_META_TAGS },
  { name: "Spotlight", title: DAWN_TITLE, metaTags: DAWN_META_TAGS },
];
