import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '../src/client.js';
import {
	AuthError,
	CapacityError,
	NotFoundError,
	QuotaError,
	SupersededError
} from '../src/errors.js';
import { fail, stubServer } from './stub.js';

test('the listing calls, end to end', async () => {
	const stub = await stubServer({
		'GET /api/me': { email: 'a@b.c' },
		'GET /api/sandboxes': { sandboxes: [{ id: 'sb-123', status: 'running', memoryMb: 1024 }] },
		'GET /api/environments': { environments: [{ name: 'base', default: true }, { name: 'python' }] },
		'GET /api/machines': { machines: [{ name: 'small', vcpus: 2, memoryMb: 2048, rateUsdPerHour: 0.04 }] },
		'GET /api/languages': [{ id: 107, name: 'Go (1.27.1)', code: 'go', compiled: true }],
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
		assert.equal(go.id, 107);
		assert.equal(go.label, 'Go (1.27.1)');
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

test('pause and resume update the sandbox in place', async () => {
	const stub = await stubServer({
		'GET /api/sandboxes/sb-9': { id: 'sb-9', status: 'running' },
		'POST /api/sandboxes/sb-9/pause': { id: 'sb-9', status: 'paused' },
		'POST /api/sandboxes/sb-9/resume': { id: 'sb-9', status: 'running' }
	});
	try {
		const sb = await new Client({ url: stub.url, apiKey: 'k' }).sandbox('sb-9');
		assert.equal(await sb.pause(), sb);
		assert.equal(sb.status, 'paused');
		assert.equal(await sb.resume(), sb);
		assert.equal(sb.status, 'running');
	} finally {
		await stub.close();
	}
});

test('fork returns a new sandbox and leaves this one', async () => {
	const stub = await stubServer({
		'GET /api/sandboxes/sb-9': { id: 'sb-9', status: 'running' },
		'POST /api/sandboxes/sb-9/fork': { id: 'sb-10', name: 'branch', status: 'running', forkedFrom: 'sb-9' }
	});
	try {
		const sb = await new Client({ url: stub.url, apiKey: 'k' }).sandbox('sb-9');
		const fork = await sb.fork({ name: 'branch' });
		assert.notEqual(fork, sb);
		assert.equal(fork.id, 'sb-10');
		assert.equal(fork.name, 'branch');
		assert.equal(sb.id, 'sb-9');
	} finally {
		await stub.close();
	}
});

test('execute speaks the standard submission format, and never guesses the language', async () => {
	const stub = await stubServer({
		'GET /api/languages': [{ id: 113, name: 'Python (3.14)', code: 'python', compiled: false }],
		'POST /api/execute': (body) => ({
			stdout: `ran ${body.language_id}: ${body.source_code}`,
			status: { id: 3, description: 'Accepted' },
			time: '0.001',
			memory: 1024,
			token: 'tok-1'
		})
	});
	try {
		const client = new Client({ url: stub.url, apiKey: 'k' });
		const res = await client.execute('print(1)', { language: 'python' });
		assert.equal(res.stdout, 'ran 113: print(1)');
		assert.equal(res.ok, true);
		assert.equal(String(res), 'ran 113: print(1)');
		const sent = stub.seen.find((r) => r.method === 'POST');
		assert.equal(sent.path, '/api/execute?wait=true&fields=*');
		assert.deepEqual(sent.body, { source_code: 'print(1)', language_id: 113 });

		await assert.rejects(() => client.execute('print(1)'), TypeError);
		await assert.rejects(() => client.execute(null, { language: 'python' }), TypeError);
		await assert.rejects(() => client.execute('x', { file: 'y.py', language: 'python' }), TypeError);
	} finally {
		await stub.close();
	}
});

test('execute judges a solution: the standard fields out, status/time/memory back', async () => {
	const seen = [];
	const stub = await stubServer({
		'POST /api/execute': (body) => {
			seen.push(body);
			return {
				stdout: '6\n',
				time: '0.012',
				memory: 9216,
				token: 'tok-j',
				status:
					body.expected_output === '6'
						? { id: 3, description: 'Accepted' }
						: { id: 4, description: 'Wrong Answer' }
			};
		}
	});
	try {
		const client = new Client({ url: stub.url, apiKey: 'k' });
		const res = await client.execute('print(6)', {
			language: 113,
			stdin: '1 2 3',
			expected_output: '6',
			cpu_time_limit: 1,
			memory_limit: 65536,
			supersede_key: 'tab-1'
		});
		assert.deepEqual(seen[0], {
			source_code: 'print(6)',
			language_id: 113,
			stdin: '1 2 3',
			expected_output: '6',
			cpu_time_limit: 1,
			memory_limit: 65536,
			supersede_key: 'tab-1'
		});
		assert.equal(res.ok, true);
		assert.equal(res.time, '0.012');
		assert.equal(res.memory, 9216);
		assert.equal(res.json.token, 'tok-j');

		const wrong = await client.execute('print(7)', { language: 113, expected_output: '7' });
		assert.equal(wrong.statusId, 4);
		assert.equal(wrong.ok, false);
		assert.throws(() => wrong.check(), /Wrong Answer/);
	} finally {
		await stub.close();
	}
});

test('executeBatch runs the test cases together and returns them in order', async () => {
	const stub = await stubServer({
		'POST /api/execute/batch': (body) => body.submissions.map((_, i) => ({ token: `t${i}` })),
		'GET /api/execute/batch': () => ({
			submissions: [
				{ token: 't0', stdout: 'a\n', status: { id: 3, description: 'Accepted' } },
				{ token: 't1', stdout: 'b\n', status: { id: 4, description: 'Wrong Answer' } }
			]
		})
	});
	try {
		const client = new Client({ url: stub.url, apiKey: 'k' });
		const results = await client.executeBatch([
			{ code: 'print(input())', language: 113, stdin: 'a' },
			{ source_code: 'print(input())', language_id: 113, stdin: 'b' }
		]);
		assert.deepEqual(
			results.map((r) => [r.stdout, r.statusId]),
			[
				['a\n', 3],
				['b\n', 4]
			]
		);
	} finally {
		await stub.close();
	}
});

test('a superseded run is its own error, not a quota error', async () => {
	const stub = await stubServer({
		'POST /api/execute': {
			__status: 409,
			body: { code: 'superseded', error: 'replaced by a newer submission with the same supersede_key' }
		}
	});
	try {
		const client = new Client({ url: stub.url, apiKey: 'k' });
		await assert.rejects(
			() => client.execute('x', { language: 113, supersede_key: 'tab-1' }),
			(err) => err instanceof SupersededError
		);
	} finally {
		await stub.close();
	}
});

test('code that does not compile is a result, and check() turns it into a throw', async () => {
	const stub = await stubServer({
		'POST /api/execute': {
			stdout: null,
			compile_output: 'main.go:1: boom',
			status: { id: 6, description: 'Compilation Error' }
		}
	});
	try {
		const res = await new Client({ url: stub.url, apiKey: 'k' }).execute('x', { language: 107 });
		assert.equal(res.ok, false);
		assert.equal(String(res), 'main.go:1: boom');
		assert.throws(() => res.check(), /Compilation Error.*boom/s);
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
