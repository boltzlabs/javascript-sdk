// Exceptions, separated by what the caller can do about them.
//
// The distinction that matters to a training script is retry-or-not. A pool that
// failed to create because `env.js` throws on import will fail again in a second;
// one that failed because no RL worker is attached to the fleet may not. The
// control plane already draws that line in its status codes (see
// `statusForRLError` in backend/internal/handler/rl.go) and this mirrors it, so a
// caller can write `catch (e) { if (e instanceof CapacityError) retry() }` and
// mean it.

/** Base for everything this package throws. */
export class BoltzLabsError extends Error {
	constructor(message) {
		super(message);
		this.name = new.target.name;
	}
}

/** The request never got an HTTP answer — DNS, connect, timeout, reset. */
export class TransportError extends BoltzLabsError {}

/** The server answered with an error status. */
export class APIError extends BoltzLabsError {
	constructor(status, message, body = null) {
		super(`HTTP ${status}: ${message}`);
		this.status = status;
		this.detail = message;
		this.body = body;
	}
}

/** 401/403 — the API key is missing, wrong, or not allowed here. */
export class AuthError extends APIError {}

/**
 * 404 — no such pool, or not yours. The control plane does not distinguish the
 * two on purpose: telling a caller that someone else's pool id exists is itself
 * a leak.
 */
export class NotFoundError extends APIError {}

/** 409 — the account's environment limit is in the way. */
export class QuotaError extends APIError {}

/** 503 — no worker could take this. Retryable, unlike everything else. */
export class CapacityError extends APIError {}

/**
 * 410 — the worker holding this pool left the fleet. The environments are gone
 * with it; a new pool has to be created.
 */
export class PoolGoneError extends APIError {}

/** 413 — the uploaded environment directory is over the limit. */
export class PayloadTooLargeError extends APIError {}

const BY_STATUS = {
	401: AuthError,
	403: AuthError,
	404: NotFoundError,
	409: QuotaError,
	410: PoolGoneError,
	413: PayloadTooLargeError,
	502: CapacityError,
	503: CapacityError,
	504: CapacityError
};

/** Map an HTTP status onto the class a caller would branch on. */
export function fromStatus(status, message, body = null) {
	const Cls = BY_STATUS[status] ?? APIError;
	return new Cls(status, message, body);
}
