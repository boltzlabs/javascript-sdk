import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '../src/client.js';
import { AuthError, CapacityError, NotFoundError, QuotaError } from '../src/errors.js';
import { fail, stubServer } from './stub.js';

test('the listing calls, end to end', async () => {
	const stub = await stubServer({
		'GET /api/me': { email: 'a@b.c' },
		'GET /api/sandboxes': { sandboxes: [{ id: 'sb-123', status: 'running', memoryMb: 512 }] },
		'GET /api/environments': { environments: [{ name: 'base', default: true }, { name: 'python' }] },
		'GET /api/machines': { machines: [{ name: 'small', vcpus: 2, memoryMb: 2048, rateUsdPerHour: 0.04 }] },
		'GET /api/languages': { languages: [{ code: 'go', label: 'Go', compiled: true }] },
		'GET /api/sandboxes/sb-123': { id: 'sb-123', status: 'running' }
	});

	try {
		const client = new Client({ url: stub.url, apiKey: 'testkey' });

		assert.equal((await client.me()).email, 'a@b.c');
		assert.deepEqual((await client.sandboxes()).map((s) => s.id), ['sb-123']);
		assert.deepEqual((await client.environments()).map(String), ['base', 'python']);
		assert.deepEqual((await client.machines()).map(String), ['small']);
		assert.equal((await client.sandbox('sb-123')).id, 'sb-123');

		const [go] = await client.languages();
		assert.equal(go.code, 'go');
		assert.equal(go.compiled, true);

		// Every call carries the key as a Bearer token.
		assert.ok(stub.seen.every((r) => r.headers.authorization === 'Bearer testkey'));
	} finally {
		await stub.close();
	}
});

test('camelCase wire fields land on the sandbox', async () => {
	const stub = await stubServer({
		'GET /api/sandboxes/sb-9': {
			id: 'sb-9',
			status: 'running',
			memoryMb: 2048,
			diskGb: 20,
			rateUsdPerHour: 0.04,
			costUsd: 1.25,
			somethingNew: 'kept'
		}
	});
	try {
		const sb = await new Client({ url: stub.url, apiKey: 'k' }).sandbox('sb-9');
		assert.equal(sb.memoryMb, 2048);
		assert.equal(sb.diskGb, 20);
		assert.equal(sb.rateUsdPerHour, 0.04);
		assert.equal(sb.costUsd, 1.25);
		// A newer backend must not need a new SDK release to be usable.
		assert.equal(sb.raw.somethingNew, 'kept');
	} finally {
		await stub.close();
	}
});

test('execute sends the code and the language, and never guesses', async () => {
	const stub = await stubServer({
		'POST /api/execute': (body) => ({
			stdout: `ran ${body.language}: ${body.code}`,
			exitCode: 0,
			durationMs: 12
		})
	});

	try {
		const client = new Client({ url: stub.url, apiKey: 'k' });

		const res = await client.execute('print(1)', { language: 'python' });
		assert.equal(res.stdout, 'ran python: print(1)');
		assert.equal(res.ok, true);
		assert.equal(String(res), 'ran python: print(1)');

		await assert.rejects(() => client.execute('print(1)'), TypeError);
		await assert.rejects(() => client.execute(null, { language: 'python' }), TypeError);
		await assert.rejects(
			() => client.execute('x', { file: 'y.py', language: 'python' }),
			TypeError
		);
	} finally {
		await stub.close();
	}
});

test('a failed command is a result, and check() turns it into a throw', async () => {
	const stub = await stubServer({
		'POST /api/execute': { stdout: '', stderr: 'boom', exitCode: 1, compileFailed: true }
	});
	try {
		const res = await new Client({ url: stub.url, apiKey: 'k' }).execute('x', { language: 'go' });
		assert.equal(res.ok, false);
		assert.equal(res.compileFailed, true);
		assert.throws(() => res.check(), /did not compile.*boom/s);
	} finally {
		await stub.close();
	}
});

test('statuses map onto the class a caller would branch on', async () => {
	const cases = [
		[401, AuthError],
		[404, NotFoundError],
		[409, QuotaError],
		[503, CapacityError]
	];

	for (const [status, Cls] of cases) {
		const stub = await stubServer({ 'GET /api/me': fail(status, 'nope') });
		try {
			const client = new Client({ url: stub.url, apiKey: 'k' });
			await assert.rejects(() => client.me(), (err) => {
				assert.ok(err instanceof Cls, `${status} should be ${Cls.name}, got ${err.constructor.name}`);
				assert.equal(err.status, status);
				assert.equal(err.detail, 'nope');
				return true;
			});
		} finally {
			await stub.close();
		}
	}
});

test('creating a sandbox names only what was asked for', async () => {
	const stub = await stubServer({
		'POST /api/sandboxes': (body) => ({ id: 'sb-new', status: 'starting', ...body })
	});
	try {
		const client = new Client({ url: stub.url, apiKey: 'k' });
		const sb = await client.createSandbox({ environment: 'python', internet: true });

		const [req] = stub.seen;
		assert.equal(req.body.machine, 'small');
		assert.equal(req.body.environment, 'python');
		assert.equal(req.body.internet, true);
		// Untouched options are absent rather than sent as null.
		assert.ok(!('name' in req.body));
		assert.ok(!('idleTimeoutSecs' in req.body));
		assert.equal(sb.id, 'sb-new');
	} finally {
		await stub.close();
	}
});

test('a sandbox proxy URL is built from the client origin', async () => {
	const stub = await stubServer({ 'GET /api/sandboxes/sb-9': { id: 'sb-9' } });
	try {
		const sb = await new Client({ url: stub.url, apiKey: 'k' }).sandbox('sb-9');
		assert.equal(sb.url(8080), `${stub.url}/api/sandboxes/sb-9/proxy/8080`);
		assert.equal(sb.url(8080, 'health'), `${stub.url}/api/sandboxes/sb-9/proxy/8080/health`);
		assert.equal(sb.url(8080, '/health'), `${stub.url}/api/sandboxes/sb-9/proxy/8080/health`);
	} finally {
		await stub.close();
	}
});
