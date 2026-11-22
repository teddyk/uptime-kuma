import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSnapshot, statusName, summarizeMonitor } from "../src/snapshot.js";

const NOW = Date.parse("2026-01-02T12:00:00.000Z");

/**
 * Kuma time string for a moment some minutes before NOW.
 * @param {number} minutesAgo Minutes before NOW
 * @returns {string} UTC string without a zone marker
 */
function ago(minutesAgo) {
    return new Date(NOW - minutesAgo * 60000).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Build a normalized beat.
 * @param {number} status Status number
 * @param {number} minutesAgo Minutes before NOW
 * @param {object} extra Fields to override
 * @returns {object} Normalized beat
 */
function beat(status, minutesAgo, extra = {}) {
    return {
        monitorId: 1,
        status,
        time: ago(minutesAgo),
        msg: `msg ${status}`,
        ping: 5,
        important: false,
        duration: 0,
        retries: 0,
        hasDetail: false,
        ...extra,
    };
}

const site = { id: 1, name: "Site", type: "http", url: "https://example.com", active: true, tags: [{ name: "edge" }] };

describe("statusName", () => {
    it("maps beat status numbers and the special cases", () => {
        assert.equal(statusName(site, beat(1, 1)), "up");
        assert.equal(statusName(site, beat(0, 1)), "down");
        assert.equal(statusName(site, beat(2, 1)), "pending");
        assert.equal(statusName(site, beat(3, 1)), "maintenance");
        assert.equal(statusName(site, null), "unknown");
        assert.equal(statusName({ ...site, active: false }, beat(1, 1)), "paused");
        assert.equal(statusName({ ...site, active: undefined }, null), "paused");
    });
});

describe("summarizeMonitor", () => {
    it("masks secrets in the target url", () => {
        const row = summarizeMonitor({ ...site, url: "https://example.com/?token=abc" }, null, {});
        assert.equal(row.target, "https://example.com/?token=***");
    });

    it("builds the flat row", () => {
        const row = summarizeMonitor({ ...site, parent: 9, pathName: "Group / Site" }, beat(1, 2, { ping: 42 }), {
            24: 0.97,
            720: 0.9,
        });
        assert.deepEqual(row, {
            id: 1,
            name: "Site",
            type: "http",
            target: "https://example.com",
            parent: 9,
            pathName: "Group / Site",
            status: "up",
            lastBeatTime: ago(2),
            msg: "msg 1",
            ping: 42,
            uptime24h: 0.97,
            tags: ["edge"],
        });
    });

    it("picks the target: url, then host with port, then host, then grpcUrl, else null", () => {
        const target = (m) => summarizeMonitor({ id: 1, active: true, ...m }, null, {}).target;
        assert.equal(target({ url: "https://example.com/x" }), "https://example.com/x");
        assert.equal(target({ url: "https://", hostname: "192.0.2.1", port: 443 }), "192.0.2.1:443");
        assert.equal(target({ hostname: "example.com", port: null }), "example.com");
        assert.equal(target({ url: "https://", grpcUrl: "example.com:50051" }), "example.com:50051");
        assert.equal(target({ url: "https://" }), null);
        assert.equal(target({}), null);
    });

    it("has null and empty values when there is no beat, uptime or tags", () => {
        const row = summarizeMonitor({ id: 3, name: "n", type: "group", active: true }, null, {});
        assert.equal(row.status, "unknown");
        assert.equal(row.lastBeatTime, null);
        assert.equal(row.msg, null);
        assert.equal(row.ping, null);
        assert.equal(row.uptime24h, null);
        assert.equal(row.parent, null);
        assert.equal(row.pathName, null);
        assert.deepEqual(row.tags, []);
    });
});

describe("buildSnapshot", () => {
    const monitors = [
        { id: 1, name: "Up", type: "http", url: "https://example.com", active: true },
        { id: 2, name: "Down", type: "port", hostname: "192.0.2.2", port: 22, active: true },
        { id: 3, name: "Pending", type: "http", url: "https://example.net", active: true },
        { id: 4, name: "Maint", type: "http", url: "https://example.org", active: true },
        { id: 5, name: "Paused", type: "http", url: "https://example.edu", active: false },
        { id: 6, name: "Fresh", type: "http", url: "https://example.io", active: true },
    ];

    it("counts totals by status", () => {
        const snap = buildSnapshot({
            monitors,
            beatsByMonitor: {
                1: [beat(1, 30)],
                2: [beat(0, 30)],
                3: [beat(2, 30)],
                4: [beat(3, 30)],
                5: [beat(1, 30)],
            },
            now: NOW,
        });
        assert.deepEqual(snap.totals, { total: 6, up: 1, down: 1, pending: 1, maintenance: 1, paused: 1, unknown: 1 });
        assert.equal(snap.generatedAt, "2026-01-02T12:00:00.000Z");
        assert.equal(snap.windowMinutes, 10);
    });

    it("lists down and pending monitors with the start of their current run", () => {
        const snap = buildSnapshot({
            monitors,
            beatsByMonitor: {
                1: [beat(1, 50), beat(1, 40)],
                2: [beat(1, 50), beat(0, 40, { msg: "first fail" }), beat(0, 30), beat(0, 20, { hasDetail: true })],
                3: [beat(0, 50), beat(2, 40), beat(2, 30)],
                5: [beat(0, 20)],
            },
            uptimeByMonitor: { 2: { 24: 0.5 } },
            now: NOW,
        });
        assert.deepEqual(
            snap.notUp.map((r) => [r.id, r.status, r.since, r.hasDetail]),
            [
                [2, "down", ago(40), true],
                [3, "pending", ago(40), false],
            ]
        );
        assert.equal(snap.notUp[0].uptime24h, 0.5);
        assert.equal(snap.notUp[0].target, "192.0.2.2:22");
        assert.equal(snap.notUp[0].lastBeatTime, ago(20));
        assert.equal(snap.quiet, false);
    });

    it("uses the oldest cached beat as since when the run reaches the start of the cache", () => {
        const snap = buildSnapshot({
            monitors: [monitors[1]],
            beatsByMonitor: { 2: [beat(0, 90), beat(0, 80)] },
            now: NOW,
        });
        assert.equal(snap.notUp[0].since, ago(90));
    });

    it("reports transitions inside the window only, oldest first, with status names", () => {
        const snap = buildSnapshot({
            monitors: monitors.slice(0, 2),
            beatsByMonitor: {
                1: [beat(1, 30), beat(0, 8, { msg: "went down", hasDetail: true }), beat(1, 2, { msg: "back" })],
                2: [beat(1, 30), beat(1, 20), beat(2, 5, { msg: "retrying" })],
            },
            windowMinutes: 10,
            now: NOW,
        });
        assert.deepEqual(snap.changes, [
            { monitorId: 1, name: "Up", from: "up", to: "down", time: ago(8), msg: "went down", hasDetail: true },
            { monitorId: 2, name: "Down", from: "up", to: "pending", time: ago(5), msg: "retrying", hasDetail: false },
            { monitorId: 1, name: "Up", from: "down", to: "up", time: ago(2), msg: "back", hasDetail: false },
        ]);

        const narrow = buildSnapshot({
            monitors: monitors.slice(0, 2),
            beatsByMonitor: { 1: [beat(1, 30), beat(0, 8), beat(1, 2)] },
            windowMinutes: 3,
            now: NOW,
        });
        assert.deepEqual(
            narrow.changes.map((c) => c.to),
            ["up"]
        );
        assert.equal(narrow.windowMinutes, 3);
    });

    it("parses beat times as UTC, whatever the local zone", () => {
        const snap = buildSnapshot({
            monitors: [monitors[0]],
            beatsByMonitor: { 1: [beat(1, 30), { ...beat(0, 0), time: "2026-01-02 11:58:00.000" }] },
            now: NOW,
        });
        assert.equal(snap.changes.length, 1);
        assert.equal(snap.changes[0].time, "2026-01-02 11:58:00.000");
    });

    it("flags a monitor with 3 or more transitions in the last 60 minutes, whatever the window", () => {
        const flappy = [beat(1, 55), beat(0, 40), beat(1, 30), beat(0, 20)];
        const calm = [beat(1, 55), beat(0, 40), beat(1, 30)];
        const old = [beat(1, 120), beat(0, 110), beat(1, 100), beat(0, 90), beat(1, 80)];
        const snap = buildSnapshot({
            monitors: monitors.slice(0, 3),
            beatsByMonitor: { 1: flappy, 2: calm, 3: old },
            windowMinutes: 5,
            now: NOW,
        });
        assert.deepEqual(snap.flapping, [{ monitorId: 1, name: "Up", transitions: 3 }]);
        assert.equal(snap.changes.length, 0);
        assert.equal(snap.quiet, false);
    });

    it("is quiet when everything is up and nothing changed", () => {
        const snap = buildSnapshot({
            monitors: monitors.slice(0, 1),
            beatsByMonitor: { 1: [beat(1, 90), beat(0, 80), beat(1, 70), beat(1, 5)] },
            now: NOW,
        });
        assert.equal(snap.quiet, true);
        assert.deepEqual(snap.notUp, []);
        assert.deepEqual(snap.changes, []);
        assert.deepEqual(snap.flapping, []);
    });

    it("copes with no monitors and with monitors that have no cached beats", () => {
        const empty = buildSnapshot({ monitors: [], beatsByMonitor: {}, now: NOW });
        assert.equal(empty.totals.total, 0);
        assert.equal(empty.quiet, true);
        const none = buildSnapshot({ monitors: [monitors[0]], beatsByMonitor: {}, now: NOW });
        assert.equal(none.totals.unknown, 1);
        assert.equal(none.quiet, true);
    });

    it("defaults now to the current time", () => {
        const before = Date.now();
        const snap = buildSnapshot({ monitors: [], beatsByMonitor: {} });
        assert.ok(Date.parse(snap.generatedAt) >= before);
    });
});
