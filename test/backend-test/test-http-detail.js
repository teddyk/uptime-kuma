const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const zlib = require("node:zlib");
const axios = require("axios");
const {
    buildHttpDetail,
    encodeHttpDetail,
    decodeHttpDetail,
    isHttpDetailValue,
    formatHttpDetailText,
} = require("../../server/http-detail");
const Heartbeat = require("../../server/model/heartbeat");

const LOOPBACK = ["127.0.0.1", "::1"];

describe("http-detail", () => {
    let server;
    let port;

    before(async () => {
        server = http.createServer((req, res) => {
            if (req.url === "/redirect") {
                res.writeHead(302, { location: "/final" });
                res.end();
            } else if (req.url === "/reset") {
                req.socket.destroy();
            } else if (req.url === "/503") {
                res.writeHead(503, "Service Unavailable", { server: "test-nginx", "set-cookie": "sid=secret" });
                res.end("upstream is down");
            } else if (req.url === "/long") {
                res.writeHead(200);
                res.end("a".repeat(100));
            } else if (req.url === "/json") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } else {
                res.writeHead(200, "OK", { server: "test-nginx" });
                res.end("hello");
            }
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = server.address().port;
    });

    after(() => {
        server.close();
    });

    /**
     * Run an axios request against the test server and return the response or error.
     * @param {string} path URL path
     * @param {object} extra Extra axios options
     * @returns {Promise<{response?: object, error?: object}>} Outcome
     */
    async function request(path, extra = {}) {
        try {
            const response = await axios.request({
                url: `http://localhost:${port}${path}`,
                proxy: false,
                httpAgent: new http.Agent({ autoSelectFamily: true }),
                ...extra,
            });
            return { response };
        } catch (error) {
            return { error };
        }
    }

    test("200 response", async () => {
        const { response } = await request("/ok");
        const detail = buildHttpDetail({ response, maxBodyLength: 1024 });

        assert.strictEqual(detail.v, 1);
        assert.ok(LOOPBACK.includes(detail.ip));
        assert.strictEqual(detail.port, port);
        assert.strictEqual(detail.request.method, "GET");
        assert.strictEqual(detail.request.url, `http://localhost:${port}/ok`);
        assert.strictEqual(detail.request.headers.host, `localhost:${port}`);
        assert.strictEqual(detail.response.status, 200);
        assert.strictEqual(detail.response.statusText, "OK");
        assert.strictEqual(detail.response.headers.server, "test-nginx");
        assert.strictEqual(detail.body, "hello");
        assert.strictEqual(detail.error, null);
    });

    test("object body is JSON stringified", async () => {
        const { response } = await request("/json");
        assert.strictEqual(buildHttpDetail({ response, maxBodyLength: 1024 }).body, '{"ok":true}');
    });

    test("503 response with body and headers", async () => {
        const { error } = await request("/503");
        assert.ok(error.response);

        const detail = buildHttpDetail({ error, maxBodyLength: 1024 });
        assert.ok(LOOPBACK.includes(detail.ip));
        assert.strictEqual(detail.port, port);
        assert.strictEqual(detail.request.url, `http://localhost:${port}/503`);
        assert.strictEqual(detail.response.status, 503);
        assert.strictEqual(detail.response.statusText, "Service Unavailable");
        assert.strictEqual(detail.response.headers.server, "test-nginx");
        assert.strictEqual(detail.body, "upstream is down");
        assert.strictEqual(detail.error.code, error.code);
        assert.strictEqual(detail.error.message, "Request failed with status code 503");
    });

    test("connection refused has no response", async () => {
        // Take a free port and close it again so nothing listens there
        const tmp = http.createServer();
        await new Promise((resolve) => tmp.listen(0, "127.0.0.1", resolve));
        const closedPort = tmp.address().port;
        await new Promise((resolve) => tmp.close(resolve));

        let error;
        try {
            await axios.request({ url: `http://127.0.0.1:${closedPort}/x`, proxy: false });
        } catch (e) {
            error = e;
        }

        const detail = buildHttpDetail({ error, maxBodyLength: 1024 });
        assert.strictEqual(detail.response, null);
        assert.strictEqual(detail.body, null);
        assert.strictEqual(detail.ip, "127.0.0.1");
        assert.strictEqual(detail.port, closedPort);
        assert.strictEqual(detail.request.method, "GET");
        assert.strictEqual(detail.request.url, `http://127.0.0.1:${closedPort}/x`);
        assert.strictEqual(detail.error.code, "ECONNREFUSED");
    });

    test("connection reset after connect has no response", async () => {
        const { error } = await request("/reset");
        const detail = buildHttpDetail({ error, maxBodyLength: 1024 });

        assert.strictEqual(detail.response, null);
        assert.strictEqual(detail.error.code, "ECONNRESET");
        assert.strictEqual(detail.request.method, "GET");
        assert.strictEqual(detail.request.url, `http://localhost:${port}/reset`);
        // The socket is already destroyed, so the IP is only known if Node cached it
        assert.ok(detail.ip === null || LOOPBACK.includes(detail.ip));
    });

    test("redirect reports the final request", async () => {
        const { response } = await request("/redirect");
        const detail = buildHttpDetail({ response, maxBodyLength: 1024 });

        assert.strictEqual(detail.request.url, `http://localhost:${port}/final`);
        assert.strictEqual(detail.response.status, 200);
        assert.ok(LOOPBACK.includes(detail.ip));
        assert.strictEqual(detail.port, port);
    });

    test("sensitive headers are masked in request and response", async () => {
        const { error } = await request("/503", {
            headers: { Authorization: "Bearer topsecret", Cookie: "a=b", "X-Test": "visible" },
        });
        const detail = buildHttpDetail({ error, maxBodyLength: 1024 });

        assert.strictEqual(detail.request.headers.authorization, "***");
        assert.strictEqual(detail.request.headers.cookie, "***");
        assert.strictEqual(detail.request.headers["x-test"], "visible");
        assert.strictEqual(detail.response.headers["set-cookie"], "***");
        assert.ok(!JSON.stringify(detail).includes("topsecret"));
        assert.ok(!JSON.stringify(detail).includes("sid=secret"));
    });

    test("credentials in the URL are not stored", async () => {
        const { response } = await request("/ok", { url: `http://user:pass@localhost:${port}/ok` });
        const detail = buildHttpDetail({ response, maxBodyLength: 1024 });

        assert.ok(!JSON.stringify(detail).includes("pass"));
        assert.strictEqual(detail.request.headers.authorization, "***");
    });

    test("body is truncated like saveResponseData", async () => {
        const { response } = await request("/long");
        const detail = buildHttpDetail({ response, maxBodyLength: 10 });

        assert.strictEqual(detail.body, "a".repeat(10) + "... (truncated)");
    });

    test("response together with a later check error keeps the response", async () => {
        const { response } = await request("/ok");
        const detail = buildHttpDetail({ response, error: new Error("keyword not found"), maxBodyLength: 1024 });

        assert.strictEqual(detail.response.status, 200);
        assert.strictEqual(detail.error.message, "keyword not found");
        assert.strictEqual(detail.error.code, null);
    });

    test("encode and decode round trip", async () => {
        const { error } = await request("/503");
        const detail = buildHttpDetail({ error, maxBodyLength: 1024 });
        const encoded = await encodeHttpDetail(detail);

        assert.strictEqual(typeof encoded, "string");
        assert.ok(isHttpDetailValue(encoded));
        assert.deepStrictEqual(await decodeHttpDetail(encoded), JSON.parse(JSON.stringify(detail)));
    });

    test("legacy plain-body values are not detail objects", async () => {
        const legacy = zlib.brotliCompressSync(Buffer.from("plain body", "utf8")).toString("base64");
        const legacyJson = zlib.brotliCompressSync(Buffer.from('{"status":"ok"}', "utf8")).toString("base64");

        assert.strictEqual(isHttpDetailValue(legacy), false);
        assert.strictEqual(await decodeHttpDetail(legacy), null);
        assert.strictEqual(await decodeHttpDetail(legacyJson), null);
        assert.strictEqual(await decodeHttpDetail("not base64 brotli"), null);
        assert.strictEqual(await decodeHttpDetail(null), null);
        assert.strictEqual(await decodeHttpDetail(""), null);
    });

    test("Heartbeat model keeps response backward compatible", async () => {
        const { error } = await request("/503");
        const encoded = await encodeHttpDetail(buildHttpDetail({ error, maxBodyLength: 1024 }));

        const detailBeat = Object.create(Heartbeat.prototype);
        detailBeat._response = encoded;
        const json = await detailBeat.toJSONAsync({ decodeResponse: true });
        assert.strictEqual(json.response, "upstream is down");
        assert.strictEqual(json.httpDetail.response.status, 503);
        assert.strictEqual(detailBeat.toJSON().hasDetail, true);
        assert.strictEqual(detailBeat.toJSON().response, null);

        const legacy = zlib.brotliCompressSync(Buffer.from("plain body", "utf8")).toString("base64");
        const legacyBeat = Object.create(Heartbeat.prototype);
        legacyBeat._response = legacy;
        const legacyJson = await legacyBeat.toJSONAsync({ decodeResponse: true });
        assert.strictEqual(legacyJson.response, "plain body");
        assert.strictEqual(legacyJson.httpDetail, undefined);
        assert.strictEqual(legacyBeat.toJSON().hasDetail, false);
        assert.strictEqual(legacyBeat.toJSON().response, legacy);
    });

    test("formatHttpDetailText for a response", async () => {
        const text = formatHttpDetailText({
            v: 1,
            ip: "203.0.113.10",
            port: 443,
            request: {
                method: "GET",
                url: "https://example.com/health",
                headers: { "user-agent": "Uptime-Kuma/2.5.12" },
            },
            response: { status: 503, statusText: "Service Unavailable", headers: { server: "nginx" } },
            body: "down for maintenance",
            error: null,
        });

        assert.strictEqual(
            text,
            [
                "Request: GET https://example.com/health",
                "Sent to: 203.0.113.10:443",
                "Request headers:",
                "  user-agent: Uptime-Kuma/2.5.12",
                "Response: 503 Service Unavailable",
                "Response headers:",
                "  server: nginx",
                "Body:",
                "down for maintenance",
            ].join("\n")
        );
    });

    test("formatHttpDetailText without response, IPv6 and long body", () => {
        const noResponse = formatHttpDetailText({
            v: 1,
            ip: "2001:db8::1",
            port: 443,
            request: { method: "GET", url: "https://example.com/", headers: {} },
            response: null,
            body: null,
            error: { code: "ECONNRESET", message: "socket hang up" },
        });
        assert.strictEqual(
            noResponse,
            [
                "Request: GET https://example.com/",
                "Sent to: [2001:db8::1]:443",
                "No response: ECONNRESET socket hang up",
            ].join("\n")
        );

        const long = formatHttpDetailText(
            {
                v: 1,
                ip: null,
                port: null,
                request: { method: "GET", url: "https://example.com/", headers: {} },
                response: { status: 200, statusText: "OK", headers: {} },
                body: "b".repeat(50),
                error: null,
            },
            { maxBody: 5 }
        );
        assert.ok(long.includes("Sent to: unknown"));
        assert.ok(long.endsWith("Body:\nbbbbb... (truncated)"));
    });
});
