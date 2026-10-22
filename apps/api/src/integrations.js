export class IntegrationUnavailable extends Error {}

export function integrationConfig(env = process.env) {
  return {
    tenant: env.ENTRA_TENANT_ID,
    client: env.GRAPH_CLIENT_ID,
    secret: env.GRAPH_CLIENT_SECRET,
    mailbox: env.GRAPH_MAILBOX,
    teams: env.TEAMS_WEBHOOK_URL,
    discord: env.DISCORD_WEBHOOK_URL,
  };
}

function secureWebhook(value, discord = false) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      (discord && !["discord.com", "discordapp.com"].includes(url.hostname))) {
    throw new Error("Webhook must be an HTTPS provider URL");
  }
  return url;
}

export function createIntegrations(config, fetcher = fetch) {
  let cachedToken;
  let expiresAt = 0;

  async function request(url, options) {
    const response = await fetcher(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // Provider error bodies and webhook URLs can contain credentials or member data.
      throw new Error(`Integration request failed (HTTP ${response.status})`);
    }
    return response;
  }

  async function graph(path, method, body) {
    if (!config.tenant || !config.client || !config.secret || !config.mailbox) {
      throw new IntegrationUnavailable("Microsoft Graph is not configured");
    }
    if (Date.now() >= expiresAt) {
      const response = await request(
        `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`,
        {
          method: "POST",
          body: new URLSearchParams({
            client_id: config.client,
            client_secret: config.secret,
            grant_type: "client_credentials",
            scope: "https://graph.microsoft.com/.default",
          }),
        },
      );
      const token = await response.json();
      if (!token.access_token || !Number.isFinite(token.expires_in)) {
        throw new Error("Invalid Microsoft Graph token response");
      }
      cachedToken = token.access_token;
      expiresAt = Date.now() + Math.max(0, token.expires_in - 60) * 1000;
    }
    return request(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.mailbox)}${path}`,
      {
        method,
        headers: { Authorization: "Bearer " + cachedToken, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
  }

  return {
    channels: ["teams", "discord"].filter((channel) => config[channel]),
    async email({ to, subject, body }) {
      if (!to) return;
      await graph("/sendMail", "POST", {
        message: {
          subject,
          body: { contentType: "Text", content: body },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      });
    },
    async announce(channel, event) {
      if (!config[channel]) throw new IntegrationUnavailable(`${channel} is not configured`);
      const text = `${event.title}\n${event.description || ""}\n${event.starts_at}\n${event.location}`;
      const payload = channel === "discord"
        ? { content: text.slice(0, 2000), allowed_mentions: { parse: [] } }
        : {
            type: "message",
            attachments: [{
              contentType: "application/vnd.microsoft.card.adaptive",
              content: {
                type: "AdaptiveCard",
                version: "1.2",
                body: [{ type: "TextBlock", text, wrap: true }],
              },
            }],
          };
      await request(secureWebhook(config[channel], channel === "discord"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async calendar(event) {
      const path = "/calendar/events";
      if (event.cancelled_at) {
        if (event.outlook_event_id) {
          await graph(`${path}/${encodeURIComponent(event.outlook_event_id)}/cancel`, "POST", {
            comment: "This AI Club event has been cancelled.",
          });
        }
        return null;
      }
      const body = {
        subject: event.title,
        body: { contentType: "Text", content: event.description },
        start: { dateTime: new Date(event.starts_at).toISOString(), timeZone: "UTC" },
        end: { dateTime: new Date(event.ends_at).toISOString(), timeZone: "UTC" },
        location: { displayName: event.location },
        ...(event.outlook_event_id ? {} : { transactionId: event.id }),
      };
      const response = await graph(
        event.outlook_event_id ? `${path}/${encodeURIComponent(event.outlook_event_id)}` : path,
        event.outlook_event_id ? "PATCH" : "POST",
        body,
      );
      return (await response.json()).id;
    },
  };
}
