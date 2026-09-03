/**
 * Maintained list of AI-crawler user-agent / directive names recognized in
 * `<meta name="...">` robots-style directives (e.g. `<meta name="GPTBot"
 * content="noindex">`).
 *
 * Site owners (and the apps that configure them) can target individual AI
 * crawlers the same way they target the generic `robots` UA. When the app
 * that added the directive is uninstalled, the meta tag is often left behind
 * — GHOST_ROBOTS should catch these the same way it catches orphaned
 * `name="robots"` tags.
 *
 * Names are matched case-insensitively against the `name` attribute.
 */
export const AI_CRAWLER_USER_AGENTS = [
  "GPTBot",
  "ClaudeBot",
  "PerplexityBot",
  "Google-Extended",
  "CCBot",
  "anthropic-ai",
  "Bytespider",
  "Applebot-Extended",
];
