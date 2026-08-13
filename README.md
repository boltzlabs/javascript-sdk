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

console.log(String(await sb.run('print(sum(range(101)))')));
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
  machine: 'medium',          // nano | small | medium | large
  environment: 'pytorch',     // base | python | node | pytorch | …
  name: 'trainer',
  internet: true
});

await sb.waitUntilRunning();  // creation returns before boot does

await sb.exec('nvidia-smi');
await sb.run('import torch; print(torch.cuda.is_available())');

sb.url(8080);                 // reach a port from outside
await sb.metrics();

await sb.delete();
```

`withSandbox` writes the `delete()` for you, including when the body throws —
the case that otherwise leaves a machine billing until someone notices.

```js
await Sandbox.withSandbox({ environment: 'python' }, async (sb) => {
  (await sb.run('print("hi")')).check();
});
```

## One-shot execution

Nothing is created and nothing is left over — no sandbox to make first and none
to destroy after. Use a sandbox instead when you want state to survive between
commands.

```js
import { execute, languages } from 'boltzlabs';

await execute('print(sum(range(101)))', { language: 'python' });   // 5050
await execute({ file: 'train.py', language: 'python' });
await execute('console.log(1)', { language: 'node' });
await execute({ file: 'main.go', language: 'go' });                // compiled, then run

await languages();   // python, node, go, c, cpp — from the platform
```

The language is never guessed, from an extension or otherwise: a `.py` file is
as likely to be torch as plain python, and inline code has no extension at all.

A compiled language builds first. Code that does not compile comes back as a
result, not an exception, with `compileFailed` set and the compiler's output in
`stderr`.

## Everything else

```js
import { me, sandboxes, sandbox, environments, machines, Client, use } from 'boltzlabs';

await me();             // who your key belongs to      (bzlabs auth status)
await sandboxes();      // everything you have running  (bzlabs ls)
await sandbox(id);      // one of them, by id           (bzlabs status <id>)
await environments();   // runtime and coding-agent images (bzlabs environments)
await machines();       // machines and prices          (bzlabs machines)

use({ apiKey, url });   // point the default client somewhere else
new Client({ apiKey, url });   // or hold two at once
```

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
