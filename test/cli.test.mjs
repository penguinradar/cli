import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.mjs';

const OK = {
  data: { items: [] },
  meta: {
    requestId: 'req_test',
    source: 'tracking_snapshot',
    asOf: '2026-10-11T09:00:00Z',
    creditsUsed: 0,
    warnings: [],
    hasMore: false,
    nextCursor: null,
  },
};

async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const result = await handler(requests.at(-1), requests.length);
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json', ...result.headers });
    res.end(JSON.stringify(result.payload ?? OK));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const outputs = { stdout: '', stderr: '' };
  const options = {
    env: {
      PENGUINRADAR_API_KEY: 'test-only-secret',
      PENGUINRADAR_API_URL: `http://127.0.0.1:${server.address().port}/open-api/v1`,
    },
    stdout: (v) => {
      outputs.stdout += v;
    },
    stderr: (v) => {
      outputs.stderr += v;
    },
    remember: async () => {},
  };
  return { requests, outputs, options };
}

test('five reads map to six-interface contract; auth status accepts an empty tracking list', async (t) => {
  const { requests, options } = await fixture(t, () => ({}));
  assert.equal(
    await run(['tracking', 'list', '--include-archived', '--limit', '25', '--json'], options),
    0,
  );
  assert.equal(await run(['account', '@ALICE', '--json'], options), 0);
  assert.equal(await run(['followers', 'alice', '--cursor', 'opaque+/=?', '--json'], options), 0);
  assert.equal(await run(['following', 'alice', '--json'], options), 0);
  assert.equal(
    await run(
      [
        'changes',
        'alice',
        '--list',
        'following',
        '--from',
        '2026-10-01',
        '--to',
        '2026-10-07',
        '--timezone',
        'UTC',
        '--json',
      ],
      options,
    ),
    0,
  );
  assert.equal(await run(['auth', 'status', '--json'], options), 0);
  assert.deepEqual(
    requests.map((r) => [r.method, r.url]),
    [
      ['GET', '/open-api/v1/tracking?limit=25&includeArchived=true'],
      ['GET', '/open-api/v1/accounts/alice'],
      ['GET', '/open-api/v1/accounts/alice/followers?cursor=opaque%2B%2F%3D%3F'],
      ['GET', '/open-api/v1/accounts/alice/following'],
      [
        'GET',
        '/open-api/v1/accounts/alice/changes?list=following&from=2026-10-01&to=2026-10-07&timezone=UTC',
      ],
      ['GET', '/open-api/v1/tracking?limit=1'],
    ],
  );
  assert(requests.every((r) => r.headers.authorization === 'Bearer test-only-secret'));
});

test('missing snapshot never triggers online collection or paging', async (t) => {
  const { requests, outputs, options } = await fixture(t, () => ({
    status: 404,
    payload: {
      error: { code: 'snapshot_unavailable', message: 'No snapshot.' },
      meta: { creditsUsed: 0 },
    },
  }));
  assert.equal(await run(['followers', 'alice', '--json'], options), 4);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(outputs.stdout, '');
  assert.equal(JSON.parse(outputs.stderr).error.code, 'snapshot_unavailable');
});

test('online query requires an explicit positive budget and rejects misleading flags before network', async (t) => {
  const { requests, options } = await fixture(t, () => ({}));
  for (const args of [
    ['followers', 'alice', '--live'],
    ['followers', 'alice', '--live', '--max-credits', '0'],
    ['followers', 'alice', '--live', '--max-credits', '2', '--limit', '25'],
    ['followers', 'alice', '--max-credits', '2'],
    ['account', 'alice', '--live', '--max-credits', '2', '--cursor', 'cursor'],
    ['changes', 'alice', '--from', '2026-02-30', '--to', '2026-03-01'],
  ])
    assert.equal(await run(args, options), 2);
  assert.equal(requests.length, 0);
});

test('online retries preserve exact body and idempotency key and never traverse next page', async (t) => {
  const result = {
    ...OK,
    meta: {
      ...OK.meta,
      source: 'live',
      creditsUsed: 2,
      hasMore: true,
      nextCursor: 'paid-next-page',
    },
  };
  const { requests, outputs, options } = await fixture(t, (_, n) =>
    n === 1
      ? {
          status: 409,
          headers: { 'Retry-After': '1' },
          payload: {
            error: { code: 'request_in_progress', message: 'Pending.' },
            meta: { creditsUsed: null },
          },
        }
      : { payload: result },
  );
  let time = 0;
  options.now = () => time;
  options.sleep = async (ms) => {
    time += ms;
  };
  assert.equal(
    await run(
      [
        'followers',
        'alice',
        '--live',
        '--max-credits',
        '2',
        '--idempotency-key',
        'stable-query-123',
        '--json',
      ],
      options,
    ),
    0,
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers['idempotency-key'], 'stable-query-123');
  assert.equal(requests[1].headers['idempotency-key'], 'stable-query-123');
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(JSON.parse(requests[0].body), {
    username: 'alice',
    type: 'followers',
    maxCredits: 2,
  });
  assert.deepEqual(JSON.parse(outputs.stdout), result);
});

test('unknown result stops immediately and exposes recovery key without leaking credential', async (t) => {
  const { requests, outputs, options } = await fixture(t, () => ({
    status: 409,
    payload: {
      error: { code: 'query_outcome_unknown', message: 'Preserve this query.' },
      meta: { creditsUsed: null },
    },
  }));
  assert.equal(
    await run(
      [
        'account',
        'alice',
        '--live',
        '--max-credits',
        '2',
        '--idempotency-key',
        'stable-unknown-123',
        '--json',
      ],
      options,
    ),
    5,
  );
  assert.equal(requests.length, 1);
  assert.match(outputs.stderr, /stable-unknown-123/);
  assert(!outputs.stderr.includes('test-only-secret'));
});

test('request-in-progress automatic restore is bounded to 60 seconds', async (t) => {
  const { requests, outputs, options } = await fixture(t, () => ({
    status: 409,
    headers: { 'Retry-After': '30' },
    payload: {
      error: { code: 'request_in_progress', message: 'Pending.' },
      meta: { creditsUsed: null },
    },
  }));
  let time = 0;
  options.now = () => time;
  options.sleep = async (ms) => {
    time += ms;
  };
  assert.equal(
    await run(
      [
        'following',
        'alice',
        '--live',
        '--max-credits',
        '2',
        '--idempotency-key',
        'stable-pending-123',
      ],
      options,
    ),
    5,
  );
  assert.equal(requests.length, 2);
  assert.equal(time, 30_000);
  assert.match(outputs.stderr, /60-second recovery window/);
});

test('recovery file stores parameters only and protects original body', async (t) => {
  const { requests, options } = await fixture(t, () => ({}));
  const state = await mkdtemp(join(tmpdir(), 'penguinradar-cli-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  options.env.XDG_STATE_HOME = state;
  delete options.remember;
  const args = [
    'account',
    'alice',
    '--live',
    '--max-credits',
    '2',
    '--idempotency-key',
    'stable-file-123',
    '--json',
  ];
  assert.equal(await run(args, options), 0);
  const path = join(state, 'penguinradar', (await readdir(join(state, 'penguinradar')))[0]);
  const content = await readFile(path, 'utf8');
  assert(!content.includes('test-only-secret'));
  assert.equal(JSON.parse(content).body.username, 'alice');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await run(['account', 'bob', ...args.slice(2)], options), 2);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).body.username, 'alice');
});

test('redirects are refused so bearer secrets cannot be forwarded', async (t) => {
  const { requests, options } = await fixture(t, () => ({
    status: 302,
    headers: { Location: 'https://example.com/stolen' },
  }));
  assert.equal(await run(['account', 'alice', '--json'], options), 1);
  assert.equal(requests.length, 1);
});

test('JSON auth login never prompts; non-macOS has environment-only credentials', async () => {
  let prompts = 0;
  const outputs = [];
  const options = {
    env: {},
    credentials: { read: async () => null },
    prompt: async () => {
      prompts++;
      return 'hidden';
    },
    stdout: () => {},
    stderr: (v) => outputs.push(v),
    platform: 'linux',
  };
  assert.equal(await run(['auth', 'login', '--json'], options), 3);
  assert.equal(prompts, 0);
  assert.equal(JSON.parse(outputs[0]).error.code, 'cli_error');
});

test('skill install copies the bundled Skill, refuses to overwrite, needs no credentials', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'isv-skill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const outputs = { stdout: '' };
  const options = { env: {}, home, cwd: home, stdout: (v) => (outputs.stdout += v), stderr: () => {} };
  assert.equal(await run(['skill', 'install', '--json'], options), 0);
  const skill = await readFile(join(home, '.agents/skills/penguinradar/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: penguinradar/);
  assert.equal(JSON.parse(outputs.stdout).path, join(home, '.agents/skills/penguinradar'));
  assert.equal(await run(['skill', 'install'], options), 2);
  assert.equal(await run(['skill', 'install', '--force'], options), 0);
  assert.equal(await run(['skill', 'install', '--target', 'claude', '--project'], options), 0);
  await stat(join(home, '.claude/skills/penguinradar/agents/openai.yaml'));
  assert.equal(await run(['skill', 'install', '--target', 'bad'], options), 2);
});

test('variables from before the rename still work (INSTORYVIEW_API_KEY / _API_URL)', async (t) => {
  const { requests, options } = await fixture(t, () => ({}));
  const legacy = {
    ...options,
    env: {
      INSTORYVIEW_API_KEY: options.env.PENGUINRADAR_API_KEY,
      INSTORYVIEW_API_URL: options.env.PENGUINRADAR_API_URL,
    },
  };
  assert.equal(await run(['auth', 'status', '--json'], legacy), 0);
  assert.equal(requests.at(-1).headers.authorization, 'Bearer test-only-secret');
});
