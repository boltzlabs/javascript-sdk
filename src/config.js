// Where the SDK points, and what it authenticates with.
//
// **The endpoint is always the public SvelteKit origin, never the Go control
// plane.** The control plane binds loopback and is not reachable from the
// internet; everything public — the dashboard, the CLI, and this SDK — enters
// through SvelteKit, which proxies `/api/*` and the terminal's WebSocket upgrade
// to it. `RLPool({direct})` is the one deliberate exception, and it dials a
// *worker*, not the control plane, from inside the deployment or over a tunnel.
//
// The SDK stands on its own: it does not read the CLI's login. Credentials come
// from the environment, and from a `.env` file next to the code that uses it —
// which is where a training script's secrets already live.
//
// Resolution order, highest first:
//
//   1. what the caller passed
//   2. the real environment (`BOLTZLABS_API_KEY`, `BOLTZLABS_API_URL`)
//   3. a `.env` file, searched from the current directory upwards
//   4. the production origin, for the URL only
//
// Real environment variables beat `.env` deliberately: that is what makes
// `BOLTZLABS_API_KEY=... node train.js` work as a one-off override, and it is
// what every other dotenv implementation does, so the precedence is not a
// surprise.
//
// A missing key is an error rather than an anonymous request: every route this
// SDK calls is owner-scoped, so an unauthenticated call can only ever become a
// 401 further from where the mistake was made.

import fs from 'node:fs';
import path from 'node:path';

import { AuthError } from './errors.js';

/** The public origin. Deliberately the SvelteKit one — see the module comment. */
export const DEFAULT_API_URL = 'https://boltzlabs.cloud';

const DOTENV_NAME = '.env';

// Parsed once per path. A training loop constructs pools and clients freely, and
// none of them should re-read the filesystem.
const cache = new Map();

/**
 * Nearest `.env` at or above `start`. `null` if there isn't one.
 *
 * Walking upwards is what makes `node experiments/train.js` work from a
 * repository root as well as from inside the directory, without a copy of the
 * file in both.
 */
export function findDotenv(start = undefined, name = DOTENV_NAME) {
	let dir = path.resolve(start ?? process.cwd());
	for (;;) {
		const candidate = path.join(dir, name);
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			// not there; keep walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * A small dotenv parser: KEY=VALUE, `export` prefixes, # comments, quotes.
 *
 * Deliberately not a dependency. This is thirty lines of well-understood
 * parsing, and an RL SDK asking a user to install a package to read a two-line
 * file would be a worse trade than owning it.
 */
function parse(file) {
	const out = {};
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return out;
	}

	for (const raw of text.split(/\r?\n/)) {
		let line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();

		const eq = line.indexOf('=');
		if (eq === -1) continue;

		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();

		if (value[0] === "'" || value[0] === '"') {
			// A quoted value ends at its closing quote, and anything after it is a
			// comment. Testing the last character instead would mis-read
			// `KEY="v"  # note` as unquoted and hand back the quotes as part of the
			// secret — which is exactly the kind of bug that shows up as a 401 with
			// a key that looks correct in the file.
			const close = value.indexOf(value[0], 1);
			value = close === -1 ? value.slice(1) : value.slice(1, close);
		} else if (value.includes('#')) {
			value = value.split('#', 1)[0].trim();
		}
		if (key) out[key] = value;
	}
	return out;
}

/**
 * Return the nearest `.env` as an object. Never touches `process.env`.
 *
 * Leaving the process environment alone matters: a library that quietly
 * exported a caller's file would change the behaviour of every other library in
 * the process, and of any subprocess it spawns.
 */
export function loadDotenv({ file = null, start = undefined } = {}) {
	const target = file ?? findDotenv(start);
	if (!target) return {};
	if (!cache.has(target)) cache.set(target, parse(target));
	return cache.get(target);
}

/** One setting: real environment first, then `.env`, then the default. */
export function get(name, { fallback = undefined, dotenvPath = null } = {}) {
	const live = process.env[name];
	if (live) return live;
	const value = loadDotenv({ file: dotenvPath })[name];
	return value ? value : fallback;
}

/** Return `{url, apiKey}` following the order in the module comment. */
export function resolve({ url = null, apiKey = null, requireKey = true, dotenvPath = null } = {}) {
	const origin = url || get('BOLTZLABS_API_URL', { dotenvPath }) || DEFAULT_API_URL;
	const key = apiKey || get('BOLTZLABS_API_KEY', { fallback: '', dotenvPath }) || '';

	if (requireKey && !key) {
		const where = findDotenv() ?? 'a .env file';
		throw new AuthError(
			401,
			`no API key: set BOLTZLABS_API_KEY in the environment or in ${where}, or pass apiKey`
		);
	}
	return { url: origin.replace(/\/+$/, ''), apiKey: key };
}

/** Enough of a key to tell which one is in use, and no more. */
export function mask(apiKey) {
	if (!apiKey || apiKey.length <= 8) return '••••';
	return `${apiKey.slice(0, 12)}••••${apiKey.slice(-4)}`;
}

/** Test seam: forget parsed `.env` files. */
export function _clearCache() {
	cache.clear();
}
