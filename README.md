# PromQL Helper

**[Documentation →](https://jamiegunn.github.io/promql-helper/)**

A diagnostic wizard for Prometheus. You pick a **question about your system** —
"is this service serving happy users?", "is this app pummelling the database?" —
and it works out which metrics in *your* Prometheus can answer it, runs the
queries, and tells you what it found in plain language.

It is not a metric browser and not a PromQL tutorial. The PromQL is there if you
want it (every panel has a **PromQL** button), but you never have to write any.

```
Pick a service  →  Choose a question  →  Read the answer
```

---

## Quick start

```bash
npm install
cp .env.example .env      # then fill in PROMETHEUS_URL and PROMETHEUS_TOKEN
npm run dev               # API on :8787, UI on :5173
```

Open <http://localhost:5173>.

For a production-style single process serving both:

```bash
npm run build
npm start                 # everything on :8787
```

### When the port is already taken

If something already holds `PORT`, the server says what has it and stops rather
than dumping a stack trace:

```
  Port 8787 is already in use.

  Held by  PID 79324 — node src/server/index.ts
           another PromQL Helper server from this directory

  What you can do:

    npm run dev:takeover     stop it and take the port
    PORT=8788 npm run dev    run this one alongside it, on its own port
    kill 79324               stop it yourself
```

`npm run dev:takeover` stops the old server and takes the port. It only ever
stops a server started from this same directory — anything else is reported and
left running, even with takeover enabled.

### Running more than one instance

Set `PORT`. The Vite dev server reads the same variable, so its API proxy
follows automatically, and Vite steps to the next free UI port on its own:

```bash
npm run dev                 # API :8787, UI :5173
PORT=8788 npm run dev       # API :8788, UI :5174 — talks to its own API
```

## Configuration

Settings come from `.env` in the project root, or from real environment
variables. A real environment variable always wins, so the same image can be
deployed with `-e PROMETHEUS_URL=…` and no file at all.

Start from the template:

```bash
cp .env.example .env
```

### Every variable

| Variable | Default | What it does |
|---|---|---|
| `PROMETHEUS_URL` | — | **Required.** Base URL of the Prometheus HTTP API, no trailing `/api/v1`. The process exits with an explanation if it is unset. |
| `PROMETHEUS_TOKEN` | empty | Bearer token. Sent as `Authorization: Bearer <token>`. Leave unset for an unauthenticated Prometheus. |
| `PROMETHEUS_HEADERS` | empty | Extra headers as a JSON object. For basic auth, tenant IDs, or an access proxy. |
| `PROMETHEUS_INSECURE` | `0` | `1` skips TLS verification. Disables it for the whole process — self-signed certs on a trusted network only. |
| `PROMETHEUS_TIMEOUT_MS` | `30000` | Abandon a Prometheus request after this long. Raise it if long range queries time out. |
| `CATALOG_TTL_SECONDS` | `300` | How long the metric catalogue is cached. It changes rarely and is expensive to fetch. |
| `PORT` | `8787` | Port the API listens on. The Vite dev server reads it too. |
| `PORT_TAKEOVER` | `0` | `1` stops an existing server holding that port instead of failing. Only ever stops a server from this same directory. |

### Authenticating

**Bearer token** — the common case, and what most Prometheus deployments behind
an ingress or an OAuth proxy expect:

```bash
PROMETHEUS_URL=https://prometheus.internal.example.com
PROMETHEUS_TOKEN=eyJhbGciOi...
```

That is sent as `Authorization: Bearer eyJhbGciOi...` on every request.

**Basic auth** — leave `PROMETHEUS_TOKEN` empty and set the header yourself.
Anything in `PROMETHEUS_HEADERS` is sent as-is, and `Authorization` is only
overwritten when a bearer token is also set:

```bash
PROMETHEUS_TOKEN=
PROMETHEUS_HEADERS={"Authorization":"Basic dXNlcjpwYXNzd29yZA=="}
```

Generate the value with `printf 'user:password' | base64`.

**Multi-tenant or behind a proxy** — add whatever headers it needs. These
combine with a bearer token:

```bash
PROMETHEUS_TOKEN=eyJhbGciOi...
PROMETHEUS_HEADERS={"X-Scope-OrgID":"team-payments","CF-Access-Client-Id":"..."}
```

**Not supported:** AWS SigV4 request signing, so Amazon Managed Prometheus will
not work without a sidecar proxy such as `aws-sigv4-proxy` in front of it. Point
`PROMETHEUS_URL` at the proxy.

> **The token never reaches the browser.** It is read by the Node process and
> attached there. The frontend only ever calls this app's own `/api`, so the
> token cannot appear in a network tab, a bookmark, or a screenshot. In
> production a single process serves both the API and the built UI, so there is
> no cross-origin surface at all.

### Checking it worked

```bash
curl -s localhost:8787/api/health
```

```json
{"connected":true,"url":"https://prometheus...","authenticated":true,"version":"3.13.0","metricCount":4821}
```

`authenticated` reports whether a bearer token is configured, not whether the
server demanded one. If `connected` is false the `error` field says why — a
wrong URL, a rejected token, and a timeout each produce a different message.

Then open the app and click **Help** to see every metric it knows how to look
for, and which of them exist in your Prometheus.

---

## Try it without a Prometheus

The repo ships synthetic exporters and a Prometheus scrape config, so you can
see the whole thing work before pointing it at anything real:

```bash
npm run demo    # fixture exporters + Prometheus in Docker + API + UI
```

Then set `PROMETHEUS_URL=http://localhost:9090` in `.env` and open
<http://localhost:5173>. Give it a minute or two to accumulate range data.

The fixture pretends to be a Spring Boot service called `checkout-api` running
two pods, alongside Redis, Postgres, cAdvisor and kube-state-metrics. A few
problems are deliberately baked in — a slow `/api/checkout` endpoint, a
connection pool that runs out, a Redis instance evicting keys — so the findings
engine has something real to find.

---

## The five questions

| Investigation | Answers |
|---|---|
| **Service health** | Traffic, failure rate and latency percentiles per endpoint. The RED method. |
| **CPU & memory** | Usage over time with a p50/p90/p95/p99 breakdown, against the pod's configured limits — including whether those limits are throttling it. |
| **JVM health** | Heap pressure, GC overhead, and whether threads are blocked rather than working. |
| **Database pressure** | Connection-pool saturation from the app side, checked against what the database server reports — so a starved pool is distinguishable from an overloaded database. |
| **Redis pressure** | Command throughput, hit ratio, evictions, and whether the app is calling something that blocks the single Redis thread. |

Each one only appears if your metrics can actually answer it. Where they can't,
the card explains what to instrument.

---

## How it works

One Node process sits between the browser and Prometheus. It is not a
passthrough proxy — the browser never names a metric or writes a query. It asks
for an *investigation* and gets back a finished report.

```mermaid
flowchart LR
    B["Browser<br/>React wizard<br/>no token, ever"]
    S["Node process — Hono<br/>routes · engine · signals<br/>playbooks · catalog<br/>adds Authorization: Bearer"]
    P["Prometheus<br/>HTTP API"]

    B -- "ask" --> S
    S -- "report JSON" --> B
    S -- "PromQL" --> P
    P -- "samples" --> S
```

The interesting part is how a plain-language question becomes PromQL that
matches *your* metric names:

```mermaid
flowchart TD
    Q["Is this service serving happy users?"]
    A["the playbook asks for abstract signals<br/>http.requests.count · http.latency.histogram"]
    C["each signal lists candidates, in preference order<br/>Micrometer · OpenTelemetry · Prometheus client"]
    R["resolved for this job<br/>http_server_requests_seconds_count<br/>route=uri · status=status"]
    P1["build PromQL"]
    P2["run it"]
    P3["interpret to a verdict"]

    Q --> A --> C
    C -- "one instant query, not one per candidate" --> R
    R --> P1 --> P2 --> P3
```

There is a fuller version of this, plus the three scopes and a module map, in
[the architecture page](https://jamiegunn.github.io/promql-helper/architecture.html).

### Signals, not metric names

The hard part is that no two services name anything the same way. Spring Boot
calls the HTTP path `uri`; the Prometheus Java client calls it `handler`;
OpenTelemetry calls it `http_route`. Playbooks are written against abstract
**signals** — `http.requests.count`, `db.pool.pending` — and `src/server/signals.ts`
maps each one to a list of candidate metric names per instrumentation convention.

Resolution folds every candidate into a single instant query
(`count by (__name__) ({__name__=~"a|b|c", job="…"})`), so one round trip
establishes which metrics exist *for this target* and how many series each has.
Signals in the same `family` are forced to agree on one convention, or their
label names wouldn't line up.

### Three scopes

Not everything lives under the job you picked:

- **`target`** — the app's own `/metrics` endpoint.
- **`dependency`** — a Redis or Postgres exporter, under its own job. The UI
  offers a dropdown to pick which one.
- **`infra`** — cAdvisor and kube-state-metrics, which scrape under their own
  jobs and are keyed by `namespace`/`pod`. The app asks Prometheus which
  namespace and pods the *application's* series carry and builds a selector from
  that. If the app's metrics have no such labels, these become gaps with an
  explanation rather than silently matching the whole cluster.

### Findings

Each panel carries an `interpret` function that turns numbers into a sentence
with a severity. The report's verdict is the **worst** finding, not an average —
averaging would hide exactly the panel that matters.

---

## Layout

```
src/
  shared/types.ts          Types shared by server and browser
  server/
    config.ts              Env loading and validation
    prom.ts                Prometheus HTTP client (POST for queries, GET elsewhere)
    catalog.ts             Cached metric catalog, target discovery, selector building
    signals.ts             The signal registry — where new conventions get added
    engine.ts              Resolve → filter panels → run → interpret → verdict
    capabilities.ts        The audit behind the in-app Help page
    playbooks/             One file per investigation
    index.ts               HTTP routes
  web/                     React wizard and Help page; hand-rolled SVG charts, no chart library
scripts/
  fake-exporters.ts        Synthetic metrics for the demo
  prometheus.yml           Scrape config for the demo
```

### Adding support for your stack

If an investigation shows as unavailable but you know the data exists, add a
candidate to the relevant signal in `src/server/signals.ts`:

```ts
{
  flavor: 'My framework',
  metric: 'myapp_http_requests_total',
  labels: { route: 'endpoint', status: 'status_code', method: 'verb' },
  errorPattern: '5..',
}
```

Order is preference order — the first candidate that exists wins.

---

## Known limitations

Worth knowing before you rely on it:

- **The signal registry is a curated allowlist.** It only recognises the metric
  names in `signals.ts`. An unusual naming convention shows as "not available"
  even though the data is there. Adding a candidate fixes it, but it doesn't
  discover conventions on its own.
- **Thresholds are universal; systems aren't.** "p99 > 1s = warning" is wrong for
  a batch job or a report generator. The findings are opinionated defaults, not
  calibrated to your SLOs.
- **Each investigation is siloed.** Service health doesn't know the connection
  pool is saturated. The cross-domain synthesis is still yours to do.
- **It shows level, not change.** Everything is "over the last N" — there is no
  deploy marker or week-over-week comparison, and diagnosis is usually about what
  changed.
- **Target discovery is an expensive query.** `count by (job) ({__name__=~".+"})`
  touches every series. On a very large Prometheus that first page load will be
  slow.

---

## Documentation site

User-facing docs live in [`docs/`](docs/) and are plain HTML and CSS with no
build step — an overview, a screenshot-led walkthrough, a page describing every
investigation and the thresholds behind each finding, and a reference covering
configuration and internals.

Preview locally:

```bash
npm run docs:serve      # http://localhost:8090
```

### Deploying to GitHub Pages

Either method works; pick one.

**GitHub Actions** (what `.github/workflows/pages.yml` does). In
**Settings → Pages → Source**, choose **GitHub Actions**. The workflow publishes
`docs/` on every push to `main` that touches it, and can be run by hand from the
Actions tab.

**Deploy from a branch.** In **Settings → Pages → Source**, choose
**Deploy from a branch**, then `main` and the `/docs` folder. No workflow needed —
delete `.github/workflows/pages.yml` if you go this way.

Every path in the site is relative, so it works at a project subpath
(`https://you.github.io/promql_helper/`) as well as at a domain root.

### Maintaining it

The screenshots are captured from the real app running against the demo stack,
so they never drift into fiction. With `npm run demo` up:

```bash
npm i -D playwright && npx playwright install chromium   # once
npm run docs:shots      # regenerate every screenshot, light and dark
npm run docs:verify     # broken links, images, anchors, overflow, console errors
```

Playwright is deliberately not a dependency — it is only needed to regenerate or
check the docs, not to run the app.

## Scripts

| | |
|---|---|
| `npm run dev` | API with watch + Vite dev server |
| `npm run demo` | Fixtures + Prometheus + API + UI, all at once |
| `npm run build` / `npm start` | Production build, single process |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run fixture` | Synthetic exporters only, on :9101 |
| `npm run prometheus` | Prometheus in Docker against the fixture config |
| `npm run docs:serve` | Serve `docs/` on :8090 |
| `npm run docs:shots` | Regenerate docs screenshots from the running app |
| `npm run docs:verify` | Check the docs site for broken links and images |
