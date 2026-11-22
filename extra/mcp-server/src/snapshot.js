import { maskUrl } from "./redact.js";

const STATUS_NAMES = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };
const FLAPPING_WINDOW_MINUTES = 60;
const FLAPPING_MIN_TRANSITIONS = 3;
const MINUTE_MS = 60000;

/**
 * Parse a beat time. Kuma sends UTC strings such as "2026-01-02 03:04:05.678" without a zone marker.
 * @param {string} time Beat time as the beat carries it
 * @returns {number} Epoch milliseconds
 */
function parseBeatTime(time) {
    return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(time) ? time : time.replace(" ", "T") + "Z");
}

/**
 * Name of a beat status number.
 * @param {number} status 0 down, 1 up, 2 pending, 3 maintenance
 * @returns {string} "down", "up", "pending", "maintenance" or "unknown"
 */
function beatStatusName(status) {
    return STATUS_NAMES[status] ?? "unknown";
}

/**
 * Current status of a monitor as one word.
 * @param {object} monitor Raw monitor object
 * @param {object|null} lastBeat Newest normalized beat, if any
 * @returns {string} "paused", "up", "down", "pending", "maintenance" or "unknown"
 */
export function statusName(monitor, lastBeat) {
    if (!monitor.active) {
        return "paused";
    }
    return lastBeat ? beatStatusName(lastBeat.status) : "unknown";
}

/**
 * Work out what a monitor checks, for display.
 * @param {object} monitor Raw monitor object
 * @returns {string|null} Url with secrets masked (not the bare "https://" default), else host[:port], else the gRPC url, else null
 */
function targetOf(monitor) {
    if (monitor.url && monitor.url !== "https://") {
        return maskUrl(monitor.url);
    }
    if (monitor.hostname) {
        return monitor.port ? `${monitor.hostname}:${monitor.port}` : monitor.hostname;
    }
    return monitor.grpcUrl || null;
}

/**
 * One flat row per monitor.
 * @param {object} monitor Raw monitor object
 * @param {object|null} lastBeat Newest normalized beat, if any
 * @param {object} uptime Uptime values by period, as from KumaClient.getUptime
 * @returns {object} Row with id, name, type, target, parent, pathName, status, lastBeatTime, msg, ping, uptime24h, tags
 */
export function summarizeMonitor(monitor, lastBeat, uptime) {
    return {
        id: monitor.id,
        name: monitor.name,
        type: monitor.type,
        target: targetOf(monitor),
        parent: monitor.parent ?? null,
        pathName: monitor.pathName ?? null,
        status: statusName(monitor, lastBeat),
        lastBeatTime: lastBeat?.time ?? null,
        msg: lastBeat?.msg ?? null,
        ping: lastBeat?.ping ?? null,
        uptime24h: uptime?.["24"] ?? null,
        tags: (monitor.tags ?? []).map((tag) => tag.name),
    };
}

/**
 * Time the current unbroken run of the newest status began, as far as the cache reaches.
 * @param {object[]} beats Normalized beats, oldest first, not empty
 * @returns {string} Time of the oldest beat in the run
 */
function runStart(beats) {
    const status = beats.at(-1).status;
    let start = beats.length - 1;
    while (start > 0 && beats[start - 1].status === status) {
        start--;
    }
    return beats[start].time;
}

/**
 * Status transitions between consecutive beats, each stamped with the time of the later beat.
 * @param {object[]} beats Normalized beats, oldest first
 * @returns {object[]} List of from, to, time, msg and hasDetail
 */
function transitionsOf(beats) {
    const result = [];
    for (let i = 1; i < beats.length; i++) {
        if (beats[i].status !== beats[i - 1].status) {
            result.push({
                from: beatStatusName(beats[i - 1].status),
                to: beatStatusName(beats[i].status),
                time: beats[i].time,
                msg: beats[i].msg,
                hasDetail: beats[i].hasDetail,
            });
        }
    }
    return result;
}

/**
 * Condense the cached state into what a reviewer needs: totals, what is not up, recent changes, flapping.
 * @param {object} input Input
 * @param {object[]} input.monitors Raw monitor objects
 * @param {object} input.beatsByMonitor Monitor id to normalized beats, oldest first
 * @param {object} input.uptimeByMonitor Monitor id to uptime values by period
 * @param {number} input.now Epoch milliseconds to measure windows from
 * @param {number} input.windowMinutes Size of the changes window
 * @returns {object} generatedAt, windowMinutes, totals, notUp, changes, flapping and quiet
 */
export function buildSnapshot({
    monitors,
    beatsByMonitor,
    uptimeByMonitor = {},
    now = Date.now(),
    windowMinutes = 10,
}) {
    const totals = { total: 0, up: 0, down: 0, pending: 0, maintenance: 0, paused: 0, unknown: 0 };
    const notUp = [];
    const changes = [];
    const flapping = [];
    const windowStart = now - windowMinutes * MINUTE_MS;
    const flappingStart = now - FLAPPING_WINDOW_MINUTES * MINUTE_MS;

    for (const monitor of monitors) {
        const beats = beatsByMonitor[monitor.id] ?? [];
        const lastBeat = beats.at(-1) ?? null;
        const status = statusName(monitor, lastBeat);
        totals.total++;
        totals[status]++;

        if (status === "down" || status === "pending") {
            notUp.push({
                ...summarizeMonitor(monitor, lastBeat, uptimeByMonitor[monitor.id]),
                since: runStart(beats),
                hasDetail: lastBeat.hasDetail,
            });
        }

        const transitions = transitionsOf(beats).map((t) => ({ ...t, ms: parseBeatTime(t.time) }));
        for (const t of transitions) {
            if (t.ms >= windowStart) {
                changes.push({ monitorId: monitor.id, name: monitor.name, ...t });
            }
        }
        const recent = transitions.filter((t) => t.ms >= flappingStart).length;
        if (recent >= FLAPPING_MIN_TRANSITIONS) {
            flapping.push({ monitorId: monitor.id, name: monitor.name, transitions: recent });
        }
    }

    changes.sort((a, b) => a.ms - b.ms);
    return {
        generatedAt: new Date(now).toISOString(),
        windowMinutes,
        totals,
        notUp,
        changes: changes.map(({ ms, ...change }) => change),
        flapping,
        quiet: notUp.length === 0 && changes.length === 0 && flapping.length === 0,
    };
}
