import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { maskMonitor, truncateDetail } from "./redact.js";
import { buildAddPayload, buildEditPayload, diffFields } from "./monitor-payload.js";
import { buildSnapshot, statusName, summarizeMonitor } from "./snapshot.js";

const MAX_BODY = 4000;
const SECRETS_NOTE =
    "Secrets (passwords, tokens, secret headers, request bodies) are returned as '***'. " +
    "Sending '***' for a field keeps the stored value; send a real value to change it.";
const FORK_OPTIONS_NOTE =
    "forkOptions is { checkIps: string[] (send the check to each of these IPs, keeping the hostname as Host " +
    "header and TLS name), checkDns: boolean (with checkIps, also check the normally resolved address), " +
    "headerConditions: [{ name, operator, value }] (response headers that must match, HTTP monitors only) } " +
    "where operator is one of 'equals', 'not_equals', " +
    "'contains', 'not_contains', 'regex', 'exists', 'not_exists' (the last two take no value).";
const FIELDS_NOTE =
    "Main fields: url, hostname, port, interval (seconds), maxretries, accepted_statuscodes " +
    "(array of strings such as '200-299'), keyword, forkOptions. " +
    FORK_OPTIONS_NOTE +
    " " +
    SECRETS_NOTE;

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/**
 * Wrap a tool handler so its result becomes MCP text content and a thrown error becomes an error result.
 * @param {Function} handler Async function taking the tool input and returning a JSON-serializable value
 * @returns {Function} MCP tool callback
 */
function toolResult(handler) {
    return async (input) => {
        try {
            const result = await handler(input ?? {});
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
            return { isError: true, content: [{ type: "text", text: error.message }] };
        }
    };
}

/**
 * Cap a response body string.
 * @param {*} body Body as returned by Kuma
 * @returns {*} The body, shortened when it is a string longer than the cap
 */
function truncateBody(body) {
    if (typeof body === "string" && body.length > MAX_BODY) {
        return body.slice(0, MAX_BODY) + "... (truncated)";
    }
    return body;
}

/**
 * Create the MCP server with its tools. Write tools exist only when writeEnabled is true.
 * @param {object} options Options
 * @param {object} options.kuma KumaClient (or a stand-in with the same methods)
 * @param {boolean} options.writeEnabled Register the tools that change monitors
 * @returns {McpServer} Server, not yet connected to a transport
 */
export function createServer({ kuma, writeEnabled }) {
    const server = new McpServer({ name: "uptime-kuma-fork", version });

    server.registerTool(
        "list_monitors",
        {
            description:
                "List monitors with one summary row each: id, name, type, target, parent, pathName, status " +
                "(up, down, pending, maintenance, paused, unknown), lastBeatTime, msg, ping, uptime24h, tags. " +
                "Use it to find a monitor id or to see everything in one state. Optional filters: status, and " +
                "search (case-insensitive substring of name or target).",
            inputSchema: {
                status: z.enum(["up", "down", "pending", "maintenance", "paused", "unknown"]).optional(),
                search: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        toolResult(({ status, search }) => {
            const needle = search ? search.toLowerCase() : null;
            const monitors = kuma
                .getMonitors()
                .map((monitor) => summarizeMonitor(monitor, kuma.getLastBeat(monitor.id), kuma.getUptime(monitor.id)))
                .filter((row) => !status || row.status === status)
                .filter(
                    (row) =>
                        !needle ||
                        String(row.name ?? "")
                            .toLowerCase()
                            .includes(needle) ||
                        String(row.target ?? "")
                            .toLowerCase()
                            .includes(needle)
                );
            return { count: monitors.length, monitors };
        })
    );

    server.registerTool(
        "get_monitor",
        {
            description:
                "Get the full configuration of one monitor plus its current status, uptime (24h, 30d, 1y) and " +
                "its newest heartbeats, oldest first. Use it after list_monitors or review_snapshot to inspect a " +
                "monitor. A beat with hasDetail true has stored request and response data: fetch it with " +
                "get_beat_detail. " +
                SECRETS_NOTE,
            inputSchema: {
                id: z.number().int(),
                beats: z.number().int().min(0).max(100).default(20),
            },
            annotations: { readOnlyHint: true },
        },
        toolResult(async ({ id, beats }) => {
            const monitor = await kuma.getMonitor(id);
            const recent = kuma.getBeats(id);
            return {
                monitor: maskMonitor(monitor),
                status: statusName(monitor, kuma.getLastBeat(id)),
                uptime: kuma.getUptime(id),
                beats: beats > 0 ? recent.slice(-beats) : [],
            };
        })
    );

    server.registerTool(
        "get_beat_detail",
        {
            description:
                "Get the stored HTTP detail of one heartbeat: resolved peer IP and port, request and response " +
                "headers, error, the peer check result and the response body, each body capped at 4000 " +
                "characters. Use it to see why a check failed. Only beats with hasDetail true have one. Pass " +
                "monitorId and the beat's time string exactly as returned by get_monitor or list tools.",
            inputSchema: {
                monitorId: z.number().int(),
                time: z.string(),
            },
            annotations: { readOnlyHint: true },
        },
        toolResult(async ({ monitorId, time }) => {
            const { detail, body } = await kuma.getBeatDetail(monitorId, time);
            return { detail: truncateDetail(detail), body: truncateBody(body) };
        })
    );

    server.registerTool(
        "list_notifications",
        {
            description:
                "List the configured notification channels as { id, name, isDefault, active }. Use it to find ids " +
                "for the notificationIds of add_monitor and edit_monitor. Channel settings are never returned.",
            annotations: { readOnlyHint: true },
        },
        toolResult(() => ({ notifications: kuma.getNotifications() }))
    );

    server.registerTool(
        "review_snapshot",
        {
            description:
                "Summarize the whole fleet: totals per status, monitors that are down or pending with the time " +
                "they went bad, status changes inside the window, and flapping monitors. This is the first call " +
                "for a fleet review. quiet: true means there is nothing to report. Then use get_monitor and " +
                "get_beat_detail on the monitors it names.",
            inputSchema: {
                windowMinutes: z.number().int().min(1).max(1440).default(10),
            },
            annotations: { readOnlyHint: true },
        },
        toolResult(({ windowMinutes }) => {
            const monitors = kuma.getMonitors();
            const beatsByMonitor = {};
            const uptimeByMonitor = {};
            for (const monitor of monitors) {
                beatsByMonitor[monitor.id] = kuma.getBeats(monitor.id);
                uptimeByMonitor[monitor.id] = kuma.getUptime(monitor.id);
            }
            return buildSnapshot({ monitors, beatsByMonitor, uptimeByMonitor, windowMinutes });
        })
    );

    if (!writeEnabled) {
        return server;
    }

    server.registerTool(
        "add_monitor",
        {
            description:
                "Create a monitor and return { monitorId, monitor }. Give type (for example http, port, ping, " +
                "keyword, dns) and name; everything else starts from the web form defaults and is overridden by " +
                "fields. Without notificationIds the notifications marked isDefault are attached. " +
                FIELDS_NOTE,
            inputSchema: {
                type: z.string(),
                name: z.string(),
                fields: z.record(z.string(), z.unknown()).optional(),
                notificationIds: z.array(z.number().int()).optional(),
            },
        },
        toolResult(async ({ type, name, fields, notificationIds }) => {
            const payload = buildAddPayload({ type, name, fields, notificationIds }, kuma.getNotifications());
            const monitorId = await kuma.addMonitor(payload);
            return { monitorId, monitor: maskMonitor(await kuma.getMonitor(monitorId)) };
        })
    );

    server.registerTool(
        "edit_monitor",
        {
            description:
                "Change fields of an existing monitor and return { monitorId, changed } where changed maps each " +
                "modified field to its before and after value. patch holds only the fields to change; the rest " +
                "stays. notificationIds replaces the attached notifications. Give a non-empty patch or " +
                "notificationIds. " +
                FIELDS_NOTE,
            inputSchema: {
                id: z.number().int(),
                patch: z.record(z.string(), z.unknown()).optional(),
                notificationIds: z.array(z.number().int()).optional(),
            },
        },
        toolResult(async ({ id, patch, notificationIds }) => {
            if (Object.keys(patch ?? {}).length === 0 && notificationIds === undefined) {
                throw new Error("Nothing to change: give a non-empty patch or notificationIds");
            }
            const before = await kuma.getMonitor(id);
            await kuma.editMonitor(buildEditPayload(before, patch ?? {}, notificationIds));
            const after = await kuma.getMonitor(id);
            return { monitorId: id, changed: diffFields(before, after) };
        })
    );

    server.registerTool(
        "pause_monitor",
        {
            description: "Pause a monitor so it stops checking. Returns { monitorId, status: 'paused' }.",
            inputSchema: { id: z.number().int() },
        },
        toolResult(async ({ id }) => {
            await kuma.pauseMonitor(id);
            return { monitorId: id, status: "paused" };
        })
    );

    server.registerTool(
        "resume_monitor",
        {
            description: "Resume a paused monitor. Returns { monitorId, status: 'resumed' }.",
            inputSchema: { id: z.number().int() },
        },
        toolResult(async ({ id }) => {
            await kuma.resumeMonitor(id);
            return { monitorId: id, status: "resumed" };
        })
    );

    return server;
}
