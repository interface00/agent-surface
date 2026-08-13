/**
 * Exercises the negotiator against a fake asset server, because both bugs this
 * code carries scar tissue from were only visible at request time: the trailing
 * slash redirect, and a 404 that came back as HTML with a 200.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNegotiator } from '../src/negotiate.mjs';

/** Fake env.ASSETS. `pages` maps a pathname to [status, contentType, body]. */
function envWith(pages) {
  return {
    ASSETS: {
      async fetch(input) {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const hit = pages[url.pathname];
        if (!hit) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
        const [status, type, body] = hit;
        return new Response(body, { status, headers: { 'content-type': type } });
      },
    },
  };
}

const negotiator = createNegotiator({
  siteUrl: 'https://example.com',
  markdownPath: (p) => `${p}.md`,
  notFoundIndex: 'https://example.com/llms.txt',
});

const get = (path, headers, env) =>
  negotiator.onRequestGet({ request: new Request(`https://example.com${path}`, { headers }), env });

test('a human gets the html asset and a Vary header', async () => {
  const env = envWith({ '/app/thing/': [200, 'text/html', '<h1>Thing</h1>'] });
  const res = await get('/app/thing', { 'user-agent': 'Chrome/120' }, env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>Thing</h1>');
  assert.equal(res.headers.get('Vary'), 'Accept, User-Agent');
});

test('the html path asks for the trailing slash form, avoiding a redirect hop', async () => {
  // Only /app/thing/ exists. A negotiator that forwarded /app/thing unchanged
  // would 404 here, which is exactly what a 308 redirect would have masked in
  // production while costing a hop on every crawl.
  const env = envWith({ '/app/thing/': [200, 'text/html', 'ok'] });
  const res = await get('/app/thing', { 'user-agent': 'Chrome/120' }, env);
  assert.equal(res.status, 200);
});

test('an AI agent gets the markdown twin', async () => {
  const env = envWith({ '/app/thing.md': [200, 'text/markdown', '# Thing'] });
  const res = await get('/app/thing', { 'user-agent': 'ChatGPT-User/1.0' }, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await res.text(), '# Thing');
});

test('the markdown response points at the html address as canonical', async () => {
  const env = envWith({ '/app/thing.md': [200, 'text/markdown', '# Thing'] });
  const res = await get('/app/thing', { 'user-agent': 'ClaudeBot/1.0' }, env);
  assert.equal(res.headers.get('link'), '<https://example.com/app/thing>; rel="canonical"');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
});

test('the .md address serves markdown to anyone, including a browser', async () => {
  const env = envWith({ '/app/thing.md': [200, 'text/markdown', '# Thing'] });
  const res = await get('/app/thing.md', { 'user-agent': 'Chrome/120' }, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
});

test('a missing twin returns a markdown 404, not the site index', async () => {
  const env = envWith({});
  const res = await get('/app/nope', { 'user-agent': 'ChatGPT-User/1.0' }, env);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /^# 404/);
});

test('an html body under a 200 is refused rather than mislabelled', async () => {
  // The real bug: with no 404 page in the build, the asset server answered every
  // unmatched path with index.html and a 200. `ok` passed and an agent was told
  // a page of HTML was Markdown.
  const env = envWith({ '/app/nope.md': [200, 'text/html', '<!doctype html><h1>Home</h1>'] });
  const res = await get('/app/nope', { 'user-agent': 'ChatGPT-User/1.0' }, env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
});

test('a ranking crawler never reaches the markdown branch', async () => {
  const env = envWith({
    '/app/thing/': [200, 'text/html', '<h1>Thing</h1>'],
    '/app/thing.md': [200, 'text/markdown', '# Thing'],
  });
  const res = await get('/app/thing', { 'user-agent': 'Googlebot/2.1' }, env);
  assert.equal(await res.text(), '<h1>Thing</h1>');
});

test('HEAD mirrors GET status and headers with no body', async () => {
  const env = envWith({ '/app/thing.md': [200, 'text/markdown', '# Thing'] });
  const res = await negotiator.onRequestHead({
    request: new Request('https://example.com/app/thing', { headers: { 'user-agent': 'GPTBot/1.2' } }),
    env,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await res.text(), '');
});

test('bad configuration fails at construction, not at request time', () => {
  assert.throws(() => createNegotiator({ siteUrl: 'https://example.com/', markdownPath: (p) => p }));
  assert.throws(() => createNegotiator({ siteUrl: 'https://example.com' }));
});
