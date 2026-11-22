const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { IcecastMonitorType } = require("../../../server/monitor-types/icecast");
const { UP, PENDING } = require("../../../src/util");

describe("Icecast Monitor", () => {
    let server;
    let baseUrl;
    let requests = [];
    let closedConnections = 0;

    before(async () => {
        server = http.createServer((req, res) => {
            requests.push({ url: req.url, headers: req.headers });
            const path = req.url.split("?")[0];

            if (path === "/live") {
                res.writeHead(200, {
                    "Content-Type": "audio/mpeg",
                    "icy-br": "128",
                    "icy-name": "Test FM",
                });
                const timer = setInterval(() => res.write(Buffer.alloc(4096)), 10);
                res.on("close", () => {
                    clearInterval(timer);
                    closedConnections++;
                });
            } else if (path === "/ogg") {
                res.writeHead(200, { "Content-Type": "application/ogg; charset=binary" });
                const timer = setInterval(() => res.write(Buffer.alloc(8192)), 10);
                res.on("close", () => clearInterval(timer));
            } else if (path === "/stalled") {
                res.writeHead(200, { "Content-Type": "audio/mpeg" });
                res.flushHeaders();
            } else if (path === "/trickle") {
                res.writeHead(200, { "Content-Type": "audio/mpeg" });
                res.write(Buffer.alloc(1000));
            } else if (path === "/short") {
                res.writeHead(200, { "Content-Type": "audio/mpeg" });
                res.end(Buffer.alloc(2000));
            } else if (path === "/html") {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end("<html>not a stream</html>");
            } else if (path === "/nocontenttype") {
                res.writeHead(200);
                res.end("x");
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("not found");
            }
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => {
        server.closeAllConnections();
        server.close();
    });

    /**
     * Run a check
     * @param {string} path Path on the fixture server
     * @param {number} timeout Monitor timeout in seconds
     * @returns {Promise<{heartbeat: object, error: (Error|null), elapsed: number}>} Result
     */
    async function run(path, timeout = 2) {
        const monitor = { url: baseUrl + path, timeout };
        const heartbeat = { msg: "", status: PENDING };
        const start = Date.now();
        let error = null;
        try {
            await new IcecastMonitorType().check(monitor, heartbeat, {});
        } catch (e) {
            error = e;
        }
        return { heartbeat, error, elapsed: Date.now() - start };
    }

    test("check() sets UP with stream details for a healthy stream", async () => {
        requests = [];
        const { heartbeat, error } = await run("/live");

        assert.strictEqual(error, null);
        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /^200 - audio\/mpeg, 128 kbps, "Test FM", \d+ KB in \d+\.\ds$/);
        assert.ok(heartbeat.ping >= 0);
        assert.strictEqual(requests[0].headers["icy-metadata"], "1");
    });

    test("check() aborts the connection after enough audio arrived", async () => {
        closedConnections = 0;
        await run("/live");
        // The server notices the closed socket shortly after
        for (let i = 0; i < 50 && closedConnections === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.strictEqual(closedConnections, 1);
    });

    test("check() accepts application/ogg with a charset", async () => {
        const { heartbeat, error } = await run("/ogg");

        assert.strictEqual(error, null);
        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /^200 - application\/ogg, /);
    });

    test("check() fails with a stalled message within the timeout when no body arrives", async () => {
        const { heartbeat, error, elapsed } = await run("/stalled", 1);

        assert.ok(error);
        assert.match(error.message, /^stream stalled: only 0 bytes in 1\.\ds$/);
        assert.notStrictEqual(heartbeat.status, UP);
        assert.ok(elapsed < 2500, `took ${elapsed}ms`);
    });

    test("check() reports the received bytes when the stream stalls after a few bytes", async () => {
        const { error, elapsed } = await run("/trickle", 1);

        assert.ok(error);
        assert.match(error.message, /^stream stalled: only 1000 bytes in 1\.\ds$/);
        assert.ok(elapsed < 2500, `took ${elapsed}ms`);
    });

    test("check() fails when the stream ends before 16 KB", async () => {
        const { error } = await run("/short");

        assert.ok(error);
        assert.match(error.message, /^stream ended: only 2000 bytes in /);
    });

    test("check() fails with the content-type when it is not audio", async () => {
        const { error } = await run("/html");

        assert.ok(error);
        assert.match(error.message, /unexpected content-type "text\/html"/);
    });

    test("check() fails when the content-type is missing", async () => {
        const { error } = await run("/nocontenttype");

        assert.ok(error);
        assert.match(error.message, /unexpected content-type "none"/);
    });

    test("check() fails with the status for a 404", async () => {
        const { error } = await run("/missing");

        assert.ok(error);
        assert.strictEqual(error.message, "unexpected HTTP status 404");
    });

    test("check() fails when the connection is refused", async () => {
        const monitor = { url: "http://127.0.0.1:1/live", timeout: 2 };
        await assert.rejects(new IcecastMonitorType().check(monitor, {}, {}), /ECONNREFUSED/);
    });

    test("check() reports a non-HTTP status line such as ICY 200 OK as an invalid response", async () => {
        const net = require("net");
        const icyServer = net.createServer((socket) => {
            socket.on("error", () => {});
            socket.once("data", () => {
                socket.write("ICY 200 OK\r\nicy-name:Old Shoutcast\r\ncontent-type:audio/mpeg\r\n\r\n");
                socket.write(Buffer.alloc(20000));
            });
        });
        await new Promise((resolve) => icyServer.listen(0, "127.0.0.1", resolve));
        try {
            const monitor = { url: `http://127.0.0.1:${icyServer.address().port}/`, timeout: 2 };
            await assert.rejects(new IcecastMonitorType().check(monitor, {}, {}), /invalid HTTP response/);
        } finally {
            icyServer.close();
        }
    });
});
