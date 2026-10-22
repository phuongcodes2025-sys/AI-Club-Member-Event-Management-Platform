import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrations, IntegrationUnavailable } from "../src/integrations.js";

function harness(config = {}) {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), ...options });
    if (String(url).includes("/token")) {
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    }
    if (String(url).endsWith("/sendMail") || String(url).endsWith("/cancel")) {
      return new Response(null, { status: 202 });
    }
    return Response.json({ id: "outlook-event" });
  };
  return {
    requests,
    integrations: createIntegrations({
      tenant: "test-tenant", client: "test-client", secret: "test-only-placeholder",
      mailbox: "club@example.invalid", ...config,
    }, fetcher),
  };
}

test("Graph sends plain-text email and reuses its server-side access token", async () => {
  const { requests, integrations } = harness();
  const mail = { to: "member@example.invalid", subject: "Workshop", body: "<not HTML>" };
  await integrations.email(mail);
  await integrations.email(mail);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.get("grant_type"), "client_credentials");
  const payload = JSON.parse(requests[1].body);
  assert.equal(payload.message.body.contentType, "Text");
  assert.equal(payload.message.body.content, "<not HTML>");
  assert.equal(requests[1].headers.Authorization, "Bearer " + "test-token");
  assert.equal(requests[1].redirect, "error");
});

test("missing Graph configuration defers delivery without a request", async () => {
  const { integrations, requests } = harness({ secret: undefined });
  await assert.rejects(integrations.email({ to: "member@example.invalid" }), IntegrationUnavailable);
  assert.equal(requests.length, 0);
});

test("empty member email is safely skipped", async () => {
  const { integrations, requests } = harness();
  await integrations.email({ to: "" });
  assert.equal(requests.length, 0);
});

test("Discord announcements disable mentions and limit message length", async () => {
  const { integrations, requests } = harness({ discord: "https://discord.com/api/webhooks/test" });
  await integrations.announce("discord", { title: "@everyone", description: "x".repeat(3000) });
  const payload = JSON.parse(requests[0].body);
  assert.deepEqual(payload.allowed_mentions.parse, []);
  assert.equal(payload.content.length, 2000);
});

test("Teams announces with an adaptive card", async () => {
  const { integrations, requests } = harness({ teams: "https://example.invalid/teams-hook" });
  await integrations.announce("teams", { title: "AI Club", location: "Room 1" });
  const payload = JSON.parse(requests[0].body);
  assert.equal(payload.attachments[0].content.type, "AdaptiveCard");
  assert.match(payload.attachments[0].content.body[0].text, /AI Club/);
});

test("webhook requests require HTTPS and Discord host validation", async () => {
  const { integrations, requests } = harness({ teams: "http://example.invalid/hook", discord: "https://example.invalid/discord" });
  await assert.rejects(integrations.announce("teams", {}), /HTTPS/);
  await assert.rejects(integrations.announce("discord", {}), /HTTPS/);
  assert.equal(requests.length, 0);
});

test("provider failures never expose webhook URLs or response bodies", async () => {
  const integrations = createIntegrations({ discord: "https://discord.com/api/webhooks/test" },
    async () => new Response("sensitive provider detail", { status: 403 }));
  await assert.rejects(integrations.announce("discord", {}), {
    message: "Integration request failed (HTTP 403)",
  });
});

test("Outlook calendar creates idempotently, updates, and cancels via Graph", async () => {
  const { integrations, requests } = harness();
  const event = {
    id: "df6987c9-125b-444a-976f-679e193df684", title: "Workshop", description: "Learn",
    starts_at: "2026-11-01T12:00:00Z", ends_at: "2026-11-01T13:00:00Z", location: "Lab",
  };
  assert.equal(await integrations.calendar(event), "outlook-event");
  assert.equal(JSON.parse(requests[1].body).transactionId, event.id);
  assert.equal(requests[1].method, "POST");
  await integrations.calendar({ ...event, outlook_event_id: "outlook-event" });
  assert.equal(requests[2].method, "PATCH");
  assert.equal(JSON.parse(requests[2].body).transactionId, undefined);
  await integrations.calendar({ ...event, outlook_event_id: "outlook-event", cancelled_at: new Date() });
  assert.equal(requests[3].method, "POST");
  assert.match(requests[3].url, /outlook-event\/cancel$/);
  assert.equal(await integrations.calendar({ ...event, cancelled_at: new Date() }), null);
  assert.equal(requests.length, 4);
});
