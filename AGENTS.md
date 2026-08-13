# AGENTS.md

Instructions for a coding agent working in this repository, or integrating it
into another project.

## What this is

`agent-surface` decides whether a request gets Markdown or HTML, and records
whether AI systems and search engines actually fetched the site. Four source
files, zero dependencies, no build step. Read them in full before changing them;
they are short, and the comments carry the reasons.

```
src/agents.mjs        who is asking, and what they should get
src/negotiate.mjs     Cloudflare Pages Function built on that policy
scripts/indexnow.mjs      tell Bing and Yandex what changed
scripts/index-status.mjs  ask Google what it actually indexed
scripts/ai-crawlers.mjs   record which AI systems fetched the site
```

## The invariant you must not break

**A ranking crawler always receives the full HTML.** Googlebot, Bingbot, Yeti,
Baiduspider, YandexBot and the rest are checked before anything else in
`shouldServeMarkdown`, and that ordering is a safety property rather than a style
choice. Inverting it is not a bug that produces a wrong page; it is a cloaking
violation, and the penalty is removal from an index.

`test/agents.test.mjs` asserts this, including the case where a ranking crawler
explicitly asks for Markdown. If you change the negotiation logic and that test
still passes, you have probably not broken the invariant. If you find yourself
editing that test to make a change pass, stop and ask a human.

## When integrating into a site

1. The Markdown must be a **strict subset** of what the HTML renders, generated
   by the same build. If you are generating Markdown inside the request handler,
   you have introduced drift, and drift is how this becomes cloaking.
2. Advertise the twin in the HTML head:
   `<link rel="alternate" type="text/markdown" href="/path.md">`.
3. Set `Vary: Accept, User-Agent` on every negotiated response. The negotiator
   does this; if you write your own handler, do not omit it or a CDN will serve
   one visitor's response to everyone.
4. Ship a `404.html` in the build. Without one, Cloudflare Pages answers
   unmatched paths with `index.html` and a `200`, and a missing Markdown twin
   comes back as HTML labelled `text/markdown`.
5. Prefer a narrow Function route (`functions/app/[slug].js`) over a catch-all
   (`functions/[[path]].js`). A Function shadows the static asset at its route,
   so every route it covers costs an extra `ASSETS` fetch even for plain visits.

## When adding a bot to the user-agent lists

`LLM_AGENTS` widens what receives Markdown. `INDEX_CRAWLERS` narrows it.

If you are not certain which a new bot belongs to, **add it to neither**. An
unknown agent falls through to `human` and receives HTML, which is the safe
default and costs nothing but a slightly larger response.

Watch for names that contain another name. `Applebot-Extended` is the AI variant
and `Applebot` is the ranking crawler; the plain substring would swallow the
extended one, so it is resolved by an explicit early return. Any future bot with
that shape needs the same treatment, not a list reordering.

## When changing the scripts

Every script here has the same contract, and it is not negotiable:

- Exits `0` on every failure. These run in deploy pipelines. A reporting script
  that can fail a release is a reporting script that gets deleted.
- Exits quietly when its credentials are absent, so it can be committed before
  the secret exists and run locally without one.
- Writes state only after a successful call, so a failed run retries rather than
  losing work.

Three specific traps, all of which have already cost someone a day:

- **Never classify Search Console coverage by substring.** `Discovered -
  currently not indexed` and `Crawled - currently not indexed` both contain the
  word `indexed`. Use `verdict === 'PASS'`.
- **The URL Inspection API is eventually consistent.** It flaps between
  `Discovered` and `URL is unknown to Google` within minutes. Record a change
  only when the coarse stage moves, which is what `stage()` is for.
- **`git diff` does not see untracked files.** If a workflow commits these state
  files, guard with `git status --porcelain`, not `git diff --quiet`, or the
  first run of a new series is created and discarded on the same run.

## Testing

```bash
npm test
```

Node's built-in test runner, no dependencies. Add a test for any behaviour you
change. The negotiator tests run against a fake asset server because both bugs
this code carries scars from were visible only at request time, not by reading.

## Out of scope

This repository does not generate content, write Markdown, or decide what a page
says. It decides which of two prebuilt representations to return, and it measures
who asked. Keep it that way; a negotiation layer that also authors content cannot
guarantee the two stay identical.
