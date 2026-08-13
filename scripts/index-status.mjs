/**
 * Records whether Google has actually indexed each page, per URL, over time.
 *
 * Submitting a sitemap is something you do. Being indexed is something Google
 * decides, days to weeks later, and it decides it separately for every URL.
 * Without a record, the only way to know a page went in is to remember what the
 * dashboard said last week.
 *
 * READ THIS BEFORE YOU CLASSIFY ANYTHING
 *
 * Use the `verdict` field. PASS means the URL is on Google. Do NOT decide by
 * searching `coverageState` for the word "indexed", because three of its values
 * contain that word while meaning the opposite:
 *
 *   Submitted and indexed              on Google
 *   Discovered - currently not indexed known, not crawled yet
 *   Crawled - currently not indexed    crawled, judged not worth indexing
 *
 * A substring test on that word reported 10 of 12 URLs as indexed on a site
 * where the true number was 1. That is the entire reason this comment exists.
 *
 * WHY A STAGE AND NOT THE RAW COVERAGE STRING
 *
 * Two inspections of the same URL four minutes apart returned "Discovered -
 * currently not indexed" and then "URL is unknown to Google", in both
 * directions, on three different URLs. That is eventual consistency in Google's
 * inspection service, not a page losing and regaining discovery. Recording it as
 * a dated transition fills the file with events that never happened.
 *
 * So a day is recorded when the STAGE moves. The two flapping values collapse
 * into one stage, because neither means the page has been crawled. Every other
 * value stays distinct, including the ones that report a problem (noindex,
 * blocked, 404, soft 404), so those earn a dated entry the moment they appear.
 *
 * QUOTA
 *
 * URL Inspection allows 2000 queries per day per property, so a sitemap of a few
 * dozen URLs on a daily deploy is nowhere near it. Pages are inspected in
 * sequence and no batching is needed.
 *
 * AUTH
 *
 * A service account, not OAuth: no consent screen to keep alive, the key sits in
 * a CI secret, and the scope is read only. The account must be added as a user
 * on the Search Console property. The JWT is signed with node:crypto rather than
 * pulling in googleapis, which is a large dependency for one signed assertion.
 *
 * CONFIGURATION (environment)
 *
 *   GOOGLE_SERVICE_ACCOUNT_JSON  required, the key file contents
 *   SC_PROPERTY                  required, e.g. sc-domain:example.com
 *   SITE_URL                     required, used to shorten paths in the log
 *   SITEMAP                      default dist/sitemap-0.xml
 *   STATE_FILE                   default data/index-history.json
 *
 * FAILURE POLICY
 *
 * Exits quietly without a key, swallows every API failure, never fails a deploy.
 * A page that fails to inspect is skipped rather than recorded as unknown,
 * because an inspection error is not a coverage state.
 */
import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const PROPERTY = process.env.SC_PROPERTY;
const SITE_URL = process.env.SITE_URL;
const SITEMAP = process.env.SITEMAP ?? 'dist/sitemap-0.xml';
const STATE_FILE = process.env.STATE_FILE ?? 'data/index-history.json';

if (!raw || !PROPERTY || !SITE_URL) {
  console.log('[index] GOOGLE_SERVICE_ACCOUNT_JSON, SC_PROPERTY or SITE_URL missing. Nothing pulled.');
  process.exit(0);
}

const base64url = (input) => Buffer.from(input).toString('base64url');

function assertion(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(creds.private_key, 'base64url')}`;
}

async function accessToken(creds) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion(creds),
    }),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function inspect(token, url) {
  const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ inspectionUrl: url, siteUrl: PROPERTY }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).inspectionResult?.indexStatusResult ?? {};
}

/**
 * The coarse state a URL is in. Collapses only the two values the inspection API
 * flaps between; everything else, including every problem state, stays distinct
 * so it earns its own dated entry.
 */
function stage(entry) {
  if (entry.indexed) return 'indexed';
  const c = entry.coverage;
  if (c === 'URL is unknown to Google' || c.startsWith('Discovered')) return 'awaiting crawl';
  return c;
}

function load() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let urls;
try {
  const xml = readFileSync(SITEMAP, 'utf8');
  urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
} catch {
  console.warn(`[index] no ${SITEMAP}. Run the build first. Nothing recorded.`);
  process.exit(0);
}

try {
  const token = await accessToken(JSON.parse(raw));
  const today = {};
  let failed = 0;

  for (const url of urls) {
    try {
      const r = await inspect(token, url);
      today[url] = {
        // PASS means on Google. Never infer this from coverageState, see above.
        indexed: r.verdict === 'PASS',
        coverage: r.coverageState ?? 'unknown',
        ...(r.lastCrawlTime ? { lastCrawl: r.lastCrawlTime.slice(0, 10) } : {}),
      };
    } catch (error) {
      console.warn(`[index] ${url} not inspected: ${error.message}`);
      failed += 1;
    }
  }

  const inspected = Object.keys(today);
  if (!inspected.length) {
    console.warn('[index] every inspection failed. Nothing recorded.');
    process.exit(0);
  }

  const indexed = inspected.filter((u) => today[u].indexed);
  console.log(`[index] ${indexed.length} of ${inspected.length} URLs indexed${failed ? `, ${failed} not inspected` : ''}`);
  for (const url of inspected) {
    const path = url.replace(SITE_URL, '') || '/';
    console.log(`  ${today[url].indexed ? 'IN ' : '   '}${path.padEnd(28)}${today[url].coverage}`);
  }

  const history = load();
  const days = Object.keys(history).sort();
  const last = days.length ? history[days[days.length - 1]] : null;

  const changes = inspected.filter((u) => !last?.pages?.[u] || stage(last.pages[u]) !== stage(today[u]));

  if (!changes.length) {
    console.log('[index] no stage change since the last recording. Nothing written.');
    process.exit(0);
  }

  for (const url of changes) {
    const path = url.replace(SITE_URL, '') || '/';
    const before = last?.pages?.[url] ? stage(last.pages[url]) : 'not recorded';
    console.log(`[index] MOVED ${path}: ${before} -> ${stage(today[url])}`);
  }

  const day = new Date().toISOString().slice(0, 10);
  history[day] = { indexed: indexed.length, total: inspected.length, pages: today };
  const ordered = Object.fromEntries(Object.keys(history).sort().map((d) => [d, history[d]]));
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(ordered, null, 1)}\n`);
  console.log(`[index] ${changes.length} change(s) recorded for ${day}.`);
} catch (error) {
  console.warn(`[index] failed, nothing recorded: ${error.message}`);
  process.exit(0);
}
