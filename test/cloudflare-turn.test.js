// Cloudflare's managed TURN is reached over the network, so these tests stand
// in for their API. What matters is that /config never breaks because of it,
// and that a public endpoint cannot be used to burn the account's API quota.
process.env.CLOUDFLARE_TURN_KEY_ID = 'test-key-id';
process.env.CLOUDFLARE_TURN_API_TOKEN = 'test-token';
process.env.CLOUDFLARE_TURN_TTL_SECONDS = '600';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const { server, stop } = require('../server');

let baseUrl;
const calls = [];
let respond;

const realFetch = globalThis.fetch;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, options) => {
    if (typeof url === 'string' && url.includes('rtc.live.cloudflare.com')) {
      calls.push({ url, options });
      return respond();
    }
    return realFetch(url, options);
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  await stop();
});

beforeEach(() => {
  calls.length = 0;
});

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// The documented shape of POST .../credentials/generate-ice-servers
const CREDENTIALS = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'cf-user',
      credential: 'cf-secret',
    },
  ],
};

function turnEntries(body) {
  return body.iceServers.filter((s) => String(s.urls).includes('turn'));
}

test('credentials from the API are served to clients', async () => {
  respond = () => jsonResponse(CREDENTIALS);
  const body = await (await fetch(`${baseUrl}/config`)).json();

  const cf = turnEntries(body).find((s) => String(s.urls).includes('cloudflare'));
  assert.ok(cf, 'the Cloudflare relay must reach the client');
  assert.strictEqual(cf.username, 'cf-user');
  assert.strictEqual(cf.credential, 'cf-secret');

  const sent = JSON.parse(calls[0].options.body);
  assert.strictEqual(sent.ttl, 600);
  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.ok(calls[0].url.includes('test-key-id'));
  assert.ok(
    calls[0].url.endsWith('/credentials/generate-ice-servers'),
    `wrong endpoint: ${calls[0].url}`
  );

  // Their STUN comes along too — port 53 gets through networks that block 3478
  assert.ok(body.iceServers.some((s) => String(s.urls).includes('stun.cloudflare.com:53')));
});

test('repeated requests reuse one set of credentials', async () => {
  // /config is public and unauthenticated: without caching, refreshing the
  // page in a loop would spend the account's API quota.
  respond = () => jsonResponse(CREDENTIALS);
  await Promise.all(Array.from({ length: 25 }, () => fetch(`${baseUrl}/config`)));
  assert.strictEqual(calls.length, 0, 'the credentials cached by the first test are still valid');
});

test('an API failure leaves the rest of the config intact', async () => {
  const { __testing } = require('../server');
  __testing.resetCloudflareCache();
  respond = () => jsonResponse({ error: 'nope' }, 500);

  const res = await fetch(`${baseUrl}/config`);
  assert.strictEqual(res.status, 200, '/config must not fail because their API did');
  const body = await res.json();
  assert.strictEqual(calls.length, 1, 'the failure path really was exercised');
  assert.ok(body.iceServers.some((s) => String(s.urls).includes('stun:')), 'STUN still served');
  assert.strictEqual(turnEntries(body).length, 0, 'no half-formed relay entry is served');
  assert.ok(Number.isInteger(body.maxParticipants));
});

test('a failing API is not retried on every request', async () => {
  // Their outage must not become one outbound request per visitor.
  const { __testing } = require('../server');
  __testing.resetCloudflareCache();
  respond = () => jsonResponse({ error: 'nope' }, 500);

  await fetch(`${baseUrl}/config`);
  assert.strictEqual(calls.length, 1);
  await Promise.all(Array.from({ length: 10 }, () => fetch(`${baseUrl}/config`)));
  assert.strictEqual(calls.length, 1, 'the backoff held');
});

test('credentials already in hand survive a later API failure', async () => {
  // Stale relay credentials still connect calls; nothing does not.
  const { __testing } = require('../server');
  __testing.resetCloudflareCache();
  respond = () => jsonResponse(CREDENTIALS);
  await fetch(`${baseUrl}/config`);

  __testing.resetCloudflareCache(true);
  respond = () => jsonResponse({ error: 'gone' }, 503);
  const body = await (await fetch(`${baseUrl}/config`)).json();

  const cf = turnEntries(body).find((s) => String(s.urls).includes('cloudflare'));
  assert.ok(cf, 'the previous credentials are still offered');
  assert.strictEqual(cf.username, 'cf-user');
});

test('a burst of joins produces a single API call', async () => {
  const { __testing } = require('../server');
  __testing.resetCloudflareCache();
  let inflight = 0;
  let maxConcurrent = 0;
  respond = async () => {
    inflight += 1;
    maxConcurrent = Math.max(maxConcurrent, inflight);
    await new Promise((r) => setTimeout(r, 40));
    inflight -= 1;
    return jsonResponse(CREDENTIALS);
  };

  await Promise.all(Array.from({ length: 20 }, () => fetch(`${baseUrl}/config`)));
  assert.strictEqual(calls.length, 1, 'concurrent requests coalesced into one');
  assert.strictEqual(maxConcurrent, 1);
});

test('an unrecognised response shape is rejected rather than served', async () => {
  const { __testing } = require('../server');
  assert.strictEqual(__testing.normalizeCloudflareResponse({ nonsense: true }), null);
  assert.strictEqual(__testing.normalizeCloudflareResponse({ iceServers: { urls: ['turn:x'] } }), null,
    'no username/credential means no usable relay');
});

test('both documented response shapes are understood', async () => {
  const { __testing } = require('../server');

  const documented = __testing.normalizeCloudflareResponse(CREDENTIALS);
  assert.strictEqual(documented.length, 2, 'STUN and TURN entries both kept');
  assert.strictEqual(documented.find((s) => s.username).username, 'cf-user');

  // An older shape returned the TURN entry on its own, not in an array
  const bare = __testing.normalizeCloudflareResponse({
    iceServers: { urls: 'turn:one', username: 'u', credential: 'c' },
  });
  assert.deepStrictEqual(bare, [{ urls: ['turn:one'], username: 'u', credential: 'c' }]);

  const snakeCase = __testing.normalizeCloudflareResponse({
    ice_servers: [{ urls: ['turn:two'], username: 'u2', credential: 'c2' }],
  });
  assert.strictEqual(snakeCase[0].username, 'u2');
});

test('a response carrying only STUN is refused — it is not a relay', async () => {
  const { __testing } = require('../server');
  assert.strictEqual(
    __testing.normalizeCloudflareResponse({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }),
    null
  );
});
