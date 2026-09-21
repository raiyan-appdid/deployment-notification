# Dokploy → Bitrix24 notifications

Dokploy has no built-in Bitrix24 provider, but it does have a **Custom** notification provider that POSTs a fixed JSON payload (plus any headers you add) to any URL. Bitrix24 can receive messages through an **inbound webhook** calling `im.message.add`, but it expects its own format (`DIALOG_ID`, `MESSAGE`, `ATTACH`). This tiny relay translates between the two.

```
Dokploy (Custom provider) ──POST JSON──▶ bitrix-relay ──im.message.add──▶ Bitrix24 group chat
```

All the events Dokploy supports come through: build success, build error, database backups, volume backups, Dokploy backups, Docker cleanup, Dokploy restart and server threshold (CPU/memory) alerts.

## 1. Bitrix24: create the chat and the inbound webhook

1. **Create a group chat** (for example "Deployments") and add everyone who should be notified. Open it in the browser: the address bar shows `...im/?IM_DIALOG=chat123`. `chat123` is your **DIALOG_ID**. You can also post to a workgroup's chat (`sg45`) or to one person (their user ID, like `17`).
2. **Pick who the messages come from.** Messages appear as sent by the employee who creates the webhook. For a clean look, create a service user called "Dokploy" (with a rocket avatar), add it to the chat, and create the webhook while logged in as that user.
3. Go to **Applications → Developer resources → Other → Inbound webhook**.
4. Under permissions, tick **Chat and notifications (im)**. Nothing else is needed.
5. Save and copy the URL. It looks like `https://yourcompany.bitrix24.com/rest/25/k8x2abc9.../`. That's your **BITRIX_WEBHOOK_URL**. Keep it secret: anyone who has it can post as that user.

Quick test from any terminal:

```bash
curl -X POST "https://yourcompany.bitrix24.com/rest/25/k8x2abc9.../im.message.add.json" \
  -H "Content-Type: application/json" \
  -d '{"DIALOG_ID":"chat123","MESSAGE":"Hello from Dokploy"}'
```

## 2. Dokploy: deploy the relay

1. Push this folder to a Git repo (or paste the files into Dokploy).
2. In Dokploy, create a new **Application** (build type: Dockerfile) or a **Compose** service from `docker-compose.yml`.
3. Set the environment variables:

| Variable | Example | Notes |
|---|---|---|
| `BITRIX_WEBHOOK_URL` | `https://yourco.bitrix24.com/rest/25/k8x2abc9.../` | from step 1 |
| `BITRIX_DIALOG_ID` | `chat123` | comma-separate to post in several chats: `chat123,chat456` |
| `RELAY_SECRET` | `openssl rand -hex 24` | required in practice; Dokploy sends it as a header |
| `BITRIX_USE_ATTACH` | `true` | `false` = plain text instead of the colored card |
| `IGNORE_TYPES` | `docker-cleanup` | optional, skips noisy events |

4. Add a domain for the app (for example `bitrix-relay.yourdomain.com`, container port **3000**, HTTPS on) and deploy. Opening `https://bitrix-relay.yourdomain.com/health` should show `{"ok":true}`.

## 3. Dokploy: add the notification

1. **Settings → Notifications → Add Notification → Custom**.
2. Endpoint: `https://bitrix-relay.yourdomain.com/dokploy`
3. Headers: add `X-Relay-Secret` = your `RELAY_SECRET`.
4. Tick the events you want (App Deploy, App Build Error, Database Backup, Dokploy Backup, Volume Backup, Docker Cleanup, Dokploy Restart, and Server Threshold if your setup shows it).
5. Click **Test**. A "Test Notification" should appear in the Bitrix24 chat. Then **Create**.

You can keep Discord running alongside while you check that everything arrives, then delete the Discord notification.

## What the messages look like

Each message has a bold title with a status icon (✅ success, ❌ error, ⚠️ server alert, ℹ️ other) and a card with a colored bar (green/red/amber/blue) showing Project, Application, Type, Domains, Time, the error output (trimmed to 1,500 characters) and an "Open in Dokploy" link to the build log.

## Troubleshooting

- **Test gives 401**: the `X-Relay-Secret` header doesn't match `RELAY_SECRET`.
- **Test gives 502**: Bitrix24 rejected the call. Check the relay's logs in Dokploy: `ACCESS_ERROR` means the webhook user isn't a member of the chat, `CHAT_ID` means the DIALOG_ID is wrong, `insufficient_scope` means the webhook is missing the `im` permission.
- **The card looks odd or is missing**: set `BITRIX_USE_ATTACH=false` to get plain formatted text.
- **Nothing arrives, no error**: open the relay's logs in Dokploy. Every forwarded message is logged as `sent "<title>" -> chat123`.