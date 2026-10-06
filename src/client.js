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

/** A machine: small, medium, or large — and what it costs. */
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
	constructor({ id = 0, name = '', code = '', extension = '', compiled = false } = {}) {
		Object.assign(this, { id, name, code, extension, compiled });
	}
	/** The display name; `name` under its older spelling. */
	get label() {
		return this.name;
	}
	toString() {
		return this.code;
	}
}

/**
 * One run on the exec plane, in the standard submission format. `json` is the
 * response exactly as it came back; its fields are properties too — stdout,
 * stderr, compile_output, message, status ({id, description}), time and
 * wall_time (seconds, as strings), memory (KB), exit_code, token.
 */
export class Submission {
	static FIELDS = [
		'token',
		'stdout',
		'stderr',
		'compile_output',
		'message',
		'status',
		'time',
		'wall_time',
		'memory',
		'exit_code',
		'exit_signal',
		'language_id'
	];

	constructor(json = {}) {
		this.json = json ?? {};
		for (const f of Submission.FIELDS) this[f] = this.json[f] ?? null;
	}
	get statusId() {
		return this.status?.id ?? null;
	}
	/** False while it is still In Queue or Processing. */
	get finished() {
		return this.statusId !== 1 && this.statusId !== 2;
	}
	get ok() {
		return this.statusId === 3;
	}
	toString() {
		let out = this.stdout ?? '';
		if (!this.ok) out += (this.statusId === 6 ? this.compile_output : this.stderr) ?? '';
		return out;
	}
	/** Throw unless it was Accepted. For a script that should stop here. */
	check() {
		if (!this.ok) {
			const detail = (this.compile_output || this.stderr || this.message || '').trim().slice(0, 500);
			const desc = this.status?.description ?? 'not finished';
			throw new BoltzLabsError(`run ended ${desc}${detail ? `: ${detail}` : ''}`);
		}
		return this;
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

	// -- commands ------------------------------------------------------------

	/** Run one shell command. */
	async exec(command, { timeout = null } = {}) {
		const body = { command };
		if (timeout) body.timeoutS = Math.trunc(timeout);
		return ExecResult._fromWire(
			await this._client._post(`/api/sandboxes/${this.id}/exec`, body, { timeout: waitFor(timeout) })
		);
	}

	/** Destroy it. This is what stops the meter. */
	/**
	 * Copy a local file or directory into the sandbox. `boltz cp <src> <id>:<dst>`.
	 *
	 * Uploading `./src` lands it as `<remote>/src`, the way scp does.
	 *
	 * @param {string} local
	 * @param {string} [remote]
	 * @param {{timeout?: number}} [opts]
	 */
	async push(local, remote = '/workspace', { timeout = 300 } = {}) {
		const { packPath } = await import('./files.js');
		const tar = await packPath(local);
		await this._client._session.raw(
			'POST',
			`/api/sandboxes/${this.id}/fs?path=${encodeURIComponent(remote)}`,
			tar,
			{ timeout, contentType: 'application/x-tar' }
		);
		return remote;
	}

	/**
	 * Copy a path out of the sandbox. `boltz cp <id>:<src> <dst>`.
	 *
	 * @param {string} remote
	 * @param {string} [local]
	 * @param {{timeout?: number}} [opts]
	 */
	async pull(remote, local = '.', { timeout = 300 } = {}) {
		const { unpackTo } = await import('./files.js');
		const buf = await this._client._session.raw(
			'GET',
			`/api/sandboxes/${this.id}/fs?path=${encodeURIComponent(remote)}`,
			undefined,
			{ timeout }
		);
		await unpackTo(Buffer.from(buf), local);
		return local;
	}

	/**
	 * Stop compute while retaining files. Storage is free for 3 days per pause.
	 *
	 * Files under /workspace are archived to object storage shortly after, which
	 * is what lets a paused sandbox cost nothing and come back on a different
	 * machine. Packages installed outside /workspace do not survive that.
	 */
	async pause() {
		return this._fill(await this._client._post(`/api/sandboxes/${this.id}/pause`));
	}

	/**
	 * Restart a paused sandbox after capacity and credit checks.
	 *
	 * Seconds if the sandbox is still on its machine, longer if it has to be
	 * rebuilt from its archived workspace — hence its own deadline.
	 */
	async resume({ timeout = 300 } = {}) {
		return this._fill(await this._client._post(`/api/sandboxes/${this.id}/resume`, null, { timeout }));
	}

	/**
	 * A new sandbox that starts as a copy of this one.
	 *
	 * Files under /workspace are copied; running processes and packages installed
	 * outside /workspace are not. This sandbox keeps running, held still only for
	 * as long as its workspace takes to copy. The fork is a sandbox like any
	 * other: it counts against your concurrent limit and bills on its own clock
	 * until you pause or delete it.
	 */
	async fork({ name = null, timeout = 600 } = {}) {
		const wire = await this._client._post(`/api/sandboxes/${this.id}/fork`, name ? { name } : {}, { timeout });
		return new Sandbox(this._client)._fill(wire);
	}

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
	/**
	 * Run one piece of code on the exec plane. `language` is an id (113) or a
	 * code ('python'). Judging a solution: `stdin`, `expected_output`, and the
	 * problem's limits `cpu_time_limit` / `wall_time_limit` (seconds) and
	 * `memory_limit` (KB) — they only ever lower the platform's own. Resolves
	 * to a Submission; `wait: false` resolves at once with its token.
	 * `supersede_key`: a newer run with the same key replaces this one.
	 */
	async execute(code = null, opts = {}) {
		// `execute({file, language})` — everything in one object — is the shape
		// people reach for when there is no inline code to pass positionally.
		if (code !== null && typeof code === 'object') {
			opts = code;
			code = code.code ?? null;
		}
		const { language = null, file = null, wait = true } = opts;
		if ((code === null) === (file === null)) {
			throw new TypeError('pass either code or file, not both and not neither');
		}
		if (language === null || language === '') {
			throw new TypeError(
				'language is required — it is never inferred. See boltzlabs.languages() for the ids and codes.'
			);
		}
		// The path is resolved here, on the caller's machine: the platform
		// never sees a path it would have to trust or resolve.
		const source = file !== null ? await fs.readFile(file, 'utf8') : code;
		const body = await this._submission(source, language, opts);
		const route = wait ? '/api/execute?wait=true&fields=*' : '/api/execute';
		return new Submission(await this._post(route, body, { timeout: 180 }));
	}

	/**
	 * Run up to 20 submissions at once — a problem's test cases, say. Each is
	 * an object of execute()'s options (`code` or `source_code`, `language`,
	 * `stdin`, `expected_output`, limits). Resolves to their Submissions, in
	 * order, once all finish.
	 */
	async executeBatch(submissions, { wait = true, pollMs = 250, timeoutMs = 300000 } = {}) {
		const items = [];
		for (const item of submissions) {
			const { code, source_code, language, language_id, ...rest } = item;
			items.push(await this._submission(code ?? source_code, language ?? language_id, rest));
		}
		const answer = await this._post('/api/execute/batch', { submissions: items });
		const bad = answer.filter((a) => !a.token);
		if (bad.length) throw new BoltzLabsError(`invalid submissions in batch: ${JSON.stringify(bad)}`);
		const tokens = answer.map((a) => a.token);
		if (!wait) return tokens.map((token) => new Submission({ token, status: { id: 1, description: 'In Queue' } }));
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const got = await this._get(`/api/execute/batch?fields=*&tokens=${tokens.join(',')}`);
			const results = got.submissions.map((j) => new Submission(j));
			if (results.every((r) => r.finished)) return results;
			if (Date.now() > deadline) throw new BoltzLabsError('batch still unfinished');
			await new Promise((r) => setTimeout(r, pollMs));
		}
	}

	/** A submission by token, as it is now. */
	async submission(token) {
		return new Submission(await this._get(`/api/execute/${encodeURIComponent(token)}?fields=*`));
	}

	async _submission(source, language, opts) {
		const body = { source_code: source, language_id: await this._languageId(language) };
		for (const key of [
			'stdin',
			'expected_output',
			'cpu_time_limit',
			'wall_time_limit',
			'memory_limit',
			'supersede_key'
		]) {
			if (opts[key] !== undefined && opts[key] !== null) body[key] = opts[key];
		}
		return body;
	}

	async _languageId(language) {
		if (typeof language === 'number' || /^\d+$/.test(String(language))) return Number(language);
		if (!this._languageIds) {
			this._languageIds = new Map((await this.languages()).map((l) => [l.code, l.id]));
		}
		const id = this._languageIds.get(language);
		if (id === undefined) throw new TypeError(`unknown language ${JSON.stringify(language)}`);
		return id;
	}

	// -- listings ------------------------------------------------------------

	async languages() {
		return ((await this._get('/api/languages')) ?? []).map((l) => new Language(l));
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
