const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { HLSMonitorType, parsePlaylist } = require("../../../server/monitor-types/hls");
const { UP, PENDING } = require("../../../src/util");

describe("HLS Monitor", () => {
    let server;
    let baseUrl;
    /** Fixture routes by path: { status, body, headers, hang } */
    let routes = {};
    /** Requests seen by the fixture server */
    let requests = [];

    before(async () => {
        server = http.createServer((req, res) => {
            requests.push({ url: req.url, headers: req.headers });
            const path = req.url.split("?")[0];
            const route = routes[path];
            if (!route) {
                res.writeHead(404);
                res.end("not found");
                return;
            }
            if (route.hang) {
                res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
                res.flushHeaders();
                return;
            }
            const body = typeof route.body === "function" ? route.body() : route.body;
            if (req.headers.range && route.segment) {
                res.writeHead(206, { "Content-Type": "video/mp2t", "Content-Range": "bytes 0-1023/5000" });
                res.end(Buffer.alloc(1024));
                return;
            }
            res.writeHead(route.status || 200, route.headers || {});
            res.end(body);
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => {
        server.closeAllConnections();
        server.close();
    });

    beforeEach(() => {
        routes = {};
        requests = [];
    });

    /**
     * Build a media playlist
     * @param {object} options Options
     * @param {number} options.seq Media sequence
     * @param {boolean} options.endList Add EXT-X-ENDLIST
     * @param {string} options.map URI for EXT-X-MAP
     * @param {string[]} options.segments Segment URIs
     * @param {number} options.target Target duration
     * @returns {string} Playlist text
     */
    function mediaPlaylist({
        seq = 100,
        endList = false,
        map = null,
        segments = ["s100.ts", "s101.ts"],
        target = 6,
    } = {}) {
        let text = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:${seq}\n`;
        if (map) {
            text += `#EXT-X-MAP:URI="${map}"\n`;
        }
        for (const segment of segments) {
            text += `#EXTINF:6.0,\n${segment}\n`;
        }
        if (endList) {
            text += "#EXT-X-ENDLIST\n";
        }
        return text;
    }

    /**
     * Run one check
     * @param {HLSMonitorType} type Monitor type instance
     * @param {string} path Playlist path (with optional query) on the fixture server
     * @param {object} extra Extra monitor fields
     * @returns {Promise<object>} Heartbeat
     */
    async function check(type, path, extra = {}) {
        const heartbeat = { msg: "", status: PENDING };
        await type.check({ url: baseUrl + path, timeout: 3, ...extra }, heartbeat, {});
        return heartbeat;
    }

    test("check() sets UP for a master playlist with relative and absolute variants", async () => {
        routes["/live/master.m3u8"] = {
            body: [
                "#EXTM3U",
                "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
                "v1/index.m3u8",
                "#EXT-X-STREAM-INF:BANDWIDTH=1600000",
                `${baseUrl}/live/v2/index.m3u8?t=2`,
                "",
            ].join("\n"),
        };
        routes["/live/v1/index.m3u8"] = { body: mediaPlaylist({ segments: ["a.ts", "b.ts"] }) };
        routes["/live/v2/index.m3u8"] = { body: mediaPlaylist() };
        routes["/live/v1/b.ts"] = { segment: true };

        const heartbeat = await check(new HLSMonitorType(), "/live/master.m3u8?token=secret");

        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /^live, 2 variants, seq 100, target 6s, newest segment 206 in \d+ms$/);
        assert.ok(heartbeat.ping >= 0);

        const urls = requests.map((r) => r.url);
        // The master's query string is not passed on, the variant's own query is kept as written
        assert.ok(urls.includes("/live/v1/index.m3u8"));
        assert.ok(urls.includes("/live/v2/index.m3u8?t=2"));
        // The newest segment of the first variant is fetched with a range
        const segmentRequest = requests.find((r) => r.url === "/live/v1/b.ts");
        assert.ok(segmentRequest);
        assert.strictEqual(segmentRequest.headers.range, "bytes=0-1023");
        assert.ok(!urls.includes("/live/v1/a.ts"));
    });

    test("check() fails and names the URL without query when a variant answers 404", async () => {
        routes["/master.m3u8"] = {
            body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nmissing.m3u8?token=secret\n",
        };
        routes["/v1.m3u8"] = { body: mediaPlaylist() };

        await assert.rejects(check(new HLSMonitorType(), "/master.m3u8"), (error) => {
            assert.match(
                error.message,
                /^variant playlist http:\/\/127\.0\.0\.1:\d+\/missing\.m3u8 returned HTTP 404$/
            );
            assert.ok(!error.message.includes("secret"));
            return true;
        });
    });

    test("check() fails when a variant playlist has no segments", async () => {
        routes["/master.m3u8"] = { body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1.m3u8\n" };
        routes["/v1.m3u8"] = { body: mediaPlaylist({ segments: [] }) };

        await assert.rejects(check(new HLSMonitorType(), "/master.m3u8"), /v1\.m3u8 contains no segments/);
    });

    test("check() sets UP for a media-only live playlist", async () => {
        routes["/media.m3u8"] = { body: mediaPlaylist({ seq: 42 }) };
        routes["/s101.ts"] = { segment: true };

        const heartbeat = await check(new HLSMonitorType(), "/media.m3u8");

        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /^live, media playlist, seq 42, target 6s, newest segment 206 in \d+ms$/);
        // The newest (last) segment is fetched
        assert.ok(requests.some((r) => r.url === "/s101.ts"));
    });

    test("check() reports vod for a playlist with ENDLIST and clears the stale state", async () => {
        routes["/vod.m3u8"] = { body: mediaPlaylist({ endList: true }) };
        routes["/s101.ts"] = { segment: true };
        const type = new HLSMonitorType();
        type.state.set(7, { mediaSequence: 100, lastSegment: "s101.ts", since: 0 });

        const heartbeat = await check(type, "/vod.m3u8", { id: 7 });

        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /^vod, media playlist, /);
        assert.strictEqual(type.state.size, 0);
    });

    test("check() fetches the init segment of EXT-X-MAP", async () => {
        routes["/media.m3u8"] = { body: mediaPlaylist({ map: "init.mp4", segments: ["s1.m4s"] }) };
        routes["/init.mp4"] = { segment: true };
        routes["/s1.m4s"] = { segment: true };

        const heartbeat = await check(new HLSMonitorType(), "/media.m3u8");

        assert.match(heartbeat.msg, /init 206, newest segment 206/);
        assert.ok(requests.some((r) => r.url === "/init.mp4"));
    });

    test("check() fails when the init segment answers 404", async () => {
        routes["/media.m3u8"] = { body: mediaPlaylist({ map: "init.mp4", segments: ["s1.m4s"] }) };
        routes["/s1.m4s"] = { segment: true };

        await assert.rejects(
            check(new HLSMonitorType(), "/media.m3u8"),
            /init segment .*\/init\.mp4 returned HTTP 404/
        );
    });

    test("check() fails when the newest segment answers 404", async () => {
        routes["/media.m3u8"] = { body: mediaPlaylist({ segments: ["s1.ts"] }) };

        await assert.rejects(check(new HLSMonitorType(), "/media.m3u8"), /newest segment .*\/s1\.ts returned HTTP 404/);
    });

    test("check() accepts encrypted playlists without fetching the key", async () => {
        routes["/media.m3u8"] = {
            body: mediaPlaylist().replace("#EXTINF", '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF'),
        };
        routes["/s101.ts"] = { segment: true };

        const heartbeat = await check(new HLSMonitorType(), "/media.m3u8");

        assert.strictEqual(heartbeat.status, UP);
        assert.ok(!requests.some((r) => r.url === "/key.bin"));
    });

    test("check() fails when the playlist does not start with #EXTM3U", async () => {
        routes["/media.m3u8"] = { body: "<html>hello</html>" };

        await assert.rejects(check(new HLSMonitorType(), "/media.m3u8"), /media\.m3u8 does not start with #EXTM3U/);
    });

    test("check() fails with the status when the playlist answers 404", async () => {
        await assert.rejects(check(new HLSMonitorType(), "/nothing.m3u8?token=secret"), (error) => {
            assert.match(error.message, /^playlist http:\/\/127\.0\.0\.1:\d+\/nothing\.m3u8 returned HTTP 404$/);
            return true;
        });
    });

    test("check() fails within the timeout when the playlist never arrives", async () => {
        routes["/hang.m3u8"] = { hang: true };
        const start = Date.now();

        await assert.rejects(
            check(new HLSMonitorType(), "/hang.m3u8", { timeout: 1 }),
            /hang\.m3u8: timed out after 1s/
        );
        assert.ok(Date.now() - start < 2500);
    });

    describe("staleness", () => {
        /**
         * Create a type instance with a controllable clock
         * @returns {{type: HLSMonitorType, clock: {now: number}}} Type and clock
         */
        function withClock() {
            const clock = { now: 1_000_000 };
            const type = new HLSMonitorType();
            type.now = () => clock.now;
            return { type, clock };
        }

        test("check() records the first sight and stays UP for an unchanged playlist inside the window", async () => {
            routes["/media.m3u8"] = { body: mediaPlaylist({ target: 6 }) };
            routes["/s101.ts"] = { segment: true };
            const { type, clock } = withClock();

            await check(type, "/media.m3u8", { id: 1 });
            clock.now += 20_000;
            const heartbeat = await check(type, "/media.m3u8", { id: 1 });

            assert.strictEqual(heartbeat.status, UP);
        });

        test("check() fails with a stale message when the playlist is unchanged past max(3 x target, 30s)", async () => {
            routes["/media.m3u8"] = { body: mediaPlaylist({ seq: 123, target: 6 }) };
            routes["/s101.ts"] = { segment: true };
            const { type, clock } = withClock();

            await check(type, "/media.m3u8", { id: 1 });
            clock.now += 31_000;

            await assert.rejects(
                check(type, "/media.m3u8", { id: 1 }),
                /^Error: playlist stale: media sequence 123 unchanged for 31s$/
            );
        });

        test("check() uses 3 x target duration as window when that is longer than 30s", async () => {
            routes["/media.m3u8"] = { body: mediaPlaylist({ seq: 5, target: 20 }) };
            routes["/s101.ts"] = { segment: true };
            const { type, clock } = withClock();

            await check(type, "/media.m3u8", { id: 1 });
            clock.now += 59_000;
            await check(type, "/media.m3u8", { id: 1 });
            clock.now += 2_000;

            await assert.rejects(
                check(type, "/media.m3u8", { id: 1 }),
                /playlist stale: media sequence 5 unchanged for 61s/
            );
        });

        test("check() stays UP when the media sequence advances", async () => {
            let seq = 100;
            routes["/media.m3u8"] = {
                body: () => mediaPlaylist({ seq, segments: [`s${seq}.ts`] }),
            };
            routes["/s100.ts"] = { segment: true };
            routes["/s200.ts"] = { segment: true };
            routes["/s300.ts"] = { segment: true };
            const { type, clock } = withClock();

            await check(type, "/media.m3u8", { id: 1 });
            clock.now += 100_000;
            seq = 200;
            await check(type, "/media.m3u8", { id: 1 });
            clock.now += 100_000;
            seq = 300;
            const heartbeat = await check(type, "/media.m3u8", { id: 1 });

            assert.strictEqual(heartbeat.status, UP);
        });

        test("check() restarts the window when only the last segment changes", async () => {
            let last = "s101.ts";
            routes["/media.m3u8"] = { body: () => mediaPlaylist({ seq: 100, segments: [last] }) };
            routes["/s101.ts"] = { segment: true };
            routes["/s102.ts"] = { segment: true };
            const { type, clock } = withClock();

            await check(type, "/media.m3u8", { id: 1 });
            clock.now += 25_000;
            last = "s102.ts";
            await check(type, "/media.m3u8", { id: 1 });
            clock.now += 25_000;
            const heartbeat = await check(type, "/media.m3u8", { id: 1 });

            assert.strictEqual(heartbeat.status, UP);
        });

        test("check() never fails as stale for a monitor without id", async () => {
            routes["/media.m3u8"] = { body: mediaPlaylist() };
            routes["/s101.ts"] = { segment: true };
            const { type, clock } = withClock();

            await check(type, "/media.m3u8");
            clock.now += 3_600_000;
            const heartbeat = await check(type, "/media.m3u8");

            assert.strictEqual(heartbeat.status, UP);
            assert.strictEqual(type.state.size, 0);
        });
    });

    describe("parsePlaylist()", () => {
        test("parsePlaylist() reads master variants even when a blank line or comment follows STREAM-INF", () => {
            const parsed = parsePlaylist(
                "#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=1\r\n\r\n#comment\r\nlow.m3u8\r\n#EXT-X-STREAM-INF:BANDWIDTH=2\r\nhigh.m3u8?x=1\r\n"
            );

            assert.strictEqual(parsed.isMaster, true);
            assert.deepStrictEqual(parsed.variants, ["low.m3u8", "high.m3u8?x=1"]);
        });

        test("parsePlaylist() rejects text without the EXTM3U header", () => {
            assert.throws(() => parsePlaylist("hello"), /does not start with #EXTM3U/);
        });
    });
});
