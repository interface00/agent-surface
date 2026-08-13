/**
 * Drop-in Cloudflare Pages Function.
 *
 * Put this at functions/[[path]].js to negotiate every route, or at a narrower
 * path like functions/app/[slug].js to negotiate only one section. Narrower is
 * usually right: a Function shadows the static asset at its route, so every
 * route it covers costs an extra ASSETS fetch even for plain HTML visits.
 *
 * Requires the .md twins to exist in your build output. This file chooses
 * between two prebuilt assets; it never generates Markdown, because generated
 * Markdown drifts from the HTML and that is how content negotiation quietly
 * turns into cloaking.
 */
import { createNegotiator } from '@orangestudio/agent-surface/negotiate';

const { onRequestGet, onRequestHead } = createNegotiator({
  siteUrl: 'https://example.com',

  // Where the Markdown twin lives for a given request path.
  // /app/runfit  ->  /app/runfit.md
  markdownPath: (path) => `${path}.md`,

  // The address you want cited. Usually the request path itself.
  canonicalPath: (path) => path,

  // Offered in the body of a Markdown 404, so an agent that guessed a URL has
  // somewhere to go next.
  notFoundIndex: 'https://example.com/llms.txt',
});

export { onRequestGet, onRequestHead };
