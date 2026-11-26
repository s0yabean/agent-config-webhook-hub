# API

Every function is served at `/api/<name>` (and at `/.netlify/functions/<name>`).
Locally that is `http://127.0.0.1:8888`. All responses are JSON with a `success` flag;
errors carry `error`.

Access levels:

| Level | Who | How |
|---|---|---|
| **read** | agent workflows | Open, unless `AGENT_API_KEY` is set; then send it as `X-Api-Key`. An admin token also works. |
| **admin** | the panel, scripts | `Authorization: Bearer <token>` from `POST /api/login`. Open locally when `ADMIN_PASSWORD` is empty; on Netlify admin routes return `503` until it is set. |
| **public** | WAHA | The receiver. Optionally checks `X-Webhook-Hmac` when `INBOUND_HMAC_SECRET` is set. |

`parentId` is a namespace (an agent, a workflow, a contact directory). It defaults to
`default` and must be 1-100 characters of letters, digits, `_ . : -`.

## Auth

```bash
curl http://127.0.0.1:8888/api/login                       # {"authRequired": false}
curl -X POST http://127.0.0.1:8888/api/login \
  -H 'Content-Type: application/json' -d '{"password":"..."}'
# {"success":true,"token":"<exp>.<hmac>","expiresAt":"..."}   valid 12 h
```

## Config values

| Method | Function | Level | Parameters | Notes |
|---|---|---|---|---|
| GET | `getValue` | read | `key`, `parentId` | `404` if the namespace or key is missing. Key can also be a path segment: `/api/getValue/<key>`. |
| GET | `getAllValues` | read | `parentId` | `{}` for an empty namespace. |
| GET | `getFilteredValues` | read | `parentId`, `searchTerms` | Comma-separated terms; case-insensitive substring match on **values**; any term matches. No terms returns all. |
| GET | `getAllParentIds` | read | | Always starts with `default`. |
| POST | `saveValues` | admin | body `{pairs, parentId?, mode?}` | `pairs` is string to string. `mode: "merge"` (default) keeps other keys; `"replace"` makes the namespace equal to `pairs`. Returns `added / updated / unchanged / removed` counts. |
| DELETE | `deleteValue` | admin | `key`, `parentId` | Removes one key. `404` if absent. |
| DELETE | `deleteBlob` | admin | `parentId` | Removes the whole namespace. |

```bash
curl "http://127.0.0.1:8888/api/getValue?parentId=support-bot&key=max_reply_chars"
# {"success":true,"value":"600"}

curl "http://127.0.0.1:8888/api/getFilteredValues?parentId=contacts-demo&searchTerms=refund,wholesale"
# {"success":true,"pairs":{"15550100102@c.us":"Priya Nair (synthetic) - wholesale enquiry", ...}}

curl -X POST http://127.0.0.1:8888/api/saveValues -H 'Content-Type: application/json' \
  -d '{"parentId":"support-bot","pairs":{"max_reply_chars":"400"}}'
# {"success":true,"parentId":"support-bot","added":0,"updated":1,"unchanged":0,"removed":0,...}
```

In zsh, quote URLs that contain `?` or `&`.

## Webhook routes

A route says: events from WhatsApp sender `sender_id` go to `webhookUrl`.

```json
{
  "parentId": "support-bot",
  "sender_id": "15550100001@c.us",
  "webhookUrl": "https://example.com/agent-webhook",
  "description": "optional",
  "isActive": true,
  "headers": { "X-Agent-Name": "support-bot" },
  "secret": "optional; signs forwarded bodies"
}
```

| Method | Function | Level | Notes |
|---|---|---|---|
| GET | `getAllWebhooks` | admin | Secrets are never returned; each route has `hasSecret`. |
| GET | `getWebhook/<parentId>` | admin | |
| POST | `saveWebhook` | admin | Create (`201`) or update (`200`) by `parentId`. `sender_id` must be `<digits>@c.us` or `<digits>@g.us`. Two active routes cannot share a sender (`409`). On update, omit `secret` to keep it, send `""` to clear it. |
| DELETE | `deleteWebhook/<parentId>` | admin | |
| POST | `testWebhook/<parentId>` | admin | Sends `{"test":true,...}` once with `X-Test-Webhook: true`. Always `200`; `success` says whether the target accepted it. Logged as a delivery. |
| GET | `getWebhookLogs/<parentId>` | admin | Last 100 deliveries to that route: status code, attempts, response time, error. |
| GET | `getIncomingWebhookLogs` | admin | Last 100 requests that reached the receiver, newest first. |

## Receiver

`POST /api/webhookReceiver` is the URL you give WAHA as its webhook.

1. If `INBOUND_HMAC_SECRET` is set, `X-Webhook-Hmac` must be the hex HMAC-SHA512 of the raw body, else `401`.
2. The sender is read from `payload.from` on `event: "message"` (or `sender.attendee_provider_id`).
3. The first **active** route with that `sender_id` wins. No sender or no route: `403`.
4. The raw body is forwarded with `POST`. If the route has a `secret`, the hub adds
   `X-Webhook-Signature: hex(HMAC-SHA256(secret, body))`. Up to 3 attempts, 2.5 s timeout each,
   retrying network errors, `429` and `5xx` (not other `4xx`).
5. Result: `200 {"success":true,"parentId":...,"attempts":n}` or `502` with the last error.

Every request writes exactly one incoming-log entry:

```json
{
  "timestamp": "2026-01-01T10:00:00.000Z",
  "sender_id": "15550100001@c.us",
  "event_type": "message",
  "raw_payload": { "...": "as received, truncated at 10 000 chars" },
  "determined_parent_id": "support-bot",
  "status": "forwarded | rejected | failed",
  "reason": "why it was rejected or failed"
}
```

Set `LOG_RAW_PAYLOADS=false` to keep message text out of the log.
