/**
 * Who is asking, and what they should get.
 *
 * Zero dependencies on purpose. This file is imported by edge functions that
 * bundle outside your app's build and cannot resolve path aliases, and it is
 * read by coding agents that should not have to follow an import to understand
 * the policy. Do not add imports here.
 *
 * THE RULE THAT KEEPS THIS OUT OF CLOAKING TERRITORY
 *
 *   Ranking crawlers always get the full HTML.
 *
 * Googlebot, Bingbot, Naver's Yeti and the rest decide your ranking. Serving
 * them something a visitor would not see is exactly what every search engine's
 * cloaking policy forbids, and the penalty is not a ranking adjustment, it is
 * removal. So they are never negotiated, and that check runs before anything
 * else in shouldServeMarkdown.
 *
 * What is negotiated is narrower and defensible: a client that explicitly asks
 * for text/markdown, and retrieval agents that fetch a page to answer a question
 * rather than to build a ranking index. Same facts, cheaper encoding, with
 * `Vary` declaring it to every cache in between.
 *
 * Two properties you must preserve for this to stay legitimate:
 *
 *   1. The Markdown is a strict SUBSET of what the HTML renders. If your
 *      Markdown carries a keyword payload a visitor cannot see on the page, this
 *      stops being content negotiation and becomes cloaking, whatever the
 *      user agent said.
 *   2. The Markdown address is publicly reachable and advertised in the HTML
 *      head with <link rel="alternate" type="text/markdown">. Nothing is hidden
 *      from anyone who wants to look.
 *
 * If you cannot honestly say both, do not ship this.
 */

/**
 * Retrieval and answer engines. These read a page, they do not rank it.
 * Matched case insensitively as substrings of the User-Agent.
 *
 * Adding to this list widens what gets Markdown. Adding to INDEX_CRAWLERS
 * narrows it. When you are unsure which list a new bot belongs in, put it in
 * neither: an unknown agent falls through to `human` and gets HTML, which is
 * the safe default.
 */
const LLM_AGENTS = [
  'gptbot',
  'oai-searchbot',
  'chatgpt-user',
  'claudebot',
  'claude-web',
  'claude-user',
  'claude-searchbot',
  'anthropic-ai',
  'perplexitybot',
  'perplexity-user',
  'google-extended',
  'gemini-deep-research',
  'youbot',
  'phindbot',
  'cohere-ai',
  'meta-externalagent',
  'amazonbot',
  'applebot-extended',
  'mistralai-user',
  'diffbot',
  'timpibot',
];

/**
 * Ranking crawlers. Never negotiated.
 *
 * Listed explicitly and checked FIRST, so that a later edit to LLM_AGENTS
 * cannot capture one of them by accident. That ordering is the safety property
 * of this module, not a style choice.
 */
const INDEX_CRAWLERS = [
  'googlebot',
  'google-inspectiontool',
  'storebot-google',
  'bingbot',
  'adidxbot',
  'yeti', // Naver
  'daum',
  'duckduckbot',
  'baiduspider',
  'yandexbot',
  'applebot', // applebot-extended is the LLM variant and is resolved before this
  'slurp',
];

/**
 * @typedef {'index-crawler' | 'llm-agent' | 'human'} AgentClass
 */

/**
 * @param {string | null | undefined} userAgent
 * @returns {AgentClass}
 */
export function classifyAgent(userAgent) {
  if (!userAgent) return 'human';
  const ua = userAgent.toLowerCase();

  // Applebot-Extended is the AI variant and must not be swallowed by the plain
  // `applebot` substring below, so it resolves first. Any future bot whose name
  // contains a ranking crawler's name needs the same treatment.
  if (ua.includes('applebot-extended')) return 'llm-agent';

  if (INDEX_CRAWLERS.some((c) => ua.includes(c))) return 'index-crawler';
  if (LLM_AGENTS.some((c) => ua.includes(c))) return 'llm-agent';
  return 'human';
}

/**
 * True when the client asked for Markdown and did not also accept HTML.
 *
 * The second half matters. Browsers send `Accept: text/html,...,*\/*` and curl
 * sends `Accept: *\/*`; neither is an opt in, and treating a wildcard as one
 * would hand Markdown to anyone who forgot to set a header.
 *
 * @param {string | null | undefined} accept
 */
export function prefersMarkdown(accept) {
  if (!accept) return false;
  const a = accept.toLowerCase();
  if (a.includes('text/html')) return false;
  return a.includes('text/markdown') || a.includes('text/x-markdown');
}

/**
 * The single decision. True only when Markdown is both safe and useful.
 *
 * @param {Headers} headers
 */
export function shouldServeMarkdown(headers) {
  // First, and deliberately. See the cloaking note at the top.
  if (classifyAgent(headers.get('user-agent')) === 'index-crawler') return false;
  if (prefersMarkdown(headers.get('accept'))) return true;
  return classifyAgent(headers.get('user-agent')) === 'llm-agent';
}

/**
 * Applied to every negotiated response so no shared cache hands a Markdown body
 * to a browser, or an HTML body to an agent that asked for Markdown.
 *
 * Omitting this is the single most likely way to break a site with this module:
 * a CDN caches the first response for a URL and serves it to everyone.
 */
export const VARY_HEADER = 'Accept, User-Agent';

/** Exported for tests and for anyone auditing the lists. */
export const _lists = { LLM_AGENTS, INDEX_CRAWLERS };
