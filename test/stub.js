// A stub control plane. The SDK's job is the shape of the request and the
// shape of what comes back, so the tests drive a real socket rather than a
// mocked fetch — that way a header the platform requires cannot pass here and
// fail in production.
import http from 'node:http';

export async function stubServer(routes) {
	const seen = [];

	const server = http.createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const raw = Buffer.concat(chunks).toString('utf8');
		const body = raw ? JSON.parse(raw) : null;
		seen.push({ method: req.method, path: req.url, body, headers: req.headers });

		const key = `${req.method} ${req.url.split('?')[0]}`;
		const handler = routes[key];
		if (!handler) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: `no stub for ${key}` }));
			return;
		}

		const out = typeof handler === 'function' ? await handler(body, seen) : handler;
		const status = out?.__status ?? 200;
		if (status === 204) {
			res.writeHead(204);
			res.end();
			return;
		}
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(out?.__status ? out.body : out));
	});

	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address();

	return {
		url: `http://127.0.0.1:${port}`,
		seen,
		close: () => new Promise((r) => server.close(r))
	};
}

/** Reply with an error status the SDK should map onto a class. */
export function fail(status, error) {
	return { __status: status, body: { error } };
}
