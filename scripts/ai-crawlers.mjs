/**
 * Records which AI systems actually fetched your site, and why.
 *
 * MOST SITES ARE GUESSING ABOUT THIS
 *
 * Everything people build for AI readers rests on an assumption almost nobody
 * checks: that AI crawlers come. The published evidence says it is worth
 * checking. Independent log analysis in 2026 found that roughly 97% of llms.txt
 * files receive zero requests, and that AI crawlers overwhelmingly skip the file
 * and read HTML instead. Your AI surface can be perfectly built and fetched by
 * nothing.
 *
 * THE SPLIT THAT MAKES THIS USEFUL
 *
 * Traffic is recorded in two groups, because they mean completely different
 * things and a single "AI bot traffic" number cannot tell them apart:
 *
 *   ANSWER TIME  ChatGPT-User, OAI-SearchBot, Claude-User, Claude-SearchBot,
 *                PerplexityBot, Perplexity-User. These fetch because a person
 *                asked a question a moment ago and the model went to look. One
 *                of these is worth more than a thousand of the other kind: it
 *                means you were consulted.
 *
 *   INDEXING     GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot,
 *                Bytespider, meta-externalagent, Amazonbot. Corpus building.
 *                Necessary, but it says nothing about whether anyone is asking
 *                about you.
 *
 * A month of indexing hits with zero answer time hits means your content is
 * ingested and never surfaced. That is a different problem from not being
 * crawled at all, and it needs a different fix.
 *
 * SOURCE
 *
 * Cloudflare's GraphQL analytics, dataset httpRequestsAdaptiveGroups, the same
 * data behind the AI Crawl Control tab. Bot detection IDs would be cleaner than
 * user agent matching but require a Bot Management subscription, so this matches
 * on the user agent string.
 *
 * CONFIGURATION (environment)
 *
 *   CLOUDFLARE_ANALYTICS_TOKEN  required, needs Analytics Read. A Pages or
 *                               Workers deploy token does NOT have it.
 *   CLOUDFLARE_ZONE_ID          required
 *   STATE_FILE                  default data/ai-crawler-history.json
 *
 * FAILURE POLICY
 *
 * Exits quietly without credentials, swallows every API failure, never fails a
 * deploy.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const STATE_FILE = process.env.STATE_FILE ?? 'data/ai-crawler-history.json';

/** Grouped by what a hit MEANS rather than by vendor. See the note above. */
const BOTS = {
  answerTime: {
    'chatgpt-user': '%ChatGPT-User%',
    'oai-searchbot': '%OAI-SearchBot%',
    'claude-user': '%Claude-User%',
    'claude-searchbot': '%Claude-SearchBot%',
    perplexitybot: '%PerplexityBot%',
    'perplexity-user': '%Perplexity-User%',
  },
  indexing: {
    gptbot: '%GPTBot%',
    claudebot: '%ClaudeBot%',
    'google-extended': '%Google-Extended%',
    'applebot-extended': '%Applebot-Extended%',
    ccbot: '%CCBot%',
    bytespider: '%Bytespider%',
    'meta-externalagent': '%meta-externalagent%',
    amazonbot: '%Amazonbot%',
  },
};

const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
const zone = process.env.CLOUDFLARE_ZONE_ID;
if (!token || !zone) {
  console.log('[ai] CLOUDFLARE_ANALYTICS_TOKEN or CLOUDFLARE_ZONE_ID missing. Nothing pulled.');
  process.exit(0);
}

/** Yesterday, complete. Today is still accumulating and would read low. */
const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

function load() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const history = load();
if (history[day]) {
  console.log(`[ai] ${day} already recorded. Nothing to do.`);
  process.exit(0);
}

/** Aliases must be valid GraphQL names, so keys are mapped through a safe form. */
const alias = (name) => `b_${name.replace(/[^a-z0-9]/gi, '_')}`;
const selections = Object.values(BOTS)
  .flatMap((group) => Object.entries(group))
  .map(
    ([name, pattern]) => `    ${alias(name)}: httpRequestsAdaptiveGroups(
      limit: 1
      filter: {
        datetime_geq: "${day}T00:00:00Z"
        datetime_leq: "${day}T23:59:59Z"
        requestSource: "eyeball"
        userAgent_like: "${pattern}"
      }
    ) { count }`
  )
  .join('\n');

const query = `query AiCrawlers {
  viewer {
    zones(filter: { zoneTag: "${zone}" }) {
${selections}
    }
  }
}`;

try {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  const body = await res.json();
  if (!res.ok || body.errors?.length) {
    console.warn(`[ai] query refused: ${body.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
    console.warn('[ai] if this mentions permissions, the token needs Analytics Read. Nothing recorded.');
    process.exit(0);
  }

  const zoneData = body.data?.viewer?.zones?.[0];
  if (!zoneData) {
    console.warn('[ai] no zone returned. Check CLOUDFLARE_ZONE_ID. Nothing recorded.');
    process.exit(0);
  }

  const read = (group) =>
    Object.fromEntries(
      Object.keys(group)
        .map((name) => [name, zoneData[alias(name)]?.[0]?.count ?? 0])
        .filter(([, n]) => n > 0)
    );

  const answerTime = read(BOTS.answerTime);
  const indexing = read(BOTS.indexing);
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

  console.log(`[ai] ${day}: ${sum(answerTime)} answer time, ${sum(indexing)} indexing`);
  for (const [name, n] of Object.entries(answerTime)) console.log(`  ASKED  ${String(n).padStart(5)}  ${name}`);
  for (const [name, n] of Object.entries(indexing)) console.log(`         ${String(n).padStart(5)}  ${name}`);

  // Zero is a finding, not an absence. A run of zeroes is the answer that should
  // change what you build next, so it is recorded rather than skipped.
  if (!sum(answerTime) && !sum(indexing)) console.log('[ai] nothing fetched this site. Recorded as zero.');

  history[day] = { answerTime, indexing };
  const ordered = Object.fromEntries(Object.keys(history).sort().map((d) => [d, history[d]]));
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(ordered, null, 1)}\n`);
  console.log(`[ai] recorded ${day}.`);
} catch (error) {
  console.warn(`[ai] failed, nothing recorded: ${error.message}`);
  process.exit(0);
}
