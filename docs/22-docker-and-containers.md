# Docker and Containers

## In one sentence

Docker packages a program together with the exact operating-system pieces it needs into one
portable, standardized box (a "container") that behaves the same way on any computer that
can run Docker; this project containers its three long-running, headless-friendly services
(mock-bank, the capability API, the dashboard) but deliberately leaves out anything meant to
be watched live in a real, visible browser window.

---

## Part 1 — For everyone: what is a container, and why bother?

### The analogy: shipping containers

Before standardized shipping containers existed, loading a cargo ship was a mess: every
crate was a different size and shape, packed by hand, and a dockworker in one port had no
guarantee that what worked at their port would work at the next one. The shipping container
fixed this by putting *everything* — no matter what's actually inside it — into the same
standard-sized steel box. Any crane, any truck, any ship built to handle a shipping
container can handle *this* one, without anyone needing to know or care what's packed
inside it. The box behaves the same way everywhere.

**Docker does the same thing for software.** Normally, "will this program run correctly on
your computer" depends on a surprising number of things matching up: which operating system
you have, which version of Node.js is installed, which supporting libraries happen to
already be present, which ones are missing. A program packaged as a Docker "image" bundles
the program *and* everything around it that it needs (down to a specific slice of a Linux
operating system) into one self-contained unit — a **container** — that runs identically
whether it's on your laptop, a teammate's laptop, or a server in a data center you've never
seen. You don't install the program's dependencies yourself; the box already has them.

### What this project actually containers, and what it doesn't

This project has two very different kinds of programs:

1. **Three services that just sit there, listening, doing their job in the background** —
   the fake target bank app (`mock-bank`, run twice, once per tenant), the capability API
   (the HTTP interface an AI agent calls), and the read-only ops dashboard. None of these
   need a human watching a screen; they're perfectly happy running invisibly on a server.
   **These three are containerized.**
2. **Programs that open a real, visible browser window specifically so a human can watch
   what's happening** — running the discovery agent for the first time
   (`npm run run-agent`), the two escalation-resume demos, and the vision-fallback demo.
   These are built to be watched live: an AI is visibly clicking around a real Chromium
   window on your screen. A container has no monitor attached to it — there's nothing to
   watch. **These are deliberately not containerized**, and running them still requires the
   normal `npm install` + `npx playwright install chromium` setup on your own machine.

### A concrete walkthrough

Say you want to run everything except the "watch it live" demos, without installing Node.js
or Playwright on your machine at all. You'd do:

```bash
cp .env.example .env   # fill in real values first
docker compose up --build
```

Docker reads `docker-compose.yml`, which describes four containers: `mock-bank` (port
4000), `mock-bank-northgate` (a second, differently-branded copy of the same app, port
4100), `capability-api` (port 4700), and `dashboard` (port 4600). Docker builds each one
from its own recipe file (a `Dockerfile`), starts them all, and after a short wait you can
run `curl http://localhost:4700/health` from your own terminal and get back a real response
— even though nothing you're calling is actually running "on your machine" in the normal
sense; it's running inside these four sealed boxes.

### The trick this project needed: keeping "localhost" meaningful

Here's a wrinkle specific to this project. The recorded evidence that already exists in
this repo (the actual capability artifact from a real discovery run) has the literal web
address `http://localhost:4000` baked into it, because that's genuinely what the browser
navigated to when it was recorded. Normally, when you put multiple services into separate
containers, each container gets its *own* private idea of "localhost" — so a browser
running inside the `capability-api` container saying "go to `localhost:4000`" would, by
default, mean "look inside my own container for something listening on port 4000," which is
wrong; mock-bank is a *different* container.

The fix used here is a Docker Compose feature called `network_mode: "service:mock-bank"`,
which makes the `capability-api`, `mock-bank-northgate`, and `dashboard` containers
literally share `mock-bank`'s own private network identity — so, from inside any of them,
"localhost:4000" really does mean "the mock-bank container." This was chosen specifically so
the real, already-recorded evidence could keep meaning exactly what it meant when it was
recorded, rather than rewriting genuine recorded data just to make the container setup
tidier.

### "What happens if...?"

| Situation | What happens |
|---|---|
| You run `docker compose up --build` without ever creating `.env` | `capability-api` and `dashboard` crash-loop immediately — they throw at startup if their required secret isn't set, matching how they behave outside a container. |
| You try to run `npm run run-agent` (or any "watch it live" demo) inside a container | Not supported and not attempted — there's no display for a headed browser window to appear on inside a container; these still need to run directly on your own machine. |
| You call `http://localhost:4700` from your own terminal while Compose is running | Works exactly the same as calling `npm run capability-api` directly — same port, same behavior, because `mock-bank`'s `ports:` section maps 4700 out to your host machine. |
| A newly-disclosed security flaw is found in a base image or dependency | Not automatically caught by anything in this Compose setup itself — this repo's real dependency-vulnerability gate is in CI (`npm audit`), not in the container build. |
| You actually try to build these images right now | They have never been run through a real `docker build`/`docker compose up` in the environment that produced them, because Docker wasn't available there — see "What's honestly unverified" below. |
| Two people on different laptops both run `docker compose up --build` | Both get the identical set of four containers, with the identical Node.js version and Playwright browser binaries inside — that consistency is the entire point of using containers instead of "install this on your machine and hope it matches." |

---

## Part 2 — For engineers: why, what, how, where

### Why

The brief's own instruction not to over-build infrastructure for a project this size cuts
both ways here: containerizing *nothing* would leave no credible story for how these
services would actually be deployed anywhere but a developer's own laptop, but
containerizing *everything*, including the interactive demos, would be solving a problem
that doesn't exist (nobody deploys a "watch the AI click things live" demo to a headless
server). The split follows a real, structural fact about each program: does it need a
visible display, or not.

### What

Four services, three Dockerfiles, wired together by `docker-compose.yml`:

| Service | Dockerfile | Runtime base image | Runs as |
|---|---|---|---|
| `mock-bank` (port 4000) | `Dockerfile.mock-bank` | `node:20-slim` | non-root `node` user |
| `mock-bank-northgate` (port 4100, same image, `TENANT=northgate-cu`) | `Dockerfile.mock-bank` | `node:20-slim` | non-root `node` user |
| `capability-api` (port 4700) | `Dockerfile.capability-api` | `mcr.microsoft.com/playwright:v1.49.1-jammy` | **root** |
| `dashboard` (port 4600) | `Dockerfile.dashboard` | `node:20-slim` | non-root `node` user |

All three Dockerfiles are two-stage builds: a `builder` stage on `node:20-slim` runs
`npm ci`, compiles TypeScript with `npx tsc`, then `npm prune --omit=dev` to drop
`typescript`/`tsx`/`vitest`/`@types/*` before anything gets copied into the runtime stage —
so the shipped image only contains what's needed to actually run, not to build.

### How

**Why `capability-api` needs a heavier base image.** `mock-bank` and `dashboard` are plain
Express apps — `node:20-slim` is enough. `capability-api` actually launches a real
Playwright/Chromium browser to drive mock-bank on `POST /capabilities/:id/invoke` — headed
by default outside a container, but explicitly pinned back to headless here via
`CAPABILITY_API_HEADED=false` in `docker-compose.yml`, since a container has no display to
render a window on either way. Headed or headless, it needs real browser binaries, not just
`node_modules`. Its runtime stage uses
`mcr.microsoft.com/playwright:v1.49.1-jammy` instead — a base image Microsoft publishes with
browser binaries already baked in, version-matched to a specific Playwright release. That
version, `v1.49.1-jammy`, was chosen to exactly match `"playwright": "^1.49.1"` in
`package.json`, specifically so the browser binaries in the image match the driver version
this code calls — with a version mismatch, `npx playwright install` would be needed inside
the image at build time, which this setup avoids entirely.

**Why `capability-api` runs as root while the others don't.** `node:20-slim`'s built-in
non-root `node` user (uid 1000) is enough for `mock-bank` and `dashboard`, which are plain
Express servers with no special OS-level needs. `capability-api` is different for two
concrete reasons: Chromium's sandbox has real, non-trivial permission requirements under a
non-root user (this is Playwright's own documented default for their Docker images — not
this project inventing an exception), and this container also needs write access to the
bind-mounted `evidence/` volume. The Dockerfile's own comment calls this out explicitly as
"a real 'before this goes further than a demo' item, not an oversight" — worth revisiting if
this system were ever hardened for production use beyond a take-home demo.

**`network_mode: "service:mock-bank"`, precisely.** Normally each service in a Compose file
gets its own private network namespace and reaches the others by *service name*
(`http://mock-bank:4000`), not `localhost`. That doesn't work here because the checked-in
evidence (`evidence/artifacts/open-sub-account.artifact.json`'s `baseUrlPattern`, and
`config/tenant-overrides/*.json`) has the literal strings `"http://localhost:4000"` and
`"http://localhost:4100"` baked in from real recording sessions — rewriting that to point at
Compose service-discovery hostnames would mean modifying real recorded evidence for
deployment convenience, which this project treats as off-limits (the whole point of an
artifact is that it's a faithful record of what discovery actually did). Setting
`network_mode: "service:mock-bank"` on `mock-bank-northgate`, `capability-api`, and
`dashboard` makes each of them join `mock-bank`'s network namespace directly, so
`localhost` inside any of them genuinely resolves to `mock-bank`'s own loopback interface —
the same `localhost` the recorded evidence expects.

One consequence of this: Compose does not allow a service using
`network_mode: "service:*"` to also declare its own `ports:` — the *anchor* service
(`mock-bank`) has to own every host-facing port mapping for the whole group. That's why
`mock-bank`'s `ports:` list in `docker-compose.yml` carries all four: `4000:4000`,
`4100:4100`, `4700:4700`, `4600:4600` — even though 4700 and 4600 belong to entirely
different containers.

**Secrets never get baked into an image.** `docker-compose.yml` supplies
`CAPABILITY_API_KEY`/`DASHBOARD_PASSWORD` via `env_file: .env` at container *start* time,
not as part of the image build — the same fail-closed-if-unset behavior described in
[`19-security-and-authentication.md`](19-security-and-authentication.md) applies identically
whether these services run natively or in a container.

**Healthchecks avoid adding a dependency just for a check.** `node:20-slim` has Node's
built-in global `fetch` but no `curl`/`wget`, so each Dockerfile's `HEALTHCHECK` uses
`node -e "fetch(...).then(...)"` directly rather than installing a separate tool.

### Worked technical example

```bash
cp .env.example .env
docker compose up --build
```

Expected/realistic log output once healthy (illustrative — not captured from an actual
run, see the honesty note below):

```
mock-bank_1           | mock-bank listening on http://localhost:4000
mock-bank-northgate_1 | mock-bank listening on http://localhost:4100 (tenant: northgate-cu)
capability-api_1      | capability API listening on http://localhost:4700
dashboard_1           | dashboard listening on http://localhost:4600
```

```bash
curl -s http://localhost:4700/health
# {"status":"ok"}
```

### What's honestly unverified

**No `docker build`/`docker compose up` was ever actually run in the environment that
produced these files** — Docker itself wasn't available there (confirmed by directly
attempting `docker --version`, not assumed). Two specific things *were* independently
verified rather than guessed, to reduce the risk of a purely-imagined Dockerfile:

- The `dist/` output paths each Dockerfile's `CMD`/`COPY` steps depend on
  (e.g. `dist/apps/mock-bank/src/server.js`, `dist/src/api/server.js`) were confirmed by
  actually running `npx tsc` against this repo's real `tsconfig.json` and inspecting the
  real output layout, not by assuming where TypeScript's compiler would put things.
- The base image tag `mcr.microsoft.com/playwright:v1.49.1-jammy` was confirmed to actually
  exist (and be multi-arch, amd64 + arm64) via the Microsoft Container Registry's own tags
  API (`curl -s https://mcr.microsoft.com/v2/playwright/tags/list`), and cross-checked that
  that Playwright release's own published Dockerfile installs a Node.js version
  (22.x) compatible with this repo's `"engines": {"node": ">=20"}`.

Everything else — whether the images actually build, whether the containers actually start
and reach `service_healthy`, whether the `network_mode` trick behaves as described in
practice — is **reviewed for correctness, not build-verified**. If this went further than a
take-home submission, running a real `docker compose up --build` end to end would be the
first thing to do before trusting any of this in production.

### Edge cases & failure modes

- **`.env` missing or incomplete when Compose starts** — `capability-api`/`dashboard`
  crash-loop with the same fail-closed error they'd throw natively; `mock-bank` needs no
  secret and starts regardless.
- **EJS view templates not copied** — `tsc` only compiles `.ts` files, so
  `Dockerfile.mock-bank` explicitly `COPY`s `apps/mock-bank/views` by hand into the exact
  path the compiled `server.js` expects at runtime (`dist/apps/mock-bank/views`, because
  `__dirname` at runtime is `dist/apps/mock-bank/src` and the code does
  `path.join(__dirname, "..", "views")`). Missing this copy would make mock-bank crash on
  its first page render, not at startup.
- **A Playwright/package.json version drift** (e.g. bumping `playwright` in `package.json`
  without bumping the base image tag in `Dockerfile.capability-api`) — would silently mismatch
  driver and browser-binary versions; nothing in this setup automatically re-checks that
  match today.
- **Running the headed-browser demos expecting them to work in a container** — not
  supported by design; there's no display attached to a container for a real Chromium
  window to render onto.
- **Trusting this as build-verified** — explicitly not the right read; see "What's honestly
  unverified" above.

## Related docs

- [`01-system-design.md`](01-system-design.md) — the interactive-vs-unattended split at the top of the module map
- [`19-security-and-authentication.md`](19-security-and-authentication.md) — how secrets reach these containers without being baked into images
- [`23-continuous-integration.md`](23-continuous-integration.md) — the other piece of infrastructure this project added deliberately, and just as deliberately kept small
- [`02-glossary.md`](02-glossary.md) — the short definition of "Container / Docker" this file expands on
- [`../SECURITY.md`](../SECURITY.md) — "Containers" section, the security-focused version of this same story
- [`../README.md`](../README.md) — "Running via Docker Compose" for the same walkthrough with real commands
