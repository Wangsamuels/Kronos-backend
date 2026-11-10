import { env } from "./env.js";
import { logger } from "./logger.js";

export interface AlertChannels {
  webhookUrl?: string | null;
  telegramChatId?: string | null;
  discordWebhookUrl?: string | null;
}

/** Sends an alert to every configured channel (protocol settings first, then server defaults). Never throws. */
export async function sendAlert(protocolName: string, title: string, detail: Record<string, unknown>, ch: AlertChannels = {}) {
  const text = `🛡 Kronos — ${protocolName}: ${title}`;
  const webhook = ch.webhookUrl ?? env.ALERT_WEBHOOK_URL;
  const discord = ch.discordWebhookUrl ?? env.DISCORD_WEBHOOK_URL;
  const chat = ch.telegramChatId ?? env.TELEGRAM_CHAT_ID;
  const jobs: Promise<unknown>[] = [];
  if (webhook) jobs.push(fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: protocolName, title, ...detail }) }));
  if (discord) jobs.push(fetch(discord, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${text}\n\`\`\`${JSON.stringify(detail, null, 1).slice(0, 1500)}\`\`\`` }) }));
  if (env.TELEGRAM_BOT_TOKEN && chat) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: `${text}\n${JSON.stringify(detail).slice(0, 3000)}` }),
      }),
    );
  }
  const res = await Promise.allSettled(jobs.map((j) => Promise.race([j, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 8000))])));
  for (const r of res) if (r.status === "rejected") logger.warn({ err: String(r.reason) }, "alert delivery failed");
}
