process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server", "info_monitor", "warn_monitor", "debug"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { R } = require("redbean-node");
const Monitor = require("../../server/model/monitor");
const { Prometheus } = require("../../server/prometheus");
const { Settings } = require("../../server/settings");
const {
    parseForkOptions,
    validateForkOptions,
    checkHeaderConditions,
    pinnedLookup,
} = require("../../server/fork-options");
const {
    buildHttpDetail,
    encodeHttpDetail,
    decodeHttpDetail,
    formatHttpDetailText,
    attachPeerResult,
} = require("../../server/http-detail");
const peerConfirm = require("../../server/peer-confirm");
const { UP, DOWN, PENDING } = require("../../src/util");
const TestDB = require("../mock-testdb");

const testDb = new TestDB("./data/test-fork-options");

describe("Fork options: parsing and validation", () => {
    test("parse gives the empty defaults for missing or broken values", () => {
        const empty = { checkIps: [], checkDns: false, skipPeer: false, headerConditions: [] };
        assert.deepStrictEqual(parseForkOptions(null), empty);
        assert.deepStrictEqual(parseForkOptions("not json"), empty);
        assert.deepStrictEqual(parseForkOptions("[]"), empty);
    });

    test("parse drops invalid IPs and conditions", () => {
        const parsed = parseForkOptions(
            JSON.stringify({
                checkIps: ["203.0.113.10", "nope", "2001:db8::10"],
                headerConditions: [
                    { name: "x-cache", operator: "contains", value: "HIT" },
                    { name: "x", operator: "bogus", value: "" },
                    { name: "", operator: "exists", value: "" },
                ],
            })
        );
        assert.deepStrictEqual(parsed.checkIps, ["203.0.113.10", "2001:db8::10"]);
        assert.strictEqual(parsed.headerConditions.length, 1);
    });

    test("validate trims, lower-cases names, removes duplicates and empty rows", () => {
        const clean = validateForkOptions({
            checkIps: [" 203.0.113.10 ", "", "203.0.113.10"],
            headerConditions: [
                { name: " X-Cache ", operator: "contains", value: "HIT" },
                { name: "", operator: "contains", value: "ignored" },
                { name: "Age", operator: "exists", value: "dropped" },
            ],
        });
        assert.deepStrictEqual(clean, {
            checkIps: ["203.0.113.10"],
            checkDns: false,
            skipPeer: false,
            headerConditions: [
                { name: "x-cache", operator: "contains", value: "HIT" },
                { name: "age", operator: "exists", value: "" },
            ],
        });
    });

    test("validate accepts a missing value and rejects bad input", () => {
        assert.deepStrictEqual(validateForkOptions(undefined), {
            checkIps: [],
            checkDns: false,
            skipPeer: false,
            headerConditions: [],
        });
        assert.throws(() => validateForkOptions({ checkIps: ["example.com"] }), /Not a valid IP address/);
        assert.throws(
            () => validateForkOptions({ headerConditions: [{ name: "a", operator: "nope", value: "" }] }),
            /Unknown header condition operator/
        );
        assert.throws(
            () => validateForkOptions({ headerConditions: [{ name: "a", operator: "regex", value: "(" }] }),
            /Invalid regular expression/
        );
    });
});

describe("Fork options: header conditions", () => {
    const headers = { "x-cache": "HIT from edge", "content-type": "text/html", "set-cookie": ["a=1", "b=2"] };
    const run = (name, operator, value = "") => checkHeaderConditions(headers, [{ name, operator, value }]);

    test("passing conditions", () => {
        run("X-Cache", "exists");
        run("x-missing", "not_exists");
        run("content-type", "equals", "TEXT/HTML");
        run("content-type", "not_equals", "application/json");
        run("x-cache", "contains", "hit");
        run("x-cache", "not_contains", "miss");
        run("x-missing", "not_contains", "miss");
        run("x-cache", "regex", "^hit\\s");
        run("set-cookie", "contains", "b=2");
        checkHeaderConditions(headers, []);
    });

    test("failing conditions name the header and the value received", () => {
        assert.throws(
            () => run("x-cache", "contains", "MISS"),
            /Header condition failed: x-cache contains "MISS" \(got "HIT from edge"\)/
        );
        assert.throws(() => run("x-missing", "exists"), /x-missing exists \(header is missing\)/);
        assert.throws(() => run("x-missing", "equals", "a"), /header is missing/);
        assert.throws(() => run("x-cache", "not_exists"), /x-cache not_exists/);
        assert.throws(() => run("x-cache", "regex", "^miss"), /x-cache regex/);
    });

    test("all conditions must pass", () => {
        assert.throws(
            () =>
                checkHeaderConditions(headers, [
                    { name: "x-cache", operator: "contains", value: "HIT" },
                    { name: "content-type", operator: "equals", value: "application/json" },
                ]),
            /content-type equals/
        );
    });
});

describe("Fork options: pinned lookup", () => {
    test("the monitor hostname goes to the fixed IP, in both callback forms", () => {
        const lookup = pinnedLookup("pin.test", "203.0.113.10");
        lookup("pin.test", {}, (err, address, family) => {
            assert.strictEqual(err, null);
            assert.strictEqual(address, "203.0.113.10");
            assert.strictEqual(family, 4);
        });
        lookup("pin.test", { all: true }, (err, list) => {
            assert.deepStrictEqual(list, [{ address: "203.0.113.10", family: 4 }]);
        });
        pinnedLookup("pin.test", "2001:db8::10")("pin.test", (err, address, family) => {
            assert.strictEqual(family, 6);
        });
    });

    test("other hostnames resolve normally", async () => {
        const lookup = pinnedLookup("pin.test", "203.0.113.10");
        const address = await new Promise((resolve, reject) =>
            lookup("localhost", { family: 4 }, (err, addr) => (err ? reject(err) : resolve(addr)))
        );
        assert.strictEqual(address, "127.0.0.1");
    });
});

describe("Peer result kept next to the local detail", () => {
    const detailOf = (status, ip) =>
        buildHttpDetail({
            response: {
                status,
                statusText: status === 200 ? "OK" : "Service Unavailable",
                headers: { "x-node": ip },
                data: "body from " + ip,
                config: { method: "get", url: "http://example.com/", headers: {} },
                request: { socket: { remoteAddress: ip, remotePort: 80 } },
            },
        });

    test("both responses end up in one stored value and in the alert text", async () => {
        const local = await encodeHttpDetail(detailOf(503, "203.0.113.10"));
        const peer = await encodeHttpDetail(detailOf(200, "203.0.113.20"));
        const merged = await decodeHttpDetail(
            await attachPeerResult(local, { ok: true, status: UP, msg: "200 - OK", ping: 12, response: peer })
        );
        assert.strictEqual(merged.response.status, 503);
        assert.strictEqual(merged.peer.status, UP);
        assert.strictEqual(merged.peer.detail.response.status, 200);
        assert.strictEqual(merged.peer.detail.ip, "203.0.113.20");

        const text = formatHttpDetailText(merged);
        assert.match(text, /Response: 503/);
        assert.match(text, /Peer check: UP - 200 - OK \(12 ms\)/);
        assert.match(text, /Sent to: 203\.0\.113\.20:80/);
        assert.match(text, /body from 203\.0\.113\.20/);
    });

    test("a peer answer without a detail still records status and message", async () => {
        const local = await encodeHttpDetail(detailOf(503, "203.0.113.10"));
        const merged = await decodeHttpDetail(
            await attachPeerResult(local, { ok: true, status: DOWN, msg: "timeout" })
        );
        assert.deepStrictEqual(merged.peer, { status: DOWN, msg: "timeout", ping: null, detail: null });
        assert.match(formatHttpDetailText(merged), /Peer check: DOWN - timeout/);
    });

    test("a beat without a local detail is left unchanged", async () => {
        assert.strictEqual(await attachPeerResult(null, { ok: true, status: UP, msg: "ok" }), null);
        assert.strictEqual(await attachPeerResult("legacy", { ok: true, status: UP, msg: "ok" }), "legacy");
    });
});

describe("Fork options: HTTP checks", () => {
    let serverA;
    let serverB;
    let port;
    let userID;
    const hosts = [];

    /**
     * Listen on one loopback address.
     * @param {string} address address to bind
     * @param {number} listenPort port, 0 for any free port
     * @param {string} cache value of the x-cache response header
     * @returns {Promise<http.Server>} listening server
     */
    function listen(address, listenPort, cache) {
        return new Promise((resolve) => {
            const server = http.createServer((req, res) => {
                hosts.push(`${address} ${req.headers.host}`);
                res.writeHead(200, { "X-Cache": cache, "X-Node": address });
                res.end("hello from " + address);
            });
            server.listen(listenPort, address, () => resolve(server));
        });
    }

    /**
     * Store an http monitor for http://pin.test:<port>/ and run it once.
     * @param {object} forkOptions fork options of the monitor
     * @param {object} extra column overrides
     * @returns {Promise<object>} one-shot result
     */
    async function check(forkOptions, extra = {}) {
        const bean = R.dispense("monitor");
        bean.name = "fork-options-test";
        bean.type = "http";
        bean.url = `http://pin.test:${port}/`;
        bean.method = "get";
        bean.active = true;
        bean.user_id = userID;
        bean.interval = 60;
        bean.retryInterval = 60;
        bean.maxretries = 0;
        bean.timeout = 5;
        bean.accepted_statuscodes_json = '["200-299"]';
        bean.resendInterval = 0;
        bean.fork_options = JSON.stringify(validateForkOptions(forkOptions));
        for (const [key, value] of Object.entries(extra)) {
            bean[key] = value;
        }
        await R.store(bean);
        const monitor = await R.findOne("monitor", " id = ? ", [bean.id]);
        return await monitor.start(null, true);
    }

    before(async () => {
        await testDb.create();
        Prometheus.prototype.update = () => {};
        Prometheus.prototype.remove = () => {};
        Monitor.sendNotification = async () => {};

        const user = R.dispense("user");
        user.username = "fork-options-test";
        user.password = "fork-options-test";
        user.active = true;
        await R.store(user);
        userID = user.id;

        serverA = await listen("127.0.0.1", 0, "HIT");
        port = serverA.address().port;
        serverB = await listen("127.0.0.2", port, "MISS");
    });

    after(async () => {
        for (const server of [serverA, serverB]) {
            server?.closeAllConnections?.();
            server?.close();
        }
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("one IP: the request goes there and keeps the hostname as Host", async () => {
        hosts.length = 0;
        const result = await check({ checkIps: ["127.0.0.2"] });
        assert.strictEqual(result.status, UP, result.msg);
        assert.deepStrictEqual(hosts, [`127.0.0.2 pin.test:${port}`]);
    });

    test("two IPs, both pass: one request per IP and a combined message", async () => {
        hosts.length = 0;
        const result = await check({ checkIps: ["127.0.0.1", "127.0.0.2"] });
        assert.strictEqual(result.status, UP, result.msg);
        assert.match(result.msg, /^2\/2 IPs OK\. 200 - OK/);
        assert.deepStrictEqual(hosts.sort(), [`127.0.0.1 pin.test:${port}`, `127.0.0.2 pin.test:${port}`]);
    });

    test("one of three IPs fails: down, the message names it, details come from it", async () => {
        const result = await check({ checkIps: ["127.0.0.1", "127.0.0.3", "127.0.0.2"] });
        assert.strictEqual(result.status, DOWN);
        assert.match(result.msg, /^1\/3 IPs failed\. 127\.0\.0\.3: /);
        const detail = await decodeHttpDetail(result.response);
        assert.strictEqual(detail.response, null);
        assert.strictEqual(detail.ip, "127.0.0.3");
    });

    test("header condition per IP: the IP whose header differs fails", async () => {
        const result = await check({
            checkIps: ["127.0.0.1", "127.0.0.2"],
            headerConditions: [{ name: "X-Cache", operator: "equals", value: "HIT" }],
        });
        assert.strictEqual(result.status, DOWN);
        assert.match(
            result.msg,
            /^1\/2 IPs failed\. 127\.0\.0\.2: Header condition failed: x-cache equals "HIT" \(got "MISS"\)/
        );
        const detail = await decodeHttpDetail(result.response);
        assert.strictEqual(detail.response.status, 200);
        assert.strictEqual(detail.response.headers["x-cache"], "MISS");
    });

    test("header conditions work with the keyword type", async () => {
        const pass = await check(
            { checkIps: ["127.0.0.1"], headerConditions: [{ name: "x-node", operator: "exists", value: "" }] },
            { type: "keyword", keyword: "hello" }
        );
        assert.strictEqual(pass.status, UP, pass.msg);
        assert.match(pass.msg, /keyword is found/);

        const fail = await check(
            { checkIps: ["127.0.0.1"], headerConditions: [{ name: "x-gone", operator: "exists", value: "" }] },
            { type: "keyword", keyword: "hello" }
        );
        assert.strictEqual(fail.status, DOWN);
        assert.match(fail.msg, /x-gone exists \(header is missing\)/);
    });

    test("with the DNS option the resolved address is checked next to the listed IPs", async () => {
        hosts.length = 0;
        const result = await check(
            { checkDns: true, checkIps: ["127.0.0.2"] },
            { url: `http://localhost:${port}/`, ip_family: "ipv4" }
        );
        assert.strictEqual(result.status, UP, result.msg);
        assert.match(result.msg, /^2\/2 IPs OK\./);
        assert.deepStrictEqual(hosts.sort(), [`127.0.0.1 localhost:${port}`, `127.0.0.2 localhost:${port}`]);
    });

    test("a hostname that does not resolve fails as DNS while the listed IP passes", async () => {
        const result = await check({ checkDns: true, checkIps: ["127.0.0.1"] });
        assert.strictEqual(result.status, DOWN);
        assert.match(result.msg, /^1\/2 IPs failed\. DNS: /);
    });

    test("the DNS option alone, without IPs, is a normal single check", async () => {
        hosts.length = 0;
        const result = await check({ checkDns: true }, { url: `http://localhost:${port}/`, ip_family: "ipv4" });
        assert.strictEqual(result.status, UP, result.msg);
        assert.strictEqual(result.msg, "200 - OK");
        assert.strictEqual(hosts.length, 1);
    });

    test("skipPeer: the peer is not asked and the failure stays DOWN", async () => {
        // Nothing listens on port 1: an asked peer would be unreachable and hold the beat as PENDING
        process.env.UPTIME_KUMA_PEER_URL = "http://127.0.0.1:1";
        process.env.UPTIME_KUMA_PEER_TOKEN = "test-token";
        try {
            const store = async (forkOptions) => {
                const bean = R.dispense("monitor");
                bean.name = "skip-peer-test";
                bean.type = "http";
                bean.url = `http://127.0.0.1:${port}/`;
                bean.user_id = userID;
                bean.timeout = 1;
                bean.accepted_statuscodes_json = '["200-299"]';
                bean.fork_options = JSON.stringify(validateForkOptions(forkOptions));
                await R.store(bean);
                return { id: bean.id, name: bean.name, timeout: 1 };
            };

            const skipped = { status: DOWN, msg: "local failure", response: null };
            const held = await peerConfirm.confirmDown(await store({ skipPeer: true }), skipped, 0);
            assert.strictEqual(held, 0);
            assert.deepStrictEqual(skipped, { status: DOWN, msg: "local failure", response: null });

            const asked = { status: DOWN, msg: "local failure", response: null };
            const heldAsked = await peerConfirm.confirmDown(await store({}), asked, 0);
            assert.strictEqual(heldAsked, 1);
            assert.strictEqual(asked.status, PENDING);
            assert.match(asked.msg, /peer unreachable/);
        } finally {
            delete process.env.UPTIME_KUMA_PEER_URL;
            delete process.env.UPTIME_KUMA_PEER_TOKEN;
        }
    });

    test("upside down mode is applied once, on the combined result", async () => {
        const result = await check({ checkIps: ["127.0.0.1", "127.0.0.3"] }, { upside_down: 1 });
        assert.strictEqual(result.status, UP, result.msg);
    });
});
