# Phase 3B.4 disposable UI acceptance harness

This harness runs PostgreSQL 16 and the real `createApp()` on an outbound-isolated
Docker network. Neither PostgreSQL nor the API joins an egress-capable network.
A fixed-upstream, non-root Nginx proxy alone joins that network and a separate
ingress network, publishing only `127.0.0.1:3304`. It is not a forward proxy and
can route only to `api:3304`. The existing frontend runs on `127.0.0.1:5174`.
The harness never imports `src/app/server.ts`, starts workers, or grants trading
authority.

## Operator workflow

Run these commands from the repository root, in order:

```text
npm run acceptance:ui:start
npm run acceptance:ui:migrate
npm run acceptance:ui:fixture
npm run acceptance:ui:api
npm run acceptance:ui:network-check
npm run acceptance:ui:verify
npm run acceptance:ui:web
npm run acceptance:ui:urls
```

`fixture` creates local random credentials and writes the gitignored
`.acceptance/ui/manifest.json`. The manifest contains the three role emails, the
one-run password, account IDs, intent IDs, and direct scenario URLs. Do not paste
it into logs or commit it. Login normally in the browser, then open a URL allowed
for that role.

The read-only guard permits only `POST /api/auth/login` and
`POST /api/auth/logout`. Session validation is `GET /api/auth/me`. All other
POST/PUT/PATCH/DELETE requests are rejected before business routes.

`acceptance:ui:network-check` proves the API and database have only the internal
gateway-less interface and no published ports, proves the proxy is bound only to
`127.0.0.1:3304`, attempts and fails an external request from the API container,
and proves the proxy cannot be used with an arbitrary target.

## Safety proof

- Exact sentinel, database/user/host/port, non-production environment, port 3304,
  disabled live flags, inert credential sentinels, and the database marker are
  checked before `createApp()` is imported.
- Runtime containers use the Compose project `ai-trader-ui-acceptance`, labeled
  resources, an `internal: true` API/database network, a separate proxy ingress
  network, dropped Linux capabilities, read-only filesystems, and one loopback-only
  published proxy port.
- A global fetch barrier rejects every non-loopback destination. The API contains
  no broker worker or broker submission entrypoint.
- `docker-compose.acceptance.yml` names only acceptance resources. Teardown uses
  the same explicit project file and project name.

## Manual visual checklist

At desktop and a narrow/mobile width, verify all ten manifest URLs, pagination,
gate cards, comparison labels, opportunity/event chronology, and responsive detail
panels. Specifically confirm zero gates for `aapl_none_visible_zero_gates`, two
separate opportunities for `aapl_multiple_opportunities`, uncertainty followed by
recovery, technical failure, and terminal retry exhaustion.

Log in as each role. SYSTEM_OWNER should see all scenarios and raw evidence.
OPERATOR should see only its two memberships and receive 403 for raw evidence.
ACCOUNT_USER should see only Acceptance Alpha, receive 404 for the restricted
intent, see redacted gate policy/fingerprint fields, and remain unable to read the
Entry Decisions API where its existing permission set prohibits it.

## Cleanup

Stop the web dev process, then run:

```text
npm run acceptance:ui:stop
```

This removes only containers, network, and volumes in the explicitly named
`ai-trader-ui-acceptance` Compose project. The gitignored manifest and secret files
remain local so they can be inspected; delete `.acceptance/ui` manually only after
review if desired.
