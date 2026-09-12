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
  // OpenAI — search index + user-triggered fetch (distinct from the GPTBot training crawler).
  "OAI-SearchBot",
  "ChatGPT-User",
  // Perplexity — user-triggered fetch (distinct from the PerplexityBot index crawler).
  "Perplexity-User",
  // Meta — Llama AI crawler + its user-triggered fetcher.
  "Meta-ExternalAgent",
  "Meta-ExternalFetcher",
  // Amazon — crawler feeding Amazon AI/Alexa answers.
  "Amazonbot",
  // Cohere — LLM training/retrieval crawler.
  "cohere-ai",
  // You.com AI search crawler.
  "YouBot",
  // Diffbot — knowledge-graph / LLM data crawler.
  "Diffbot",
  // Google — Vertex AI Agents fetcher (distinct from Google-Extended).
  "Google-CloudVertexBot",
];
