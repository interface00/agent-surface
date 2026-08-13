/**
 * The tests that matter are the ones that fail loudly if someone widens the
 * negotiation by accident. A bug here does not produce a wrong page, it produces
 * a cloaking violation, and the penalty for that is removal from an index rather
 * than a ranking adjustment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgent, prefersMarkdown, shouldServeMarkdown, _lists } from '../src/agents.mjs';

const headers = (o) => new Headers(o);

test('ranking crawlers are never negotiated', () => {
  const crawlers = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)',
    'Mozilla/5.0 (compatible; YandexBot/3.0)',
    'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
    'Mozilla/5.0 (compatible; Baiduspider/2.0)',
  ];
  for (const ua of crawlers) {
    assert.equal(classifyAgent(ua), 'index-crawler', ua);
    assert.equal(shouldServeMarkdown(headers({ 'user-agent': ua })), false, ua);
  }
});

test('a ranking crawler asking for markdown still gets html', () => {
  // The check order is the safety property. If this ever passes, the cloaking
  // rule has been inverted.
  const h = headers({ 'user-agent': 'Googlebot/2.1', accept: 'text/markdown' });
  assert.equal(shouldServeMarkdown(h), false);
});

test('retrieval agents get markdown', () => {
  const agents = [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
    'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  ];
  for (const ua of agents) {
    assert.equal(classifyAgent(ua), 'llm-agent', ua);
    assert.equal(shouldServeMarkdown(headers({ 'user-agent': ua })), true, ua);
  }
});

test('Applebot-Extended resolves to the AI variant, not to Applebot', () => {
  // The plain `applebot` substring would swallow this if order changed. Apple
  // uses the two names for opposite purposes, so getting it wrong sends HTML to
  // the AI reader and Markdown to nobody.
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; Applebot-Extended/0.1)'), 'llm-agent');
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; Applebot/0.1)'), 'index-crawler');
});

test('a browser is a human and gets html', () => {
  const ua =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
  const accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  assert.equal(classifyAgent(ua), 'human');
  assert.equal(shouldServeMarkdown(headers({ 'user-agent': ua, accept })), false);
});

test('a wildcard Accept is not an opt in', () => {
  // curl sends */*. Treating that as a request for Markdown would hand it to
  // anyone who forgot a header.
  assert.equal(prefersMarkdown('*/*'), false);
  assert.equal(shouldServeMarkdown(headers({ 'user-agent': 'curl/8.4.0', accept: '*/*' })), false);
});

test('an explicit markdown Accept opts in, with no user agent at all', () => {
  assert.equal(prefersMarkdown('text/markdown'), true);
  assert.equal(prefersMarkdown('text/x-markdown'), true);
  assert.equal(shouldServeMarkdown(headers({ accept: 'text/markdown' })), true);
});

test('Accept listing both html and markdown gets html', () => {
  assert.equal(prefersMarkdown('text/html, text/markdown'), false);
});

test('a missing user agent is a human, not an agent', () => {
  assert.equal(classifyAgent(null), 'human');
  assert.equal(classifyAgent(undefined), 'human');
  assert.equal(classifyAgent(''), 'human');
});

test('an unknown bot falls through to html', () => {
  assert.equal(classifyAgent('SomeNewBot/1.0'), 'human');
  assert.equal(shouldServeMarkdown(headers({ 'user-agent': 'SomeNewBot/1.0' })), false);
});

test('no name appears in both lists', () => {
  // Except the documented applebot prefix relationship, which is handled by an
  // explicit early return rather than by list membership.
  const overlap = _lists.LLM_AGENTS.filter((a) => _lists.INDEX_CRAWLERS.includes(a));
  assert.deepEqual(overlap, []);
});
