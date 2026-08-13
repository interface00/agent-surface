/**
 * A Cloudflare Pages Function that serves Markdown to AI readers and HTML to
 * everyone else, from the same static build.
 *
 * WHY A FUNCTION AND NOT FRAMEWORK MIDDLEWARE
 *
 * On a static build there is no request to negotiate against: framework
 * middleware runs at build time and is gone by the time a crawler arrives.
 * Pages Functions run per request in front of the static assets, which is
 * exactly the layer this needs, and the HTML path stays a pass through to the
 * asset that would have been served anyway, so your Lighthouse score does not
 * move.
 *
 * The trade is that a Function SHADOWS the static asset at its route. Once this
 * exists, the human path has to fetch the asset back explicitly through
 * env.ASSETS. That is not a workaround, it is the cost of getting a request hook.
 *
 * NO CONTENT LIVES HERE
 *
 * This decides which of two prebuilt assets to return. Both come out of the same
 * build, so they cannot drift. If you find yourself generating Markdown inside
 * this function, stop: that is how the Markdown stops being a subset of the HTML
 * and the whole thing turns into cloaking.
 */
import { shouldServeMarkdown, VARY_HEADER } from './agents.mjs';

/** Long shared cache, cheap revalidation. Content changes only on deploy. */
const DEFAULT_CACHE = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';

/**
 * @typedef {object} NegotiateOptions
 * @property {string} siteUrl            Origin without a trailing slash, e.g. "https://example.com".
 * @property {(path: string) => string} markdownPath  Maps a request path to the built .md asset path.
 * @property {(path: string) => string} [canonicalPath] Address to advertise as canonical. Defaults to the request path.
 * @property {string} [cacheControl]     Overrides the Markdown cache header.
 * @property {string} [notFoundIndex]    URL offered in the Markdown 404 body.
 */

/**
 * Builds the `onRequestGet` / `onRequestHead` pair for a Pages Function.
 *
 * @param {NegotiateOptions} options
 */
export function createNegotiator(options) {
  const {
    siteUrl,
    markdownPath,
    canonicalPath = (p) => p,
    cacheControl = DEFAULT_CACHE,
    notFoundIndex,
  } = options;

  if (!siteUrl || siteUrl.endsWith('/')) {
    throw new Error('siteUrl is required and must not end with a slash');
  }
  if (typeof markdownPath !== 'function') {
    throw new Error('markdownPath must be a function from request path to .md asset path');
  }

  /**
   * Human, or a ranking crawler. Serves the static HTML that would have been
   * returned without this Function.
   *
   * The trailing slash is added BEFORE asking the asset server. Static site
   * generators commonly build directory format, so the page lives at
   * /thing/index.html and asking for /thing earns a 308 to the slash form. If
   * the URLs you publish are the slash-less ones, which is usual for canonical
   * tags and structured data, then without this line a redirect hop sits in
   * front of every visit and every crawl of the address you asked the world to
   * use. This was a real bug, found by running the function locally rather than
   * by reading it.
   */
  async function serveHtml(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/')) url.pathname += '/';

    const asset = await env.ASSETS.fetch(new Request(url.toString(), request));
    const headers = new Headers(asset.headers);
    headers.set('Vary', VARY_HEADER);
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers,
    });
  }

  async function serveMarkdown(request, env, requestPath) {
    const url = new URL(request.url);
    url.pathname = markdownPath(requestPath);
    url.search = '';

    const asset = await env.ASSETS.fetch(new Request(url.toString(), { headers: request.headers }));

    /**
     * Two checks, because either one alone has already been wrong in production.
     *
     * `asset.ok` is the normal signal, and it only works if your build emits a
     * 404 page. Without one, Pages falls back to index.html with a 200: `ok`
     * passes, and an agent that asked for a missing .md gets a page of HTML
     * under a `text/markdown` header. It will believe you.
     *
     * The content type check is the belt to that braces. It is what caught the
     * bug, and removing the 404 page later would quietly bring the mislabelling
     * back without it.
     */
    const assetType = asset.headers.get('content-type') ?? '';

    if (!asset.ok || assetType.startsWith('text/html')) {
      const index = notFoundIndex ? `\n\nIndex: ${notFoundIndex}\n` : '\n';
      return new Response(`# 404\n\nNot found: ${requestPath}${index}`, {
        status: 404,
        headers: { 'content-type': 'text/markdown; charset=utf-8', Vary: VARY_HEADER },
      });
    }

    return new Response(asset.body, {
      status: 200,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': cacheControl,
        // Points every consumer at the address you want cited, not at this one.
        link: `<${siteUrl}${canonicalPath(requestPath)}>; rel="canonical"`,
        // The Markdown twin must never compete with the HTML page in an index.
        'x-robots-tag': 'noindex',
        Vary: VARY_HEADER,
      },
    });
  }

  /** @param {{request: Request, env: {ASSETS: {fetch: Function}}}} context */
  const onRequestGet = async ({ request, env }) => {
    const path = new URL(request.url).pathname;

    // The .md address is already Markdown. The Function shadows it too, so it is
    // served here rather than being allowed to fall through and 404.
    if (path.endsWith('.md')) {
      return serveMarkdown(request, env, path.slice(0, -3));
    }

    if (!shouldServeMarkdown(request.headers)) return serveHtml(request, env);
    return serveMarkdown(request, env, path.replace(/\/$/, ''));
  };

  /** Cheap probe before pulling a body. Agents use this more than people expect. */
  const onRequestHead = async (context) => {
    const response = await onRequestGet(context);
    return new Response(null, { status: response.status, headers: response.headers });
  };

  return { onRequestGet, onRequestHead };
}
