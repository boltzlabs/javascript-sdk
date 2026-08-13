// A small JSON client on `fetch`, with the connection reuse a training loop needs.
//
// `step` is the call a training loop makes thousands of times, and on a fast
// worker the batch itself is single-digit milliseconds. A fresh TCP connection
// (and a fresh TLS handshake) per step would dominate that completely — the
// number the SDK reports would be a measurement of connection setup. Node's
// global fetch keeps connections alive per origin already, so this module's job
// is the rest of it: one place for the timeouts, the error mapping, and the
// retry rule.

import { TransportError, fromStatus } from './errors.js';

export const USER_AGENT = 'boltzlabs-js/0.1.0';

/** One reusable session against one origin. */
export class Session {
	/**
	 * @param {string} baseUrl
	 * @param {{headers?: Record<string,string>, timeout?: number}} [opts]
	 *   `timeout` is in seconds, to match the rest of the SDK.
	 */
	constructor(baseUrl, { headers = {}, timeout = 60 } = {}) {
		const withScheme = baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`;
		let parsed;
		try {
			parsed = new URL(withScheme);
		} catch {
			throw new TypeError(`not a URL: ${baseUrl}`);
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new TypeError(`unsupported scheme '${parsed.protocol}' in ${baseUrl}`);
		}

		this.origin = parsed.origin;
		// A control plane may live under a path prefix behind a reverse proxy.
		this.prefix = parsed.pathname.replace(/\/+$/, '');
		this.timeout = timeout;
		this.headers = {
			'User-Agent': USER_AGENT,
			Accept: 'application/json',
			...headers
		};
	}

	/** Absolute URL for a route path. */
	url(routePath) {
		return `${this.origin}${this.prefix}${routePath}`;
	}

	/**
	 * One request. Returns the decoded body, or `null` for 204.
	 *
	 * @param {string} method
	 * @param {string} routePath
	 * @param {unknown} [body]
	 * @param {{timeout?: number}} [opts] seconds
	 */
	async call(method, routePath, body = undefined, { timeout = undefined } = {}) {
		const seconds = timeout ?? this.timeout;
		const headers = { ...this.headers };
		let payload;
		if (body !== undefined && body !== null) {
			headers['Content-Type'] = 'application/json';
			payload = JSON.stringify(body);
		}

		let res;
		try {
			res = await fetch(this.url(routePath), {
				method,
				headers,
				body: payload,
				// AbortSignal.timeout aborts the whole exchange, headers and body
				// alike — a worker that accepts the connection and then stalls is
				// the failure this has to cover, not just a refused connect.
				signal: AbortSignal.timeout(Math.round(seconds * 1000))
			});
		} catch (err) {
			// Anything that never became an HTTP answer, timeouts included.
			const why = err?.name === 'TimeoutError' ? `timed out after ${seconds}s` : String(err?.message ?? err);
			throw new TransportError(`${method} ${routePath}: ${why}`);
		}

		const text = await res.text();
		let decoded = null;
		if (text) {
			try {
				decoded = JSON.parse(text);
			} catch {
				decoded = null;
			}
		}

		if (!res.ok) {
			// The control plane answers errors as {"error": "..."} — fall back to
			// the raw body so a proxy's HTML 502 is still legible in the message.
			const message = decoded?.error ?? decoded?.message ?? text.slice(0, 500) ?? res.statusText;
			throw fromStatus(res.status, message || res.statusText, decoded);
		}
		return decoded;
	}

	get(routePath, opts) {
		return this.call('GET', routePath, undefined, opts);
	}

	post(routePath, body, opts) {
		return this.call('POST', routePath, body ?? {}, opts);
	}

	delete(routePath, opts) {
		return this.call('DELETE', routePath, undefined, { timeout: 120, ...opts });
	}
}
