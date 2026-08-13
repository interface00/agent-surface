# agent-surface

Serve Markdown to AI readers and HTML to ranking crawlers, from the same static
build, without cloaking. Then measure whether any of them actually came.

Zero dependencies. Node 18+. MIT.

## Why this exists

Two things are usually true of a site that has done work for AI readers:

1. It cannot prove any AI system ever fetched it.
2. It is one careless edit away from a cloaking violation.

This is the code for both problems, extracted from a production site and left
with its scar tissue intact. The comments explaining why something is the way it
is are the point; if you only want the happy path, the files are short enough to
read in full.

## The rule

> **Ranking crawlers always get the full HTML.**

Googlebot, Bingbot, Naver's Yeti and the rest decide your ranking. Serving them
something a visitor would not see is what every search engine's cloaking policy
forbids, and the penalty is removal, not a ranking adjustment. So they are never
negotiated, and that check runs first in `shouldServeMarkdown`.

What is negotiated is narrower: a client that explicitly asks for
`text/markdown`, and retrieval agents that fetch a page to answer a question
rather than to rank it.

Two properties keep this legitimate, and they are your job, not the library's:

1. **The Markdown is a strict subset of what the HTML renders.** If it carries a
   keyword payload a visitor cannot see, this is cloaking whatever the User-Agent
   said.
2. **The Markdown address is publicly reachable** and advertised in the HTML head
   with `<link rel="alternate" type="text/markdown">`.

If you cannot honestly say both, do not ship this.

## Install

```bash
npm install @orangestudio/agent-surface
```

Or copy the four files. They have no dependencies and no build step, which is
deliberate: an agent reading your repository should be able to see the whole
policy without following an import.

## Negotiate

```js
// functions/app/[slug].js  (Cloudflare Pages)
import { createNegotiator } from '@orangestudio/agent-surface/negotiate';

export const { onRequestGet, onRequestHead } = createNegotiator({
  siteUrl: 'https://example.com',
  markdownPath: (path) => `${path}.md`,
  notFoundIndex: 'https://example.com/llms.txt',
});
```

Or use the policy directly, in any runtime with `Request`/`Headers`:

```js
import { shouldServeMarkdown, classifyAgent, VARY_HEADER } from '@orangestudio/agent-surface';

classifyAgent('Mozilla/5.0 (compatible; Googlebot/2.1)');   // 'index-crawler'
classifyAgent('Mozilla/5.0 (compatible; ClaudeBot/1.0)');   // 'llm-agent'
classifyAgent('Chrome/120');                                // 'human'

shouldServeMarkdown(request.headers);                       // the single decision
```

Always set `Vary: Accept, User-Agent` on negotiated responses. Omitting it is the
most likely way to break a site with this module: a CDN caches the first response
for a URL and serves it to everyone.

### Why a Pages Function and not framework middleware

On a static build there is no request to negotiate against. Framework middleware
runs at build time and is gone before a crawler arrives. Pages Functions run per
request in front of the static assets, and the HTML path stays a pass through to
the asset that would have been served anyway.

## Measure

Three scripts, all configured by environment variables, all of which exit 0 on
every failure. A reporting script that can fail a deploy is a reporting script
nobody keeps.

| Script | Answers |
| --- | --- |
| `scripts/ai-crawlers.mjs` | Did any AI system fetch this site, and was it asking or indexing? |
| `scripts/index-status.mjs` | Has Google actually indexed each URL? |
| `scripts/indexnow.mjs` | Tell Bing and Yandex what changed, this deploy only. |

### The split that makes crawler data useful

`ai-crawlers.mjs` records two groups separately, because a single "AI bot
traffic" number cannot tell them apart:

- **answer time** — `ChatGPT-User`, `OAI-SearchBot`, `Claude-User`,
  `PerplexityBot`. These fetch because someone asked a question a moment ago.
  One of these is worth more than a thousand of the other kind: it means you were
  consulted.
- **indexing** — `GPTBot`, `ClaudeBot`, `Google-Extended`, `CCBot`. Corpus
  building. Says nothing about whether anyone is asking about you.

A month of indexing hits with zero answer-time hits means your content is
ingested and never surfaced. Different problem, different fix.

## Things that cost us time

Kept here because they are not in the documentation anywhere.

**`coverageState` cannot be substring-matched for "indexed".** Three of its
values contain that word while meaning opposite things:

```
Submitted and indexed                on Google
Discovered - currently not indexed   known, not crawled yet
Crawled - currently not indexed      crawled, judged not worth indexing
```

A substring test reported 10 of 12 URLs as indexed on a site where the real
number was 1. Use the `verdict` field: `PASS` means on Google.

**The URL Inspection API flaps.** Two inspections four minutes apart returned
`Discovered` and then `URL is unknown to Google`, in both directions, on three
URLs. Recording every coverage change as a dated event fills your history with
transitions that never happened. `index-status.mjs` records a change only when a
coarse *stage* moves.

**`git diff` does not see untracked files.** A first run that creates a new state
file and guards its commit with `git diff --quiet` reports "nothing to commit"
and throws the file away. IndexNow then treats every deploy as a first run and
resubmits everything nightly, which is how you teach a crawler to ignore you. Use
`git status --porcelain`.

**A missing 404 page turns a Markdown 404 into a lie.** With no `404.html` in the
build, Cloudflare Pages answers unmatched paths with `index.html` and a `200`.
`response.ok` passes, and an agent asking for a missing `.md` receives HTML under
a `text/markdown` header. The negotiator checks the content type as well as `ok`.

**A Function shadows the static asset at its route**, so the HTML path must fetch
the asset back through `env.ASSETS`, and it must add the trailing slash first if
your generator builds directory format. Otherwise a 308 redirect sits in front of
every crawl of the canonical URL you publish.

**Do not expect much from `llms.txt`.** Independent 2026 log analysis reports
roughly 97% of published `llms.txt` files receive zero requests, and Google
states it has no effect on Search or AI Overviews. Serving it costs nothing, so
serve it, but the surface AI systems actually fetch is your pages.

## Test

```bash
npm test
```

21 tests, no dependencies. The ones that matter assert that a ranking crawler
never reaches the Markdown branch, including when it asks for Markdown.

## Who made this

Built for [Orange Studio](https://orangeai.co.kr), which turns one photo and one
voice recording into short-form video for app developers. The code here is the
part of that site that is not about video, extracted because it was useful and
undocumented elsewhere.

Contributions welcome, particularly additions to the user-agent lists in
`src/agents.mjs`. If you are unsure which list a new bot belongs in, put it in
neither: an unknown agent falls through to `human` and gets HTML, which is the
safe default.
