import { randomUUID, createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCredential, saveCredential, removeCredential } from './credentials.mjs';

const VERSION = '0.3.0';
const SKILL_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'skill');
const DEFAULT_URL = 'https://penguinradar.com/open-api/v1';
const HELP = `PenguinRadar ${VERSION} — existing data first; online queries require a budget.

Usage:
  penguinradar auth login|status|logout
  penguinradar skill install [--target agents|claude] [--project] [--dir PATH] [--force]
  penguinradar tracking list [--include-archived] [--limit N] [--cursor CURSOR]
  penguinradar account USERNAME
  penguinradar followers USERNAME [--limit N] [--cursor CURSOR]
  penguinradar following USERNAME [--limit N] [--cursor CURSOR]
  penguinradar changes USERNAME [--list followers|following]
    [--from YYYY-MM-DD --to YYYY-MM-DD] [--timezone TIMEZONE] [--limit N] [--cursor CURSOR]
  penguinradar account|followers|following USERNAME --live --max-credits N
    [--cursor CURSOR] [--idempotency-key KEY]

All commands accept --json. Reads never start collection or consume new collection credits.
Online queries return one page; no automatic paging. Recover the same request using its original key.
Credentials: PENGUINRADAR_API_KEY, or macOS System Keychain via auth login.
Exit codes: 0 success, 1 service/network, 2 arguments, 3 auth/permission,
            4 unavailable data, 5 budget or pending result.
`;

class CliError extends Error {
  constructor(message, exitCode = 2, payload) {
    super(message);
    this.exitCode = exitCode;
    this.payload = payload;
  }
}

const VALUE_FLAGS = new Set([
  'limit',
  'cursor',
  'list',
  'from',
  'to',
  'timezone',
  'max-credits',
  'idempotency-key',
  'target',
  'dir',
]);
const BOOLEAN_FLAGS = new Set(['json', 'live', 'include-archived', 'help', 'version', 'project', 'force']);

function parse(args) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const equal = arg.indexOf('=');
    const name = arg.slice(2, equal < 0 ? undefined : equal);
    if (Object.hasOwn(flags, name)) throw new CliError(`Duplicate --${name}.`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (equal >= 0) throw new CliError(`--${name} does not take a value.`);
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
      if (!value || value.startsWith('--')) throw new CliError(`--${name} requires a value.`);
      flags[name] = value;
    } else throw new CliError(`Unknown option --${name}.`);
  }
  return { flags, positionals };
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > maximum)
    throw new CliError(`--${name} must be an integer from 1 to ${maximum}.`);
  return Number(value);
}

function baseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('PENGUINRADAR_API_URL must be an absolute HTTPS URL.');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new CliError(
      'Use HTTPS without URL credentials, query, or fragment (HTTP is allowed only for localhost).',
    );
  return url.href.replace(/\/$/, '');
}

function buildRequest(positionals, flags) {
  const [command, operand] = positionals;
  if (positionals.length !== 2)
    throw new CliError('Provide a command and username (or tracking list). See --help.');
  const username = operand.replace(/^@/, '').toLowerCase();
  if (command !== 'tracking' && !/^[a-z0-9._]{1,30}$/.test(username))
    throw new CliError('Provide an Instagram username, not a URL.');
  const reads = ['account', 'followers', 'following', 'changes'];
  if (!(command === 'tracking' && operand === 'list') && !reads.includes(command))
    throw new CliError('Unknown command. See --help.');
  const allowed = new Set(['json', 'help', 'version', 'project', 'force']);
  if (flags.live) {
    if (!['account', 'followers', 'following'].includes(command))
      throw new CliError('--live is supported only for account, followers, and following.');
    for (const flag of ['live', 'max-credits', 'idempotency-key']) allowed.add(flag);
    if (command !== 'account') allowed.add('cursor');
  } else {
    if (command !== 'account') {
      allowed.add('limit');
      allowed.add('cursor');
    }
    if (command === 'tracking') allowed.add('include-archived');
    if (command === 'changes')
      for (const flag of ['list', 'from', 'to', 'timezone']) allowed.add(flag);
  }
  for (const flag of Object.keys(flags))
    if (!allowed.has(flag))
      throw new CliError(
        `--${flag} is not supported for this command${flag === 'max-credits' ? '; add --live to explicitly request collection' : ''}.`,
      );
  if (flags.live) {
    const body = {
      username,
      type: command === 'account' ? 'profile' : command,
      maxCredits: positiveInteger(flags['max-credits'], 'max-credits'),
    };
    if (flags.cursor) body.cursor = flags.cursor;
    const key = flags['idempotency-key'] ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
      throw new CliError(
        '--idempotency-key must contain 8–128 letters, numbers, dots, underscores, colons, or hyphens.',
      );
    return { path: '/queries', method: 'POST', body, key };
  }
  const query = new URLSearchParams();
  if (flags.limit) query.set('limit', String(positiveInteger(flags.limit, 'limit', 100)));
  if (flags.cursor) query.set('cursor', flags.cursor);
  if (flags['include-archived']) query.set('includeArchived', 'true');
  if (command === 'changes') {
    if (flags.list && !['followers', 'following'].includes(flags.list))
      throw new CliError('--list must be followers or following.');
    if (Boolean(flags.from) !== Boolean(flags.to))
      throw new CliError('--from and --to must be provided together.');
    for (const name of ['from', 'to']) {
      if (!flags[name]) continue;
      const date = new Date(`${flags[name]}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(flags[name]) ||
        Number.isNaN(date.valueOf()) ||
        date.toISOString().slice(0, 10) !== flags[name]
      )
        throw new CliError(`--${name} must be a valid YYYY-MM-DD date.`);
    }
    if (flags.from && flags.from > flags.to) throw new CliError('--from must not be after --to.');
    if (flags.timezone)
      try {
        new Intl.DateTimeFormat('en', { timeZone: flags.timezone });
      } catch {
        throw new CliError('Invalid --timezone.');
      }
    for (const name of ['list', 'from', 'to', 'timezone'])
      if (flags[name]) query.set(name, flags[name]);
  }
  const path =
    command === 'tracking'
      ? '/tracking'
      : `/accounts/${encodeURIComponent(username)}${command === 'account' ? '' : `/${command}`}`;
  return { path: `${path}${query.size ? `?${query}` : ''}`, method: 'GET' };
}

function apiExitCode(status, code) {
  if (status === 401 || status === 403) return 3;
  if (
    status === 402 ||
    ['request_in_progress', 'query_outcome_unknown', 'result_expired'].includes(code)
  )
    return 5;
  if (status === 404 || status === 410) return 4;
  if (status === 400 || code === 'idempotency_conflict') return 2;
  return 1;
}

async function rememberQuery(request, url, env) {
  const root = join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'penguinradar');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const name = createHash('sha256').update(`${url}\0${request.key}`).digest('hex');
  // Contains recovery parameters only. No credential or server response is stored.
  const path = join(root, `query-${name}.json`);
  try {
    await writeFile(
      path,
      `${JSON.stringify({ apiUrl: url, idempotencyKey: request.key, body: request.body, createdAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const original = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(original.body) !== JSON.stringify(request.body))
      throw new CliError(
        'This idempotency key was already used with different parameters. Restore the original request.',
        2,
      );
  }
}

function retryDelay(header, now) {
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(100, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? 1000 : Math.max(100, date - now);
}

async function requestApi(request, url, key, io) {
  const started = io.now();
  const deadline = started + 60_000;
  let lastPayload;
  do {
    let response;
    try {
      response = await io.fetch(`${url}${request.path}`, {
        method: request.method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          ...(request.method === 'POST'
            ? { 'Content-Type': 'application/json', 'Idempotency-Key': request.key }
            : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(Math.min(15_000, Math.max(1, deadline - io.now()))),
      });
    } catch {
      throw new CliError(
        request.method === 'POST'
          ? 'Network response unavailable. The query may have run; preserve the original idempotency key and restore the same request.'
          : 'Network request failed. Check the connection and API URL.',
        request.method === 'POST' ? 5 : 1,
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new CliError(
        'The API returned a non-JSON response. Preserve the query key if this was an online request.',
        request.method === 'POST' ? 5 : 1,
      );
    }
    if (response.ok) {
      if (!payload || !Object.hasOwn(payload, 'data') || !Object.hasOwn(payload, 'meta'))
        throw new CliError('The API returned an unsupported response structure.', 1);
      return payload;
    }
    const code = payload?.error?.code;
    lastPayload = payload;
    if (request.method === 'POST' && response.status === 409 && code === 'request_in_progress') {
      const delay = retryDelay(response.headers.get('Retry-After'), io.now());
      if (io.now() + delay >= deadline) break;
      io.stderr('Query is still in progress; restoring the same request.\n');
      await io.sleep(delay);
      continue;
    }
    throw new CliError(
      payload?.error?.message || `API request failed (${response.status}).`,
      apiExitCode(response.status, code),
      payload,
    );
  } while (io.now() < deadline);
  throw new CliError(
    'Query is still pending after the 60-second recovery window. Restore manually using the original idempotency key.',
    5,
    lastPayload,
  );
}

async function hiddenPrompt(io) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new CliError('Use PENGUINRADAR_API_KEY in a non-interactive terminal.', 3);
  io.stderr('Create an API Key at https://penguinradar.com/developers/keys\nAPI Key (hidden): ');
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      io.stderr('\n');
    };
    const onData = (chunk) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') {
          cleanup();
          reject(new CliError('Login cancelled.', 3));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

function render(payload) {
  const { data, meta } = payload;
  const rows = data?.items;
  let answer;
  if (Array.isArray(rows)) {
    answer = rows.length
      ? rows
          .map((item) => {
            if (item.kind)
              return `${item.detectedAt ?? 'unknown time'}  ${item.kind}  @${item.account?.username ?? item.account?.id ?? 'unknown'}`;
            return `@${item.username ?? item.id ?? 'unknown'}${item.fullName ? `  ${item.fullName}` : ''}${item.status ? `  ${item.status}  followers: ${item.followerCount ?? 'unknown'}  profile as of: ${item.profileAsOf ?? 'unknown'}  followers snapshot: ${item.listSnapshots?.followers ?? 'unavailable'}  following snapshot: ${item.listSnapshots?.following ?? 'unavailable'}` : ''}`;
          })
          .join('\n')
      : 'No items in this page.';
    if (Object.hasOwn(data, 'returnedCount'))
      answer += `\nReturned: ${data.returnedCount}; available in this data source: ${data.availableCount ?? 'unknown'}.`;
    if (data.summary)
      answer += `\nDetected: +${data.summary.added ?? 'unknown'} / -${data.summary.removed ?? 'unknown'}; count change: ${data.summary.countNetChange ?? 'unknown'}.`;
  } else
    answer = `@${data?.username ?? 'unknown'}${data?.fullName ? `  ${data.fullName}` : ''}\nFollowers: ${data?.followerCount ?? 'unknown'}; following: ${data?.followingCount ?? 'unknown'}.`;
  answer += `\nSource: ${meta.source ?? 'unknown'}; as of: ${meta.asOf ?? 'see item timestamps'}; credits: ${meta.creditsUsed ?? 'pending'}.`;
  if (meta.coverage)
    answer += `\nCoverage: ${meta.coverage}. This may not include every account on Instagram's list: it is what PenguinRadar could observe, and a page is not the Instagram total.`;
  if (meta.warnings?.length) answer += `\nWarnings: ${meta.warnings.join(', ')}.`;
  if (meta.nextCursor) answer += `\nNext cursor: ${meta.nextCursor}`;
  return `${answer}\n`;
}

async function installSkill(positionals, flags, io, json) {
  const allowed = new Set(['json', 'target', 'project', 'dir', 'force']);
  if (
    positionals.length !== 2 ||
    positionals[1] !== 'install' ||
    Object.keys(flags).some((flag) => !allowed.has(flag))
  )
    throw new CliError('Use skill install [--target agents|claude] [--project] [--dir PATH] [--force].');
  const target = flags.target ?? 'agents';
  if (!['agents', 'claude'].includes(target)) throw new CliError('--target must be agents or claude.');
  if (flags.dir !== undefined && (flags.project || flags.target))
    throw new CliError('--dir cannot be combined with --project or --target.');
  const folder = target === 'claude' ? '.claude' : '.agents';
  const root = flags.dir
    ? resolve(flags.dir)
    : join(flags.project ? io.cwd : io.home, folder, 'skills');
  const destination = join(root, 'penguinradar');
  const exists = await stat(destination).then(
    () => true,
    () => false,
  );
  if (exists && !flags.force)
    throw new CliError(
      `${destination} already exists. Compare it with your copy, then rerun with --force to replace it.`,
    );
  await mkdir(root, { recursive: true });
  await cp(SKILL_SOURCE, destination, { recursive: true, force: true });
  const result = { installed: true, version: VERSION, path: destination };
  io.stdout(
    json
      ? `${JSON.stringify(result)}\n`
      : `Installed the PenguinRadar Skill at ${destination}.\nRestart your assistant if it does not list the Skill yet. The Skill contains no credentials; connect with MCP or run penguinradar auth login.\n`,
  );
  return 0;
}

/**
 * The CLI was published as `instoryview` before the PenguinRadar rename (2026-10-17): keep reading
 * the old variable names, so scripts and secret managers set up for it keep working.
 */
function withLegacyEnv(env) {
  const out = { ...env };
  for (const name of ['API_KEY', 'API_URL']) {
    if (out[`PENGUINRADAR_${name}`] === undefined && out[`INSTORYVIEW_${name}`] !== undefined)
      out[`PENGUINRADAR_${name}`] = out[`INSTORYVIEW_${name}`];
  }
  return out;
}

export async function run(args, options = {}) {
  const io = {
    env: withLegacyEnv(options.env ?? process.env),
    stdout: options.stdout ?? ((text) => process.stdout.write(text)),
    stderr: options.stderr ?? ((text) => process.stderr.write(text)),
    fetch: options.fetch ?? globalThis.fetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: options.now ?? Date.now,
    credentials: options.credentials ?? {
      read: readCredential,
      save: saveCredential,
      remove: removeCredential,
    },
    remember: options.remember ?? rememberQuery,
    prompt: options.prompt ?? hiddenPrompt,
    platform: options.platform ?? process.platform,
    home: options.home ?? homedir(),
    cwd: options.cwd ?? process.cwd(),
  };
  let json = args.includes('--json');
  try {
    const { flags, positionals } = parse(args);
    json = Boolean(flags.json);
    if (flags.version) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (flags.help || !args.length) {
      io.stdout(HELP);
      return 0;
    }
    if (positionals[0] === 'skill') return await installSkill(positionals, flags, io, json);
    const url = baseUrl(io.env.PENGUINRADAR_API_URL ?? DEFAULT_URL);
    if (positionals[0] === 'auth') {
      if (
        positionals.length !== 2 ||
        !['login', 'status', 'logout'].includes(positionals[1]) ||
        Object.keys(flags).some((flag) => flag !== 'json')
      )
        throw new CliError('Use auth login, auth status, or auth logout, optionally with --json.');
      const operation = positionals[1];
      if (operation === 'logout') {
        await io.credentials.remove(url);
        const result = {
          authenticated: Boolean(io.env.PENGUINRADAR_API_KEY),
          environmentCredential: Boolean(io.env.PENGUINRADAR_API_KEY),
          message: io.env.PENGUINRADAR_API_KEY
            ? 'Local Keychain credential removed. Unset PENGUINRADAR_API_KEY to remove the active environment credential.'
            : 'Local credential removed. Revoke the Key on the website to disable it on other devices.',
        };
        io.stdout(json ? `${JSON.stringify(result)}\n` : `${result.message}\n`);
        return 0;
      }
      let key = await io.credentials.read(url, io.env);
      if (!key && operation === 'login') {
        if (json || io.platform !== 'darwin')
          throw new CliError(
            'Set PENGUINRADAR_API_KEY using your environment or secret manager. Interactive Keychain login requires macOS.',
            3,
          );
        key = await io.prompt(io);
      }
      if (!key)
        throw new CliError(
          'No credential found. Run auth login on macOS or set PENGUINRADAR_API_KEY using your secret manager.',
          3,
        );
      await requestApi({ path: '/tracking?limit=1', method: 'GET' }, url, key, io);
      if (operation === 'login' && !io.env.PENGUINRADAR_API_KEY) await io.credentials.save(url, key);
      const result = {
        authenticated: true,
        apiUrl: url,
        credentialStorage: io.env.PENGUINRADAR_API_KEY ? 'environment' : 'system_keychain',
      };
      io.stdout(
        json ? `${JSON.stringify(result)}\n` : `Authenticated (${result.credentialStorage}).\n`,
      );
      return 0;
    }
    // Validate commands and budget before reading a credential or making any request.
    const request = buildRequest(positionals, flags);
    const key = await io.credentials.read(url, io.env);
    if (!key)
      throw new CliError('No credential found. Run auth login or set PENGUINRADAR_API_KEY.', 3);
    if (request.method === 'POST') {
      await io.remember(request, url, io.env);
      const command = positionals[0];
      io.stderr(
        `Online query: max ${request.body.maxCredits} credits; idempotency key: ${request.key}\nRestore: penguinradar ${command} ${request.body.username} --live --max-credits ${request.body.maxCredits} --idempotency-key ${request.key}${request.body.cursor ? ` --cursor '${request.body.cursor.replaceAll("'", "'\\''")}'` : ''} --json\n`,
      );
    }
    const payload = await requestApi(request, url, key, io);
    io.stdout(json ? `${JSON.stringify(payload)}\n` : render(payload));
    return 0;
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    if (json)
      io.stderr(
        `${JSON.stringify(error.payload ?? { error: { code: exitCode === 2 ? 'invalid_arguments' : 'cli_error', message: error.message }, meta: {} })}\n`,
      );
    else
      io.stderr(
        `${error.payload?.error?.code ? `${error.payload.error.code}: ` : ''}${error.message}${error.payload?.meta?.requestId ? ` (request ${error.payload.meta.requestId})` : ''}\n`,
      );
    return exitCode;
  }
}
