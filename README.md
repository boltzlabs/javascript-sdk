# boltzlabs

Sandboxes, from JavaScript.

Not on npm yet — install from git:

```bash
npm install github:boltzlabs/javascript-sdk

# or
pnpm add github:boltzlabs/javascript-sdk
yarn add github:boltzlabs/javascript-sdk
bun add github:boltzlabs/javascript-sdk
```

Node 18 or newer. No dependencies.

```js
import { Sandbox } from 'boltzlabs';

const sb = await Sandbox.create();                 // small / base / internet off

console.log(String(await sb.exec("python3 -c 'print(sum(range(101)))'")));
console.log(String(await sb.exec('pip install requests')));

await sb.delete();                                 // stops the meter
```

The key comes from `BOLTZLABS_API_KEY` in the environment or in a `.env` file,
searched from the current directory upwards. Nothing else is required.

The origin defaults to `https://boltzlabs.cloud`. Set `BOLTZLABS_API_URL` to
point elsewhere, or call `use({apiKey, url})` once at startup.

## Sandboxes

A sandbox is a machine that stays up between commands. `Sandbox.create()` is a
static rather than a constructor because a sandbox does not exist until the
platform has assigned it an id, and a constructor cannot await that.

```js
const sb = await Sandbox.create({
  machine: 'medium',          // small | medium | large
  environment: 'python',      // base | python | node | …
  name: 'trainer',
  internet: true
});

await sb.waitUntilRunning();  // creation returns before boot does

await sb.exec('nvidia-smi');
await sb.exec("python -c 'import numpy; print(numpy.arange(4).sum())'");

sb.url(8080);                 // reach a port from outside
await sb.metrics();

await sb.delete();
```

`withSandbox` writes the `delete()` for you, including when the body throws —
the case that otherwise leaves a machine billing until someone notices.

```js
await Sandbox.withSandbox({ environment: 'python' }, async (sb) => {
  (await sb.exec('echo hi')).check();
});
```

## One-shot execution

Nothing is created and nothing is left over — no sandbox to make first and none
to destroy after. Use a sandbox instead when you want state to survive between
commands.

```js
import { execute, executeBatch, languages } from 'boltzlabs';

await execute('print(sum(range(101)))', { language: 'python' });   // 5050
await execute({ file: 'train.py', language: 'python' });
await execute('console.log(1)', { language: 'node' });
await execute({ file: 'main.go', language: 'go' });                // compiled, then run

await languages();   // python, node, go, c, cpp — from the platform
```

The language is never guessed, from an extension or otherwise: a `.py` file is
as likely to be torch as plain python, and inline code has no extension at all.

The result is the standard submission format: `String(res)` is what it
printed, `res.ok` is whether it was Accepted, and `res.status`, `res.time` (CPU
seconds), `res.wall_time`, `res.memory` (KB), `res.compile_output` and `res.json`
(the whole response) are there when you want them. A compiled language builds
first; code that does not compile comes back as a result, not an exception, with
status Compilation Error and the compiler's message in `compile_output`.

Judging a solution, and a problem's test cases together:

```js
const res = await execute({ file: 'sol.py', language: 'python', stdin: '1 2\n',
  expected_output: '3', cpu_time_limit: 1, memory_limit: 65536 });
res.status.description;   // Accepted, Wrong Answer, Time Limit Exceeded, ...

const results = await executeBatch(tests.map(([i, o]) =>
  ({ code: src, language: 100, stdin: i, expected_output: o })));   // up to 20
```

Batch submission is available to paid users. Each batch entry counts as one execution.
Batch waits default to 21 minutes to allow workers to start; set `timeoutMs` to override.

## Everything else

```js
import { me, sandboxes, sandbox, environments, machines, Client, use } from 'boltzlabs';

await me();             // who your key belongs to      (boltz auth status)
await sandboxes();      // everything you have running  (boltz ls)
await sandbox(id);      // one of them, by id           (boltz status <id>)
await environments();   // runtime and coding-agent images (boltz environments)
await machines();       // machines and prices          (boltz machines)

use({ apiKey, url });   // point the default client somewhere else
new Client({ apiKey, url });   // or hold two at once
```

## RL pool startup

`await RLPool.create({ environment: 'cartpole', n: 4 })` starts creation and
polls the saved pool until it is ready. Each public HTTP request is capped at
60 seconds; `createTimeout` bounds the complete startup (900 seconds by default).
Startup errors keep the API's status and message. If polling fails or times out,
the SDK attempts to cancel the pool. If cleanup cannot reach the server, find
the pool in your dashboard and delete it after reconnecting.

HTTP clients use `POST /api/rl/pools?wait=false` (202), then poll the returned
`Location` with the same API key once per second. Status is `creating`, `running`
or `failed`; failures include `error` and `error_status`. `DELETE` cancels pending
startup. Pending pools reserve quota and expire after 15 minutes, including
when a control-plane restart interrupts startup. The original synchronous POST
remains available for older clients; internal worker calls are unchanged.

## Errors

Separated by what you can do about them. The one worth catching by itself is
`CapacityError` — it is the retryable one.

```js
import { CapacityError, QuotaError } from 'boltzlabs';

try {
  await Sandbox.create({ environment: 'python' });
} catch (err) {
  if (err instanceof CapacityError) { /* nothing took it — retryable */ }
  if (err instanceof QuotaError)    { /* an account limit is in the way */ }
  throw err;
}
```
| class | status | |
| --- | --- | --- |
| `TransportError` | — | never got an HTTP answer |
| `AuthError` | 401, 403 | key missing, wrong, or not allowed |
| `NotFoundError` | 404 | no such thing, or not yours |
| `QuotaError` | 409 | environment limit |
| `CapacityError` | 502, 503, 504 | no worker could take it — retryable |
