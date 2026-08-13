/**
 * Tells Bing and Yandex which pages changed, the moment they change.
 *
 * WHY BOTHER WHEN YOU ALREADY HAVE A SITEMAP
 *
 * A sitemap answers "what exists". This answers "what changed since the last
 * deploy", which is a much cheaper question for a crawler to act on. New URLs
 * routinely sit in Search Console as "Discovered, currently not indexed" for
 * days or weeks, and how fast that clears is a function of how often a site is
 * seen to change.
 *
 * It matters more than the Google number suggests: ChatGPT search rides Bing's
 * index, so a page Bing has not crawled cannot be cited by it.
 *
 * ONLY WHAT CHANGED
 *
 * Submits pages whose rendered HTML actually changed, compared against stored
 * hashes. Resubmitting your whole sitemap nightly is how a site teaches a
 * crawler to ignore its notifications, and it is what every naive integration
 * does. The first run has no state and submits everything, which is correct
 * exactly once.
 *
 * Check that your hashes do not churn on their own before trusting this. If a
 * page renders a view counter, a build date or a random testimonial, its hash
 * changes daily and you are back to submitting everything. Grep your build
 * output for today's date before you ship.
 *
 * ORDERING
 *
 * Must run AFTER the deploy. The protocol fetches the key file from the live
 * site to prove domain control, so a ping that overtakes its own deploy fails
 * verification.
 *
 * THE KEY IS NOT A SECRET
 *
 * It is published at https://your.site/<key>.txt on purpose. That file IS the
 * ownership proof. Commit it next to the code that uses it; do not put it in a
 * CI secret and wonder why verification fails.
 *
 * CONFIGURATION (environment)
 *
 *   SITE_URL       required, e.g. https://example.com, no trailing slash
 *   INDEXNOW_KEY   required, the key whose .txt file is live at the site root
 *   SITEMAP        default dist/sitemap-0.xml
 *   DIST_DIR       default dist
 *   STATE_FILE     default data/indexnow-state.json
 *
 * FAILURE POLICY
 *
 * Reports and exits 0, always. A notification service must never fail a
 * release. State advances only on an accepted submission, so a failed ping
 * retries the same URLs next deploy rather than losing them.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SITE_URL = process.env.SITE_URL;
const KEY = process.env.INDEXNOW_KEY;
const DIST_DIR = process.env.DIST_DIR ?? 'dist';
const SITEMAP = process.env.SITEMAP ?? `${DIST_DIR}/sitemap-0.xml`;
const STATE_FILE = process.env.STATE_FILE ?? 'data/indexnow-state.json';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

if (!SITE_URL || !KEY) {
  console.log('[indexnow] SITE_URL or INDEXNOW_KEY missing. Nothing submitted.');
  process.exit(0);
}

/**
 * Built file for a public URL. Tries directory format first, then flat, so this
 * works with generators that emit /page/index.html and with those that emit
 * /page.html without needing to be told which.
 */
function readPage(url) {
  const path = new URL(url).pathname.replace(/\/$/, '');
  for (const candidate of [`${DIST_DIR}${path}/index.html`, `${DIST_DIR}${path || '/index'}.html`]) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

function load() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { pages: {} };
  }
}

let sitemap;
try {
  sitemap = readFileSync(SITEMAP, 'utf8');
} catch {
  console.warn(`[indexnow] no ${SITEMAP}. Run the build first. Nothing submitted.`);
  process.exit(0);
}

const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (!urls.length) {
  console.warn('[indexnow] sitemap parsed to zero URLs. Nothing submitted.');
  process.exit(0);
}

const previous = load();
const current = {};
const changed = [];

for (const url of urls) {
  const html = readPage(url);
  if (html === null) {
    // Worth saying out loud: it is a build problem, not a reason to stop
    // notifying about everything else.
    console.warn(`[indexnow] no built page for ${url}, skipped`);
    continue;
  }
  const hash = createHash('sha256').update(html).digest('hex').slice(0, 16);
  current[url] = hash;
  if (previous.pages?.[url] !== hash) changed.push(url);
}

if (!changed.length) {
  console.log(`[indexnow] ${urls.length} URLs, none changed since the last deploy. Nothing submitted.`);
  process.exit(0);
}

const first = !previous.pages || Object.keys(previous.pages).length === 0;
console.log(
  first
    ? `[indexnow] first run, submitting all ${changed.length} URLs`
    : `[indexnow] ${changed.length} of ${urls.length} URLs changed`
);
for (const url of changed) console.log(`  ${url}`);

try {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(SITE_URL).host,
      key: KEY,
      keyLocation: `${SITE_URL}/${KEY}.txt`,
      urlList: changed,
    }),
  });

  // 200 accepted. 202 accepted with the key still being validated, which is the
  // normal answer to a first submission from a new key and is not a failure.
  if (res.status !== 200 && res.status !== 202) {
    console.warn(`[indexnow] refused ${res.status}: ${(await res.text()).slice(0, 200)}`);
    console.warn('[indexnow] state not advanced, the same URLs go again next deploy.');
    process.exit(0);
  }

  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(
    STATE_FILE,
    `${JSON.stringify({ updated: new Date().toISOString().slice(0, 10), pages: current }, null, 1)}\n`
  );
  console.log(`[indexnow] accepted (${res.status}). State advanced.`);
} catch (error) {
  console.warn(`[indexnow] failed, nothing recorded: ${error.message}`);
  process.exit(0);
}
