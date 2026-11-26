// Post synthetic WAHA-style "message" events to the receiver, the way WAHA
// would. Usage: npm run send-sample [-- --base http://127.0.0.1:8888]
import { createHmac } from "node:crypto";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : process.env.HUB_URL || "http://127.0.0.1:8888";

/** All synthetic: fictional 555-01xx numbers matching data/seed.json. */
const samples = [
  { from: "15550100001@c.us", body: "Hi, my order has not arrived yet (synthetic)", expect: "forwarded to support-bot" },
  { from: "15550100002@c.us", body: "Can I book a slot on Friday? (synthetic)", expect: "forwarded to booking-bot" },
  { from: "15550100003@c.us", body: "Hello? (synthetic)", expect: "failed: target returns 500, retried" },
  { from: "15550100004@c.us", body: "Anyone there? (synthetic)", expect: "rejected: route is inactive" },
  { from: "15550109999@c.us", body: "Unknown sender (synthetic)", expect: "rejected: no route" }
];

for (const [i, s] of samples.entries()) {
  const body = JSON.stringify({
    event: "message",
    session: "default",
    payload: {
      id: `synthetic-msg-${i + 1}`,
      timestamp: Math.floor(Date.now() / 1000),
      from: s.from,
      fromMe: false,
      body: s.body,
      hasMedia: false
    }
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.INBOUND_HMAC_SECRET) {
    headers["X-Webhook-Hmac"] = createHmac("sha512", process.env.INBOUND_HMAC_SECRET).update(body).digest("hex");
  }
  const res = await fetch(`${base}/api/webhookReceiver`, { method: "POST", headers, body });
  const text = await res.text();
  console.log(`${s.from}  ->  ${res.status}  ${text}\n    expected: ${s.expect}`);
}
console.log(`\nOpen ${base}/#logs to see each one in the incoming webhook log.`);
