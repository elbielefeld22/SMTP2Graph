# Archive and web interface

These features are optional and only active when the corresponding sections exist in `config.yml`
(see `config.example.yml`). Requires Node.js 24 (bundled in the binaries).

| Section   | What it does |
|-----------|--------------|
| `archive` | Stores every received mail (EML) plus metadata (SMTP session, envelope, headers, Graph status, history) in `mailroot/archive` and `mailroot/smtp2graph.db` (SQLite). Mails and metadata older than `retentionDays` (default 30) are deleted hourly. |
| `web`     | Web interface: search, mail details (metadata, history, headers, text, attachments), EML download, resend of failed mails, statistics. Requires `archive`. |

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

## Fallback mailbox

With `send.fallbackMailbox` set, a mail whose sending mailbox doesn't exist is sent from the fallback mailbox instead
(immediately, without waiting for a retry). This applies to the Graph errors HTTP 404, `ErrorInvalidUser`,
`MailboxNotEnabledForRESTAPI`, `MailboxNotHostedInExchangeOnline` and `ResourceNotFound`. Other errors (access denied,
message too large, …) don't use the fallback.

- The **From** header is replaced by the fallback address, the display name is kept. A `Sender` header is removed and the
  original From is stored in the header `X-SMTP2Graph-Original-From`. Exchange wouldn't allow sending as a non-existing address.
- The archived EML stays unchanged (original sender). The history shows the fallback, the list marks the mail with **Ersatz**,
  there's a filter "Ersatzpostfach" and a counter in the statistics.
- The app registration needs `Mail.Send` for the fallback mailbox (check an Exchange application access policy, if you use one).
- Without `fallbackMailbox` such mails fail immediately (no retries, it wouldn't help) and can be resent from the web interface.

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
