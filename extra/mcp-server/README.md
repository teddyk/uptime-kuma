# Uptime Kuma MCP server

An MCP server that lets an agent read monitor state from this Uptime Kuma fork and, when you enable it, add and change monitors.
It talks to Uptime Kuma over its Socket.IO API and speaks MCP over stdio.

## Tools

Read tools, always available:

| Tool                 | Returns                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review_snapshot`    | Fleet totals, monitors that are down or pending, recent status changes, flapping monitors, and `quiet: true` when there is nothing to report. Call this first. |
| `list_monitors`      | One summary row per monitor. Filter by `status` or `search`.                                                                                                   |
| `get_monitor`        | Masked configuration, current status, uptime and the newest heartbeats.                                                                                        |
| `get_beat_detail`    | Stored request and response detail of one heartbeat, bodies capped at 4000 characters.                                                                         |
| `list_notifications` | Notification channels as `id`, `name`, `isDefault`, `active`.                                                                                                  |

Write tools, only listed when writes are enabled:

| Tool             | Does                                                             |
| ---------------- | ---------------------------------------------------------------- |
| `add_monitor`    | Creates a monitor from the web form defaults plus your `fields`. |
| `edit_monitor`   | Changes the fields in `patch` and reports what changed.          |
| `pause_monitor`  | Pauses a monitor.                                                |
| `resume_monitor` | Resumes a monitor.                                               |

## Environment variables

| Variable                         | Meaning                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `KUMA_URL`                       | Required. Base URL of the Uptime Kuma instance, for example `https://kuma.example.com`. |
| `KUMA_USERNAME`, `KUMA_PASSWORD` | Login. Required unless `KUMA_JWT` is set.                                               |
| `KUMA_JWT`                       | Login token. Use it when the account has two-factor authentication.                     |
| `KUMA_MCP_WRITE`                 | `1` or `true` enables the write tools. Anything else leaves them out.                   |

## Read-only by default

Without `KUMA_MCP_WRITE` the four write tools are not registered, so they do not appear in `tools/list`.
Set `KUMA_MCP_WRITE=1` to enable them.

The server logs in as the Uptime Kuma admin account you give it.
It never sends the events for deleting monitors, changing settings or changing notifications.
The Kuma client has a fixed allow-list of events and refuses any other.

## Secrets

Passwords, tokens, private keys, secret headers and request bodies are returned as `***`.
A password or a token inside a monitor URL is masked the same way.
Heartbeat detail is capped at 4000 characters per body.
Notification settings are never returned.
Sending `***` for a field in `edit_monitor` keeps the stored value.
Sending `***` inside a new value, for example in a `headers` string, is rejected.

## Client configuration

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "command": "node",
      "args": ["/path/to/uptime-kuma/extra/mcp-server/index.js"],
      "env": {
        "KUMA_URL": "https://kuma.example.com",
        "KUMA_USERNAME": "admin",
        "KUMA_PASSWORD": "change-me"
      }
    }
  }
}
```

Run `npm install` in this folder first.
Node 20.4 or newer is required.
The client configuration holds the login, so keep that file out of version control.

## Tests

```sh
cd extra/mcp-server
npm install
node --test
```

The tests start a fake Uptime Kuma on `127.0.0.1` and never contact a real instance.

## Reviewing on an alert

Any agent with this server configured can ask for the current state at any time.
To review automatically when something breaks, point an Uptime Kuma webhook notification at whatever starts your agent.
The agent calls `review_snapshot` first.
It then calls `get_monitor` and `get_beat_detail` for the affected monitors.
Run it without `KUMA_MCP_WRITE`, so a review cannot change anything.
