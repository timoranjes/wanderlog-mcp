# Wanderdog — agent instructions

Wanderdog is an MCP server that exposes [Wanderlog](https://wanderlog.com) trip editing to LLM agents. TypeScript ESM, stdio (primary) plus HTTP transport, cookie-based auth. Node ≥22.

This fork (`timoranjes/wanderlog-mcp`) adds 7 custom tools on top of upstream: `replace_place_note`, `reorder_day`, `batch_add_places`, `remove_duplicate_places`, `move_place`, `undo`, `add_link_note`.

## Repository layout (what's actually here)

```
probe.mjs              # standalone ShareDB WS probe (npm run probe)
llms-install.md        # npx-based install instructions for MCP clients
src/
  index.ts             # stdio entry — auth probe on startup, then serves tools
  server.ts            # McpServer wiring: registers every tool + SERVER_INSTRUCTIONS
  http.ts              # optional HTTP transport (npm run start:http)
  config.ts            # env → Config (cookie, baseUrl, wsBaseUrl, userAgent)
  context.ts           # AppContext: rest client, trip cache, sharedb pool, auth state
  errors.ts            # WanderlogError hierarchy (auth/notfound/network/validation...)
  forwarding-email.ts  # trip+<id>@wanderlog.com derivation
  transport/
    rest.ts            # REST client — every request now has a 45s AbortController timeout
    sharedb.ts         # ShareDB JSONv0 WS client + pool. Per-trip WebSocket.
  cache/trip-cache.ts  # live per-trip snapshot cache (REST pre-check + WS subscribe)
  ot/apply.ts          # JSON0 op application to maintain a live local snapshot
  resolvers/           # day.ts (day refs), place-ref.ts (natural place matching)
  formatters/trip-summary.ts  # concise/detailed trip → text
  tools/               # one file per MCP tool + shared.ts (submitOp + helpers)
tests/
  unit/                # fast, no network (npm run test)
  integration/         # live against wanderlog.com, needs .env (npm run test:integration)
  fixtures/            # typed trip snapshots used by tests
```

There is **no `docs/` directory in this fork** — it's gitignored upstream and was never tracked here. The authoritative references for behaviour and protocol are this file, `README.md`, and the source itself.

## Read before making changes

1. `README.md` — what's shipped, tool list, changelog
2. `src/server.ts` — how tools are registered and the `SERVER_INSTRUCTIONS` contract
3. `src/transport/sharedb.ts` + `src/transport/rest.ts` — the protocol layer (most failure modes live here)
4. `src/tools/shared.ts` — `submitOp`, the mutation path all tools must use

## Invariants (do not violate)

1. Never assume block shape. Real trips contain `place`, `note`, `flight`, `train`, and unknown types. Always discriminate on `block.type` with a fallback.
2. Never expose raw IDs (`place_id`, section indices, ShareDB paths) to the LLM by default. Use natural references.
3. Every REST response is `{success, payload}`-shaped in practice — always unwrap, never pass the envelope through.
4. Startup must surface auth errors clearly. The server stays alive (for hosting platform health checks) but every tool returns an auth-required error until valid credentials are provided. The startup auth probe (`src/index.ts`) is what catches an expired cookie.
5. Cookie value must never appear in tool responses, logs, or error messages (there's a `secret-leak` unit test enforcing this).
6. Section indices are not stable across edits. Always resolve by `date`/`heading`/`type` from a fresh snapshot.
7. Natural language in, natural language out — the LLM shouldn't need to touch ShareDB paths or `ChIJ...` place_ids.
8. **All mutations go through `submitOp` in `src/tools/shared.ts`.** That helper holds the per-trip mutex, wraps the submit in try/catch, and invalidates the cache on failure. Do NOT call `ShareDBClient.submit()` directly from a tool — it bypasses parallel-safety and cache-consistency guarantees.
9. Failed submits must invalidate the cache (`tripCache.invalidate(tripKey)`) so the next read refetches a fresh snapshot.
10. Error frames in `ShareDBClient.handleFrame` must be matched by `seq` first; only fall back to `failAllPending` when the error can't be attributed. One op's error must not kill unrelated in-flight ops.

If a change would require violating one of these, stop and ask the user — don't work around it.

## Known failure modes (learned the hard way)

- **Unhandled promise rejection in `scheduleReconnect`** crashed the whole server on Node ≥15 (fixed in `e844e2c`): `void this.subscribe().then(...)` must have a `.catch()`. Reconnect subscribe failures are logged, never left floating.
- **Half-open WebSocket poisoning**: on subscribe timeout, the TCP socket can still show ESTABLISHED while the peer has silently stopped responding. Leaving it open poisons every future subscribe. The timeout handler now `terminate()`s the socket and resets `subscribed`/`handshakeComplete` so the next call opens a fresh connection.
- **REST hangs**: `RestClient.request` previously had no timeout — a hung upstream held the MCP call until the client's outer timeout killed the server. Now every request is bounded by a 45s `AbortController` (see `rest.ts`).
- Wanderlog rate-limits rapid edits — the submit path retries with backoff. Don't "fix" an opaque `Submit op timeout` by lowering timeouts; the retry logic is intentional.

## Dev commands (from package.json)

```bash
npm run build            # tsc → dist/
npm run test             # unit tests only (no network, fast)
npm run test:integration # live tests against wanderlog.com (requires .env)
npm run test:all         # both
npm run typecheck        # tsc --noEmit
npm run probe            # standalone ShareDB WS probe (probe.mjs; uses WANDERLOG_TRIP_KEY)
npm run start:http       # HTTP transport instead of stdio
npm run lint             # eslint .
npm run dev              # tsx watch with .env
```

After changing any `src/**` file, always run `npm run build && npm run test` before claiming the work is done. For changes to `src/transport/**` or `src/tools/**`, also run `npm run test:integration`.

## Don't

- Don't create new top-level docs or README files — extend the existing ones instead. There's no `docs/` dir; keep knowledge in README, this file, or code comments.
- Don't add dependencies without a reason. We intentionally use native `fetch` over `undici`, vitest without plugins, and zero HTTP client libraries. Justify new deps in the PR description.
- Don't write comments explaining what code does — names should. Only comment *why* when the reason is non-obvious (hidden constraint, workaround for a specific bug, surprising behavior).
- Don't commit `.env` or anything containing a `connect.sid` value. `.gitignore` already covers `.env` but double-check before `git add`.
- Don't skip the auth probe on startup. It's cheap and it catches the #1 failure mode (expired cookie) immediately.
- Don't re-derive the Wanderlog protocol from HAR files if the source + README already cover what you need. Update those instead when you discover something new.

## Secrets

The `connect.sid` cookie in `.env` is long-lived (~1 year). Treat it as a high-value credential. It's gitignored and should stay that way. If you ever think you need to print it for debugging, you don't — the auth probe tells you whether it's valid without leaking the value.