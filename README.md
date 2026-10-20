# PenguinRadar CLI

[![npm](https://img.shields.io/npm/v/penguinradar)](https://www.npmjs.com/package/penguinradar) [![node](https://img.shields.io/node/v/penguinradar)](https://nodejs.org)

**The official command line for [PenguinRadar](https://penguinradar.com), an Instagram follower and following tracker.** Read the accounts you track, their retained follower and following snapshots, and the changes PenguinRadar has detected, from a terminal, a script or an AI coding assistant. It is a thin client for the [PenguinRadar Open API](https://penguinradar.com/docs/reference).

## What it does

- Lists the Instagram accounts you track and reads an account's profile totals.
- Reads retained **follower** and **following** lists, one page at a time.
- Reads **detected changes**: new followers, lost followers, new following and unfollowed accounts, for a date range and time zone you choose.
- Runs an explicitly budgeted **online lookup** of a public account when you ask for one (`--live --max-credits N`). It never fetches more than one page and never starts tracking.
- Prints machine-readable JSON (`--json`) with the API's `data` and `meta`, stable exit codes and recovery commands, so it is safe in scripts and agent workflows.
- Installs the [PenguinRadar Skill](https://github.com/penguinradar/skill) for Claude Code, Codex, Cursor and other assistants (`penguinradar skill install`).

## Requirements

Node.js 20 or newer, and an API Key from [Developer settings](https://penguinradar.com/settings/developers). You can also run it without installing: `npx penguinradar tracking list`.

## Quick start

```bash
npm install --global penguinradar
penguinradar --version
penguinradar auth login
penguinradar skill install   # optional: install the assistant Skill
penguinradar tracking list
penguinradar followers alice --json
```

`auth login` stores a verified Key in the macOS System Keychain. Linux, Windows, containers, and CI use `PENGUINRADAR_API_KEY` from their environment or secret manager. No plaintext credential file is created. `auth status` validates an existing credential through the tracking read endpoint. `auth logout` deletes the local Keychain credential; unset environment credentials separately and revoke the Key on the website to disable it everywhere.

`skill install` copies the bundled Skill to `~/.agents/skills/penguinradar` (`--target claude` for `~/.claude/skills`, `--project` for the current directory, `--dir PATH` for anywhere) and refuses to overwrite an existing copy unless you pass `--force`. It needs no credentials.

Read commands: `tracking list`, `account USERNAME`, `followers USERNAME`, `following USERNAME`, and `changes USERNAME`. These only read existing data. Missing data does not trigger a paid collection. Lists return one page; pass `--cursor` explicitly to request another. `tracking list --include-archived` includes retained archived records. Changes default to the last seven calendar days in UTC; use paired `--from` / `--to`, `--timezone`, and `--list following` when needed.

```bash
penguinradar changes alice --from 2026-10-01 --to 2026-10-07 --timezone UTC --json
penguinradar followers bob --live --max-credits 2 --json
```

An online command requires both `--live` and a positive `--max-credits`, plus a Key with online-query permission. It never starts continuous tracking. Each page is a separate budgeted request. The CLI prints a recovery command and saves only its parameters and idempotency key under `${XDG_STATE_HOME:-~/.local/state}/penguinradar/`, with private permissions. `request_in_progress` recovery uses the same body and key for at most 60 seconds. Unknown results and network failures stop with recovery instructions; never retry them with a new key unless you explicitly intend a new paid query.

Successful `--json` output is the API's unmodified `{data, meta}` envelope on stdout. Progress and errors go to stderr. Exit codes: `0` success, `1` network/service, `2` invalid arguments, `3` auth/permission, `4` unavailable data, `5` budget or pending result. Data timestamps and partial coverage matter: returned page size is not the full Instagram follower count, and change detection time is not the exact action time.

Set `PENGUINRADAR_API_URL` only when deliberately connecting to another environment. It defaults to `https://penguinradar.com/open-api/v1`; HTTPS is required except for loopback development URLs. Stored Keychain credentials are scoped to the API URL. Redirects are refused. Run `penguinradar --help` for all options.

To update, run `npm install --global penguinradar@latest`. To uninstall, run `npm uninstall --global penguinradar`.


## FAQ

**Is this an Instagram tool that needs my Instagram password?** No. It talks only to PenguinRadar with an PenguinRadar API Key. It never asks for, stores or transmits an Instagram login.

**Does it show exactly when someone followed or unfollowed?** No. Instagram does not publish follow timestamps. PenguinRadar reports when a change was *detected* between two scans, which is not the exact time it happened. A scan with no detected change is not proof that nothing happened.

**Does a read cost credits?** Reading existing data (`tracking list`, `account`, `followers`, `following`, `changes`) uses stored data and starts no collection. Only `--live` online lookups spend credits, always within the `--max-credits` you set.

**Can it fetch every follower of any account?** No. Each command returns one page; online lookups are one budgeted page each. Instagram lists can also be partial, so the CLI shows `coverage` and `warnings` instead of claiming completeness.

**Where is my Key stored?** On macOS in the System Keychain; elsewhere in `PENGUINRADAR_API_KEY`. No plaintext credential file is written. Revoke a Key any time in Developer settings.

**Can an AI assistant use it?** Yes. Install the Skill (`penguinradar skill install`) or connect the remote MCP server at `https://penguinradar.com/mcp`. See [penguinradar/skill](https://github.com/penguinradar/skill) and [penguinradar/chatgpt-plugin](https://github.com/penguinradar/chatgpt-plugin).

## Links

[Documentation](https://penguinradar.com/docs/cli) · [Open API reference](https://penguinradar.com/docs/reference) · [Follower tracker](https://penguinradar.com) · [Free story viewer](https://penguinradar.com/instagram-story-viewer) · [Issues](https://github.com/penguinradar/cli/issues) · support@penguinradar.com

## License

[MIT](LICENSE)
