process.env.UPTIME_KUMA_HIDE_LOG = [
    "info_db",
    "info_server",
    "info_monitor",
    "warn_monitor",
    "info_peer",
    "warn_peer",
    "debug",
].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { R } = require("redbean-node");
const Monitor = require("../../server/model/monitor");
const { Notification } = require("../../server/notification");
const { Prometheus } = require("../../server/prometheus");
const { Settings } = require("../../server/settings");
const peerConfirm = require("../../server/peer-confirm");
const { UP, DOWN, PENDING } = require("../../src/util");
const TestDB = require("../mock-testdb");

const testDb = new TestDB("./data/test-peer-confirm");

const TOKEN = "test-peer-token";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until fn() returns a truthy value.
 * @param {Function} fn polled function
 * @param {number} timeout ms before giving up
 * @param {string} label used in the timeout message
 * @returns {Promise<any>} the truthy value
 */
async function waitFor(fn, timeout, label) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await fn();
        if (value) {
            return value;
        }
        await sleep(50);
    }
    throw new Error(`Timed out waiting for: ${label}`);
}

/**
 * Start an http server on an ephemeral port.
 * @param {Function} handler request handler
 * @returns {Promise<http.Server>} listening server
 */
function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

/**
 * Base URL of a listening server.
 * @param {http.Server} server listening server
 * @returns {string} base URL
 */
function urlOf(server) {
    return `http://127.0.0.1:${server.address().port}`;
}

describe("Peer confirmation: pure helpers", () => {
    test("decide: peer says DOWN keeps DOWN and marks it confirmed", () => {
        const result = peerConfirm.decide({ ok: true, status: DOWN }, 2, 3, "boom");
        assert.deepStrictEqual(result, { status: DOWN, msg: "boom (peer confirmed)", held: 0 });
    });

    test("decide: peer says UP turns the beat PENDING and resets the hold counter", () => {
        const result = peerConfirm.decide({ ok: true, status: UP }, 2, 3, "boom");
        assert.deepStrictEqual(result, { status: PENDING, msg: "Local check failed, peer reports UP: boom", held: 0 });
    });

    test("decide: unsupported answer keeps DOWN unchanged", () => {
        const result = peerConfirm.decide({ ok: false, reason: "unsupported" }, 1, 3, "boom");
        assert.deepStrictEqual(result, { status: DOWN, msg: "boom", held: 0 });
    });

    test("decide: unreachable peer holds PENDING until the limit, then DOWN", () => {
        let held = 0;
        const statuses = [];
        const msgs = [];
        for (let i = 0; i < 5; i++) {
            const result = peerConfirm.decide(null, held, 3, "boom");
            statuses.push(result.status);
            msgs.push(result.msg);
            held = result.held;
        }
        assert.deepStrictEqual(statuses, [PENDING, PENDING, PENDING, DOWN, DOWN]);
        assert.strictEqual(msgs[0], "Local check failed, peer unreachable (hold 1/3): boom");
        assert.strictEqual(msgs[2], "Local check failed, peer unreachable (hold 3/3): boom");
        assert.strictEqual(msgs[3], "boom");
        assert.strictEqual(held, 3);
    });

    test("decide: an answer from the peer resets a partly used hold counter", () => {
        const first = peerConfirm.decide(null, 0, 3, "boom");
        const second = peerConfirm.decide(null, first.held, 3, "boom");
        assert.strictEqual(second.held, 2);
        const answered = peerConfirm.decide({ ok: true, status: UP }, second.held, 3, "boom");
        assert.strictEqual(answered.held, 0);
        assert.strictEqual(peerConfirm.decide(null, answered.held, 3, "boom").msg.includes("hold 1/3"), true);
    });

    test("decide: hold 0 goes DOWN at once when the peer is unreachable", () => {
        assert.strictEqual(peerConfirm.decide(null, 0, 0, "boom").status, DOWN);
    });

    test("checkToken", () => {
        assert.strictEqual(peerConfirm.checkToken("Bearer abc", "abc"), true);
        assert.strictEqual(peerConfirm.checkToken("Bearer abd", "abc"), false);
        assert.strictEqual(peerConfirm.checkToken("Bearer abcd", "abc"), false);
        assert.strictEqual(peerConfirm.checkToken("abc", "abc"), false);
        assert.strictEqual(peerConfirm.checkToken(undefined, "abc"), false);
        assert.strictEqual(peerConfirm.checkToken("Bearer ", ""), false);
        assert.strictEqual(peerConfirm.checkToken("Bearer abc", undefined), false);
    });

    test("isSupported", () => {
        assert.strictEqual(peerConfirm.isSupported({ type: "http" }), true);
        assert.strictEqual(peerConfirm.isSupported({ type: "dns", proxy_id: null, docker_host: 0 }), true);
        for (const type of ["push", "group", "manual", "docker", "pm2", "system-service", "globalping"]) {
            assert.strictEqual(peerConfirm.isSupported({ type }), false, type);
        }
        for (const field of ["proxy_id", "docker_host", "remote_browser"]) {
            assert.strictEqual(peerConfirm.isSupported({ type: "http", [field]: 3 }), false, field);
        }
        assert.strictEqual(peerConfirm.isSupported(null), false);
    });

    test("getHold and isEnabled read the environment", () => {
        const saved = { ...process.env };
        try {
            delete process.env.UPTIME_KUMA_PEER_HOLD;
            assert.strictEqual(peerConfirm.getHold(), 3);
            process.env.UPTIME_KUMA_PEER_HOLD = "5";
            assert.strictEqual(peerConfirm.getHold(), 5);
            process.env.UPTIME_KUMA_PEER_HOLD = "x";
            assert.strictEqual(peerConfirm.getHold(), 3);

            delete process.env.UPTIME_KUMA_PEER_URL;
            process.env.UPTIME_KUMA_PEER_TOKEN = "t";
            assert.strictEqual(peerConfirm.isEnabled(), false);
            process.env.UPTIME_KUMA_PEER_URL = "http://peer";
            assert.strictEqual(peerConfirm.isEnabled(), true);
        } finally {
            for (const key of ["UPTIME_KUMA_PEER_HOLD", "UPTIME_KUMA_PEER_URL", "UPTIME_KUMA_PEER_TOKEN"]) {
                if (saved[key] === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = saved[key];
                }
            }
        }
    });
});

describe("Peer confirmation: one-shot check, peer endpoint and main flow", () => {
    let userID;
    let target; // monitored http server, status code is switchable
    let targetStatus = 500;
    let peerApp; // http server hosting the real /api/peer-check router
    let mockPeer; // fake peer for the main-side flow
    let mockPeerAnswer = { ok: true, status: DOWN };
    let mockPeerRequests = [];
    let io;
    let started = [];

    /**
     * Store an http monitor that checks the target server.
     * @param {object} extra column overrides
     * @returns {Promise<object>} raw monitor row
     */
    async function storeMonitor(extra = {}) {
        const bean = R.dispense("monitor");
        bean.name = "peer-test";
        bean.type = "http";
        bean.url = urlOf(target);
        bean.method = "get";
        bean.active = true;
        bean.user_id = userID;
        bean.interval = 60;
        bean.retryInterval = 60;
        bean.maxretries = 0;
        bean.timeout = 5;
        bean.accepted_statuscodes_json = '["200-299"]';
        bean.resendInterval = 0;
        for (const [key, value] of Object.entries(extra)) {
            bean[key] = value;
        }
        await R.store(bean);
        return await R.getRow("SELECT * FROM monitor WHERE id = ?", [bean.id]);
    }

    /**
     * Wait until the monitor stored `count` heartbeats and return them.
     * @param {number} monitorID monitor id
     * @param {number} count number of heartbeats to wait for
     * @returns {Promise<object[]>} heartbeat rows, oldest first
     */
    async function beatsOf(monitorID, count) {
        return await waitFor(
            async () => {
                const rows = await R.getAll("SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY id", [monitorID]);
                return rows.length >= count ? rows : null;
            },
            15000,
            `${count} heartbeats`
        );
    }

    /**
     * Start a monitor from its row and remember it for cleanup.
     * @param {object} row raw monitor row
     * @returns {Promise<Monitor>} started monitor
     */
    async function startMonitor(row) {
        const monitor = await R.findOne("monitor", " id = ? ", [row.id]);
        started.push(monitor);
        await monitor.start(io);
        return monitor;
    }

    before(async () => {
        await testDb.create();
        Notification.init();

        Prometheus.prototype.update = () => {};
        Prometheus.prototype.remove = () => {};
        Monitor.sendNotification = async () => {};

        process.env.UPTIME_KUMA_PEER_TOKEN = TOKEN;

        const user = R.dispense("user");
        user.username = "peer-test";
        user.password = "peer-test";
        user.active = true;
        await R.store(user);
        userID = user.id;

        io = { to: () => ({ emit: () => {} }), sockets: { adapter: { rooms: new Map() } } };

        target = await listen((req, res) => {
            res.statusCode = targetStatus;
            res.end("target");
        });

        // The real router, mounted on a plain express app
        const app = express();
        app.use(express.json());
        // UptimeKumaServer exits without dist/index.html unless NODE_ENV is development
        const nodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "development";
        try {
            app.use(require("../../server/routers/api-router"));
        } finally {
            if (nodeEnv === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = nodeEnv;
            }
        }
        peerApp = await listen(app);

        mockPeer = await listen((req, res) => {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                mockPeerRequests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(mockPeerAnswer));
            });
        });
    });

    after(async () => {
        delete process.env.UPTIME_KUMA_PEER_URL;
        delete process.env.UPTIME_KUMA_PEER_TOKEN;
        delete process.env.UPTIME_KUMA_PEER_HOLD;
        for (const monitor of started) {
            await monitor.stop();
        }
        for (const server of [target, peerApp, mockPeer]) {
            server?.closeAllConnections?.();
            server?.close();
        }
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    /**
     * POST to the peer endpoint.
     * @param {object} options request options
     * @param {object} options.headers extra request headers
     * @param {object} options.body JSON body
     * @returns {Promise<{status: number, body: object|null}>} response
     */
    async function postPeerCheck({ headers = {}, body = {} }) {
        const res = await fetch(urlOf(peerApp) + "/api/peer-check", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    }

    test("one-shot check returns the result and writes nothing", async () => {
        const row = await storeMonitor({ maxretries: 3 });
        const before = await R.getRow(
            "SELECT (SELECT COUNT(*) FROM heartbeat) AS beats, (SELECT COUNT(*) FROM monitor) AS monitors"
        );

        const monitor = R.convertToBean("monitor", { ...row, id: 0, parent: null });
        targetStatus = 500;
        const down = await monitor.start(null, true);
        assert.strictEqual(down.status, DOWN, "failed check is DOWN even with maxretries=3");
        assert.match(down.msg, /500/);

        const monitor2 = R.convertToBean("monitor", { ...row, id: 0, parent: null });
        targetStatus = 200;
        const up = await monitor2.start(null, true);
        assert.strictEqual(up.status, UP);
        assert.strictEqual(typeof up.ping, "number");

        const after = await R.getRow(
            "SELECT (SELECT COUNT(*) FROM heartbeat) AS beats, (SELECT COUNT(*) FROM monitor) AS monitors"
        );
        assert.deepStrictEqual(after, before);
        assert.strictEqual(monitor.prometheus, undefined);
    });

    test("one-shot check gives the same final status in upside-down mode", async () => {
        const row = await storeMonitor({ upside_down: true });
        targetStatus = 500;
        const up = await R.convertToBean("monitor", { ...row, id: 0, parent: null }).start(null, true);
        assert.strictEqual(up.status, UP);
        targetStatus = 200;
        const down = await R.convertToBean("monitor", { ...row, id: 0, parent: null }).start(null, true);
        assert.strictEqual(down.status, DOWN);
    });

    test("peer endpoint: 401 without or with a wrong token", async () => {
        assert.strictEqual((await postPeerCheck({})).status, 401);
        assert.strictEqual((await postPeerCheck({ headers: { Authorization: "Bearer nope" } })).status, 401);
    });

    test("peer endpoint: 404 when no token is configured", async () => {
        delete process.env.UPTIME_KUMA_PEER_TOKEN;
        try {
            assert.strictEqual((await postPeerCheck({ headers: { Authorization: `Bearer ${TOKEN}` } })).status, 404);
        } finally {
            process.env.UPTIME_KUMA_PEER_TOKEN = TOKEN;
        }
    });

    test("peer endpoint: runs the check from a raw row, rejects unsupported and invalid input", async () => {
        const headers = { Authorization: `Bearer ${TOKEN}` };
        const row = await storeMonitor();

        targetStatus = 200;
        const up = await postPeerCheck({ headers, body: { monitor: row } });
        assert.strictEqual(up.status, 200);
        assert.strictEqual(up.body.ok, true);
        assert.strictEqual(up.body.status, UP);

        targetStatus = 500;
        const down = await postPeerCheck({ headers, body: { monitor: row } });
        assert.strictEqual(down.body.status, DOWN);

        const unsupported = await postPeerCheck({ headers, body: { monitor: { ...row, type: "push" } } });
        assert.deepStrictEqual(unsupported.body, { ok: false, reason: "unsupported" });
        const proxied = await postPeerCheck({ headers, body: { monitor: { ...row, proxy_id: 1 } } });
        assert.deepStrictEqual(proxied.body, { ok: false, reason: "unsupported" });

        const invalid = await postPeerCheck({ headers, body: {} });
        assert.strictEqual(invalid.status, 400);
    });

    test("main: peer says UP, the DOWN beat becomes PENDING", async () => {
        process.env.UPTIME_KUMA_PEER_URL = urlOf(mockPeer);
        process.env.UPTIME_KUMA_PEER_HOLD = "3";
        targetStatus = 500;
        mockPeerAnswer = { ok: true, status: UP };
        mockPeerRequests = [];

        const row = await storeMonitor();
        await startMonitor(row);
        const [beat] = await beatsOf(row.id, 1);

        assert.strictEqual(beat.status, PENDING);
        assert.match(beat.msg, /^Local check failed, peer reports UP: .*status code 500$/);
        assert.strictEqual(mockPeerRequests.length, 1);
        assert.strictEqual(mockPeerRequests[0].auth, `Bearer ${TOKEN}`);
        const sent = mockPeerRequests[0].body.monitor;
        assert.strictEqual(sent.type, "http");
        assert.strictEqual(sent.accepted_statuscodes_json, '["200-299"]');
        assert.strictEqual(sent.retry_interval, 60);
    });

    test("main: peer says DOWN, the beat stays DOWN and is marked confirmed", async () => {
        process.env.UPTIME_KUMA_PEER_URL = urlOf(mockPeer);
        targetStatus = 500;
        mockPeerAnswer = { ok: true, status: DOWN };

        const row = await storeMonitor();
        await startMonitor(row);
        const [beat] = await beatsOf(row.id, 1);

        assert.strictEqual(beat.status, DOWN);
        assert.match(beat.msg, /status code 500 \(peer confirmed\)$/);
    });

    test("main: unsupported answer keeps the beat DOWN unchanged", async () => {
        process.env.UPTIME_KUMA_PEER_URL = urlOf(mockPeer);
        targetStatus = 500;
        mockPeerAnswer = { ok: false, reason: "unsupported" };

        const row = await storeMonitor();
        await startMonitor(row);
        const [beat] = await beatsOf(row.id, 1);

        assert.strictEqual(beat.status, DOWN);
        assert.doesNotMatch(beat.msg, /peer/);
    });

    test("main: a monitor type the peer cannot check never calls the peer", async () => {
        process.env.UPTIME_KUMA_PEER_URL = urlOf(mockPeer);
        mockPeerRequests = [];

        // a row with a reference field is not asked
        const row = await storeMonitor();
        await R.exec(
            "INSERT INTO proxy (user_id, protocol, host, port, auth, active) VALUES (?, 'http', '127.0.0.1', 1, 0, 0)",
            [userID]
        );
        const proxyID = await R.getCell("SELECT id FROM proxy ORDER BY id DESC");
        await R.exec("UPDATE monitor SET proxy_id = ? WHERE id = ?", [proxyID, row.id]);

        targetStatus = 500;
        await startMonitor(row);
        const [beat] = await beatsOf(row.id, 1);

        assert.strictEqual(beat.status, DOWN);
        assert.strictEqual(mockPeerRequests.length, 0);
    });

    test("main: unreachable peer holds PENDING for HOLD beats, then DOWN, and stops asking once DOWN", async () => {
        const closed = await listen(() => {});
        const closedURL = urlOf(closed);
        closed.close();
        process.env.UPTIME_KUMA_PEER_URL = closedURL;
        process.env.UPTIME_KUMA_PEER_HOLD = "2";
        targetStatus = 500;

        const row = await storeMonitor({ interval: 1, retryInterval: 1, timeout: 1 });
        await startMonitor(row);
        const beats = await beatsOf(row.id, 4);

        assert.deepStrictEqual(
            beats.slice(0, 4).map((b) => b.status),
            [PENDING, PENDING, DOWN, DOWN]
        );
        assert.match(beats[0].msg, /^Local check failed, peer unreachable \(hold 1\/2\): .*status code 500$/);
        assert.match(beats[1].msg, /\(hold 2\/2\)/);
        assert.doesNotMatch(beats[2].msg, /peer/);
    });

    test("main: with the peer unset the behaviour is unchanged", async () => {
        delete process.env.UPTIME_KUMA_PEER_URL;
        mockPeerRequests = [];
        targetStatus = 500;

        const row = await storeMonitor();
        await startMonitor(row);
        const [beat] = await beatsOf(row.id, 1);

        assert.strictEqual(beat.status, DOWN);
        assert.strictEqual(mockPeerRequests.length, 0);
    });
});
