// The platform's REST surface: sandboxes, one-shot execution, and the listings.
//
// Everything here is async, because everything here is a network call. The one
// design note worth stating: creating a sandbox is `Sandbox.create()` rather
// than `new Sandbox()`, since a constructor cannot await and a sandbox does not
// exist until the platform has assigned it an id.

import fs from 'node:fs/promises';
import path from 'node:path';

import * as config from './config.js';
import { BoltzLabsError } from './errors.js';
import { Session } from './http.js';

const DEFAULT_MACHINE = 'small';
const DEFAULT_ENVIRONMENT = 'base';

// What `sb.run()` assumes when the caller does not say. An environment names the
// image, and the image implies the interpreter that is on it.
const LANGUAGE_FOR = {
	python: 'python',
	pytorch: 'python',
	node: 'node',
	base: 'bash'
};

/**
 * A deadline for a call that runs the caller's code.
 *
 * The client-wide timeout covers the request; this covers the request *plus*
 * whatever the code does, with headroom, so a 60s command does not fail at the
 * transport layer while the platform is still faithfully running it.
 */
function waitFor(seconds) {
	return seconds ? Number(seconds) + 30 : undefined;
}

/** What a command printed, what it exited with, and how long it took. */
export class ExecResult {
	constructor({
		stdout = '',
		stderr = '',
		exitCode = 0,
		durationMs = 0,
		reason = '',
		compileMs = 0,
		compileFailed = false
	} = {}) {
		this.stdout = stdout;
		this.stderr = stderr;
		this.exitCode = exitCode;
		this.durationMs = durationMs;
		this.reason = reason;
		// Only ever set by execute(), and only for a compiled language.
		// `compileMs` is how much of `durationMs` was the compiler;
		// `compileFailed` means the program never ran and `stderr` is the
		// compiler's message rather than the program's.
		this.compileMs = compileMs;
		this.compileFailed = compileFailed;
	}

	get ok() {
		return this.exitCode === 0;
	}

	toString() {
		return this.exitCode === 0 ? this.stdout : this.stdout + this.stderr;
	}

	/** Throw unless it succeeded. For a script that should stop here. */
	check() {
		if (this.exitCode !== 0) {
			const what = this.compileFailed ? 'did not compile' : `exited ${this.exitCode}`;
			const why = this.reason ? ` (${this.reason})` : '';
			const err = this.stderr.trim() ? `: ${this.stderr.trim().slice(0, 500)}` : '';
			throw new BoltzLabsError(`command ${what}${why}${err}`);
		}
		return this;
	}

	static _fromWire(d) {
		d = d ?? {};
		return new ExecResult({
			stdout: d.stdout ?? '',
			stderr: d.stderr ?? '',
			exitCode: Number(d.exitCode ?? 0),
			durationMs: Number(d.durationMs ?? 0),
			reason: d.reason ?? '',
			compileMs: Number(d.compileMs ?? 0),
			compileFailed: Boolean(d.compileFailed)
		});
	}
}

/** The runtime and coding-agent images available to new sandboxes. */
export class Environment {
	constructor(name, isDefault = false) {
		this.name = name;
		this.default = isDefault;
	}
	toString() {
		return this.name;
	}
}

/** A machine: nano, small, medium, large — and what it costs. */
export class Machine {
	constructor({ name = '', vcpus = 0, memoryMb = 0, diskGb = 0, rateUsdPerHour = 0 } = {}) {
		Object.assign(this, { name, vcpus, memoryMb, diskGb, rateUsdPerHour });
	}
	toString() {
		return this.name;
	}
}

/**
 * A language code execution accepts: python, node, go, c, cpp.
 *
 * `compiled` is the one difference you can see from out here: those runs build
 * first, so part of the time belongs to the compiler and code that does not
 * compile comes back with the compiler's message rather than a traceback.
 */
export class Language {
	constructor({ code = '', label = '', extension = '', compiled = false } = {}) {
		Object.assign(this, { code, label, extension, compiled });
	}
	toString() {
		return this.code;
	}
}

export class APIKey {
	constructor({ id = '', name = '', createdAt = '', lastUsedAt = '', key = '' } = {}) {
		Object.assign(this, { id, name, createdAt, lastUsedAt });
		// Only ever set on the response that created it — the platform stores a
		// hash and cannot show it again.
		this.key = key;
	}
}

/**
 * A sandbox.
 *
 *     const sb = await Sandbox.create();                        // small / base
 *     const sb = await Sandbox.create({environment: 'python'});
 *
 *     await sb.delete();                                        // stops the meter
 *
 * To reach a sandbox that already exists, use `boltzlabs.sandbox(id)` — an id is
 * assigned by the platform, never chosen by the caller.
 *
 * `Sandbox.withSandbox(opts, fn)` is the same thing with the `delete()` written
 * for you, including when the body throws — which is the case that otherwise
 * leaves a machine billing until someone notices.
 */
export class Sandbox {
	/** @param {Client} client */
	constructor(client) {
		this._client = client;
		this._fill({});
	}

	static async create({
		machine = DEFAULT_MACHINE,
		environment = DEFAULT_ENVIRONMENT,
		name = null,
		internet = null,
		idleTimeout = null,
		maxLifetime = null,
		client = null,
		timeout = 300
	} = {}) {
		const c = client ?? defaultClient();
		const body = { machine, environment };
		if (name) body.name = name;
		if (internet !== null) body.internet = Boolean(internet);
		if (idleTimeout !== null) body.idleTimeoutSecs = Math.trunc(idleTimeout);
		if (maxLifetime !== null) body.maxLifetimeSecs = Math.trunc(maxLifetime);

		// Booting a machine is not a step; give it its own deadline rather than
		// the client-wide one.
		const wire = await c._post('/api/sandboxes', body, { timeout });
		return new Sandbox(c)._fill(wire);
	}

	/** Create, run `fn`, and delete even if `fn` throws. */
	static async withSandbox(opts, fn) {
		const sb = await Sandbox.create(opts);
		try {
			return await fn(sb);
		} finally {
			await sb.delete().catch(() => {});
		}
	}

	// -- the three verbs -----------------------------------------------------

	/** Run one shell command. */
	async exec(command, { timeout = null } = {}) {
		const body = { command };
		if (timeout) body.timeoutS = Math.trunc(timeout);
		return ExecResult._fromWire(
			await this._client._post(`/api/sandboxes/${this.id}/exec`, body, { timeout: waitFor(timeout) })
		);
	}

	/** Run a snippet. The language follows the sandbox type unless you say. */
	async run(code, { language = null, timeout = null } = {}) {
		const body = { code, language: language ?? LANGUAGE_FOR[this.environment] ?? 'bash' };
		if (timeout) body.timeoutS = Math.trunc(timeout);
		return ExecResult._fromWire(
			await this._client._post(`/api/sandboxes/${this.id}/run`, body, { timeout: waitFor(timeout) })
		);
	}

	/** Destroy it. This is what stops the meter. */
	async delete() {
		await this._client._delete(`/api/sandboxes/${this.id}`);
		this.status = 'deleted';
		return this;
	}

	/** Re-read it from the platform, in place. */
	async refresh() {
		return this._fill(await this._client._get(`/api/sandboxes/${this.id}`));
	}

	async metrics() {
		return this._client._get(`/api/sandboxes/${this.id}/metrics`);
	}

	/** The public URL of a port inside the sandbox. */
	url(port, subPath = '') {
		const base = `${this._client.url}/api/sandboxes/${this.id}/proxy/${Math.trunc(port)}`;
		if (!subPath) return base;
		return base + (subPath.startsWith('/') ? subPath : `/${subPath}`);
	}

	/** Poll until it is running, or give up. Creation returns before boot does. */
	async waitUntilRunning({ timeout = 180, poll = 2 } = {}) {
		const deadline = Date.now() + timeout * 1000;
		for (;;) {
			await this.refresh();
			if (this.status === 'running') return this;
			if (this.status === 'failed' || this.status === 'deleted') {
				throw new BoltzLabsError(`sandbox ${this.id} is ${this.status}, not running`);
			}
			if (Date.now() >= deadline) {
				throw new BoltzLabsError(
					`sandbox ${this.id} was still '${this.status}' after ${timeout}s`
				);
			}
			await new Promise((r) => setTimeout(r, poll * 1000));
		}
	}

	_fill(d) {
		d = d ?? {};
		this.id = d.id ?? '';
		this.name = d.name ?? '';
		this.status = d.status ?? '';
		this.machine = d.machine ?? '';
		this.environment = d.environment ?? '';
		this.vcpus = Number(d.vcpus ?? 0);
		this.memoryMb = Number(d.memoryMb ?? 0);
		this.diskGb = Number(d.diskGb ?? 0);
		this.createdAt = d.createdAt ?? '';
		this.runtimeLabel = d.runtimeLabel ?? '';
		this.runtimeMinutes = Number(d.runtimeMinutes ?? 0);
		this.costUsd = Number(d.costUsd ?? 0);
		this.rateUsdPerHour = Number(d.rateUsdPerHour ?? 0);
		// Anything the platform adds later is kept rather than dropped, so a
		// newer backend does not need a new SDK release to be usable.
		this.raw = d;
		return this;
	}

	static _attach(d, client) {
		return new Sandbox(client)._fill(d);
	}
}

/** One origin, one key. Hold two of these to talk to two accounts. */
export class Client {
	constructor({ apiKey = null, url = null, timeout = 60 } = {}) {
		const resolved = config.resolve({ url, apiKey });
		this.url = resolved.url;
		this._apiKey = resolved.apiKey;
		this._session = new Session(this.url, {
			headers: { Authorization: `Bearer ${this._apiKey}` },
			timeout
		});
	}

	get keyPreview() {
		return config.mask(this._apiKey);
	}

	// -- execution -----------------------------------------------------------

	/**
	 * Run one piece of code and get back what it printed.
	 *
	 *     await boltzlabs.execute('print(sum(range(101)))', {language: 'python'});
	 *     await boltzlabs.execute({file: 'train.py', language: 'python'});
	 *
	 * The language is never guessed, from an extension or otherwise: a `.py` file
	 * is as likely to be torch as plain python, and inline code has no extension
	 * at all. See `boltzlabs.languages()` for the codes.
	 *
	 * A compiled language (go, c, cpp) is built first and then run. Code that
	 * does not compile comes back as a result, not an exception, with
	 * `compileFailed` set and the compiler's output in `stderr`.
	 */
	async execute(code = null, { language = null, file = null, timeout = null, filename = null } = {}) {
		// `execute({file, language})` — everything in one object — is the shape
		// people reach for when there is no inline code to pass positionally.
		if (code !== null && typeof code === 'object') {
			({ language = null, file = null, timeout = null, filename = null } = code);
			code = code.code ?? null;
		}
		if ((code === null) === (file === null)) {
			throw new TypeError('pass either code or file, not both and not neither');
		}
		if (!language) {
			throw new TypeError(
				'language is required — it is never inferred. See boltzlabs.languages() for the codes.'
			);
		}

		let source = code;
		let sentName = filename;
		if (file !== null) {
			// The path is resolved here, on the caller's machine: the platform
			// never sees a path it would have to trust or resolve.
			source = await fs.readFile(file, 'utf8');
			sentName = sentName ?? path.basename(file);
		}

		const body = { code: source, language };
		if (sentName) body.filename = sentName;
		if (timeout) body.timeoutS = Math.trunc(timeout);
		return ExecResult._fromWire(
			await this._post('/api/execute', body, { timeout: waitFor(timeout ?? 30) })
		);
	}

	// -- listings ------------------------------------------------------------

	async languages() {
		const body = await this._get('/api/languages');
		return (body?.languages ?? []).map((l) => new Language(l));
	}

	async createSandbox(opts = {}) {
		return Sandbox.create({ ...opts, client: this });
	}

	async sandbox(id) {
		return Sandbox._attach(await this._get(`/api/sandboxes/${id}`), this);
	}

	async sandboxes() {
		const body = await this._get('/api/sandboxes');
		return (body?.sandboxes ?? []).map((s) => Sandbox._attach(s, this));
	}

	async environments() {
		const body = await this._get('/api/environments');
		return (body?.environments ?? []).map((e) => new Environment(e.name ?? '', Boolean(e.default)));
	}

	async machines() {
		const body = await this._get('/api/machines');
		return (body?.machines ?? []).map((m) => new Machine(m));
	}

	async me() {
		return this._get('/api/me');
	}

	// -- keys ----------------------------------------------------------------

	async keys() {
		const body = await this._get('/api/keys');
		return (body?.keys ?? []).map((k) => new APIKey(k));
	}

	async createKey(name) {
		const body = (await this._post('/api/keys', { name })) ?? {};
		return new APIKey({ ...(body.apiKey ?? body), key: body.key ?? '' });
	}

	async revokeKey(keyId) {
		await this._delete(`/api/keys/${keyId}`);
	}

	// -- rl ------------------------------------------------------------------

	/**
	 * An RL pool on this origin with this key — the ordinary `RLPool`.
	 *
	 * Either your own environment directory, or one the platform ships:
	 *
	 *     await client.pool({envDir: './my_env', n: 64});
	 *     await client.pool({environment: 'cartpole', n: 64});
	 */
	async pool(opts = {}) {
		const { RLPool } = await import('./pool.js');
		return RLPool.create({ ...opts, url: this.url, apiKey: this._apiKey });
	}

	/** The ready-made RL environments a pool can be launched with. */
	async rlEnvironments() {
		const body = await this._get('/api/rl/environments');
		return body?.environments ?? [];
	}

	async pools() {
		const body = await this._get('/api/rl/pools');
		return body?.pools ?? [];
	}

	// -- transport -----------------------------------------------------------

	_get(routePath, opts) {
		return this._session.get(routePath, opts);
	}
	_post(routePath, body, opts) {
		return this._session.post(routePath, body, opts);
	}
	_delete(routePath, opts) {
		return this._session.delete(routePath, opts);
	}
}

// The lazily-built default client, so importing the package needs no key and
// opens no socket.
let _default = null;

export function defaultClient() {
	if (_default === null) _default = new Client();
	return _default;
}

/** Point the default client at another key or origin. */
export function use({ apiKey = null, url = null } = {}) {
	_default = new Client({ apiKey, url });
	return _default;
}
