# Archive, web interface and Teams notifications

These features are optional and only active when the corresponding sections exist in `config.yml`
(see `config.example.yml`). Requires Node.js 24 (bundled in the binaries).

| Section   | What it does |
|-----------|--------------|
| `archive` | Stores every received mail (EML) plus metadata (SMTP session, envelope, headers, Graph status, history) in `mailroot/archive` and `mailroot/smtp2graph.db` (SQLite). Mails and metadata older than `retentionDays` (default 30) are deleted hourly. |
| `web`     | Web interface: search, mail details (metadata, history, headers, text, attachments), EML download, resend of failed mails, statistics, Teams test notification. Requires `archive`. |
| `notify`  | Teams activity feed notification to the configured users when a mail fails permanently (moved to `mailroot/failed`). Failures within `throttleMinutes` are bundled. |

> **Data protection:** the archive contains complete mails including personal data.
> Agree on the retention period, `storeContent` and who may access the web interface with your data protection officer.

## Mail status

| Status     | Meaning |
|------------|---------|
| `queued`   | Received, waiting in the queue |
| `retrying` | Sending failed, will be retried (`send.retryLimit`, `send.retryInterval`) |
| `sent`     | **Accepted by the Graph API** (`sendMail` returned 202). Delivery to the recipient is not tracked, use the Exchange Online message trace for that. |
| `failed`   | Failed permanently, the EML is in `mailroot/failed` and can be resent from the web interface |

Unrecoverable errors (e.g. access denied to the mailbox) and mails that hit the retry limit are moved to `mailroot/failed`.
With `retryLimit: 0` failed mails go to `mailroot/failed` immediately.

## Web interface login (Entra ID)

The login uses the existing app registration (`send.appReg`) with the authorization code flow (PKCE).

1. **App registration → Authentication → Add a platform → Web**
   Redirect URI: `<web.publicUrl>/auth/callback` (e.g. `https://smtp2graph.contoso.com:8080/auth/callback`).
   Entra ID only allows `http://` for `localhost`, so use HTTPS (`web.tlsKeyPath`/`web.tlsCertPath` or a reverse proxy).
2. **Token configuration → Add groups claim → Security groups** (ID token, *Group ID*).
3. Put the object IDs of the allowed groups in `web.auth.allowedGroups`.
4. Users that are member of more than 200 groups don't get a `groups` claim (group overage). SMTP2Graph then checks the
   membership with the Graph API, which requires the application permission **`GroupMember.Read.All`** (admin consent).

Sessions are kept in memory: after a restart users have to log in again.

## Teams notifications

Microsoft Graph doesn't allow apps to post chat messages, so SMTP2Graph uses
[activity feed notifications](https://learn.microsoft.com/graph/teams-send-activityfeednotifications)
(the bell in Teams). They require a small Teams app that is linked to the app registration.

1. Add the application permission **`TeamsActivity.Send`** to the app registration and grant admin consent.
2. Generate a GUID once (e.g. `New-Guid` in PowerShell) and set it as `notify.teams.teamsAppId`.
3. Make sure `web.publicUrl` is an `https://` URL (required by Teams for the personal tab).
4. Open the web interface → **Teams-App** to download `smtp2graph-teams-app.zip`.
5. Teams admin center → *Teams apps → Manage apps → Upload new app*, then install it for the recipients with an
   *app setup policy* (Teams apps → Setup policies → Installed apps). The notification fails for users that don't have the app installed.
6. Use **Teams-Benachrichtigung testen** in the web interface to check the setup. The result per recipient is shown.

Clicking a notification opens the SMTP2Graph tab in Teams, which links to the failed mails in the web interface.

## Running `receive` and `send` separately

Both instances must use the same `mailroot` folder (the SQLite database uses WAL mode, so both can write to it).
Run the web interface on one of them. Resending puts the mail back in `mailroot/queue`, where the `send` instance picks it up.

## API

All endpoints require a login (when enabled). `POST` requests need the header `X-SMTP2Graph: 1`.

| Method | Path | |
|--------|------|-|
| GET  | `/api/mails?q=&status=&from=&to=&limit=&offset=` | Search (`from`/`to` in ms since epoch) |
| GET  | `/api/mails/{id}` | Details, history, headers, text preview |
| GET  | `/api/mails/{id}/eml` | Download the EML |
| POST | `/api/mails/{id}/resend` | Put a failed mail back in the queue |
| GET  | `/api/stats?days=30` | Statistics |
| POST | `/api/notify/test` | Send a test notification |
| GET  | `/api/teams-app.zip` | Teams app package |
