const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { DashMonitorType, parseXml, fillTemplate } = require("../../../server/monitor-types/dash");
const { UP, PENDING } = require("../../../src/util");

describe("DASH Monitor", () => {
    let server;
    let baseUrl;
    /** Fixture routes by path: { status, body } ; paths flagged "segment" answer ranged requests with 206 */
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
            if (route.segment) {
                res.writeHead(req.headers.range ? 206 : 200, { "Content-Type": "video/mp4" });
                res.end(Buffer.alloc(1024));
                return;
            }
            res.writeHead(route.status || 200, { "Content-Type": "application/dash+xml" });
            res.end(route.body);
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
     * Build an MPD document
     * @param {object} attrs MPD attributes
     * @param {string} inner Content of the MPD element
     * @returns {string} MPD text
     */
    function mpd(attrs, inner) {
        const attrText = Object.entries(attrs)
            .map(([key, value]) => `${key}="${value}"`)
            .join(" ");
        return `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attrText}>${inner}</MPD>`;
    }

    /**
     * Run one check
     * @param {DashMonitorType} type Monitor type instance
     * @param {string} path MPD path on the fixture server
     * @param {object} extra Extra monitor fields
     * @returns {Promise<object>} Heartbeat
     */
    async function check(type, path = "/live.mpd", extra = {}) {
        const heartbeat = { msg: "", status: PENDING };
        await type.check({ url: baseUrl + path, timeout: 3, ...extra }, heartbeat, {});
        return heartbeat;
    }

    const staticNumberMpd = mpd(
        { type: "static", mediaPresentationDuration: "PT30S" },
        `<Period>
            <AdaptationSet contentType="audio" mimeType="audio/mp4">
                <SegmentTemplate initialization="a-init.mp4" media="a-$Number$.m4s" duration="4" startNumber="1"/>
                <Representation id="a1" bandwidth="64000"/>
            </AdaptationSet>
            <AdaptationSet contentType="video" mimeType="video/mp4">
                <SegmentTemplate initialization="init-$RepresentationID$.mp4" media="seg-$RepresentationID$-$Number%05d$.m4s" duration="4" startNumber="1"/>
                <Representation id="v1" bandwidth="800000"/>
                <Representation id="v2" bandwidth="1600000"/>
            </AdaptationSet>
        </Period>`
    );

    test("check() sets UP for a static SegmentTemplate with $Number$ and picks the video set", async () => {
        routes["/live.mpd"] = { body: staticNumberMpd };
        routes["/init-v1.mp4"] = { segment: true };
        routes["/seg-v1-00001.m4s"] = { segment: true };

        const heartbeat = await check(new DashMonitorType());

        assert.strictEqual(heartbeat.status, UP);
        assert.strictEqual(
            heartbeat.msg,
            "static, 2 adaptation sets, 3 representations, init 206, newest segment 206 (n=1)"
        );
        assert.ok(heartbeat.ping >= 0);
        assert.strictEqual(requests.find((r) => r.url === "/init-v1.mp4").headers.range, "bytes=0-1023");
    });

    test("check() sets UP for a dynamic SegmentTimeline with $Time$ and fetches the newest segment", async () => {
        routes["/live.mpd"] = {
            body: mpd(
                { type: "dynamic", publishTime: "2026-11-22T10:00:00Z", minimumUpdatePeriod: "PT2S" },
                `<Period>
                    <AdaptationSet mimeType="video/mp4">
                        <SegmentTemplate timescale="1000" initialization="video/init.mp4" media="video/seg-$Time$.m4s">
                            <SegmentTimeline>
                                <S t="1000" d="2000" r="2"/>
                                <S d="2000"/>
                            </SegmentTimeline>
                        </SegmentTemplate>
                        <Representation id="v1" bandwidth="800000"/>
                    </AdaptationSet>
                </Period>`
            ),
        };
        routes["/video/init.mp4"] = { segment: true };
        routes["/video/seg-7000.m4s"] = { segment: true };

        const heartbeat = await check(new DashMonitorType());

        assert.strictEqual(heartbeat.status, UP);
        assert.strictEqual(
            heartbeat.msg,
            "dynamic, 1 adaptation set, 1 representation, init 206, newest segment 206 (t=7000)"
        );
    });

    test("check() computes $Number$ from startNumber over the timeline repeat counts", async () => {
        routes["/live.mpd"] = {
            body: mpd(
                { type: "dynamic" },
                `<Period><AdaptationSet contentType="video">
                    <Representation id="v1" bandwidth="1">
                        <SegmentTemplate startNumber="100" initialization="init.mp4" media="s$Number%04d$.m4s">
                            <SegmentTimeline><S t="0" d="10" r="4"/><S d="10" r="1"/></SegmentTimeline>
                        </SegmentTemplate>
                    </Representation>
                </AdaptationSet></Period>`
            ),
        };
        routes["/init.mp4"] = { segment: true };
        // 5 + 2 segments, the last one has number 100 + 7 - 1
        routes["/s0106.m4s"] = { segment: true };

        const heartbeat = await check(new DashMonitorType());

        assert.match(heartbeat.msg, /newest segment 206 \(n=106\)$/);
    });

    test("check() resolves BaseURL at MPD, Period and Representation level", async () => {
        routes["/live.mpd"] = {
            body: mpd(
                { type: "static" },
                `<BaseURL>cdn/</BaseURL>
                <Period>
                    <BaseURL>${baseUrl}/abs/</BaseURL>
                    <AdaptationSet contentType="video">
                        <SegmentTemplate initialization="init.mp4" media="$Number$.m4s" duration="2"/>
                        <Representation id="v1" bandwidth="1"><BaseURL>hd/</BaseURL></Representation>
                    </AdaptationSet>
                </Period>`
            ),
        };
        routes["/abs/hd/init.mp4"] = { segment: true };
        routes["/abs/hd/1.m4s"] = { segment: true };

        const heartbeat = await check(new DashMonitorType());

        assert.strictEqual(heartbeat.status, UP);
    });

    test("check() resolves a relative BaseURL against the MPD URL", async () => {
        routes["/vod/live.mpd"] = {
            body: mpd(
                { type: "static" },
                `<BaseURL>media/</BaseURL><Period><AdaptationSet contentType="video">
                    <SegmentTemplate initialization="init.mp4" media="$Number$.m4s" duration="2"/>
                    <Representation id="v1" bandwidth="1"/></AdaptationSet></Period>`
            ),
        };
        routes["/vod/media/init.mp4"] = { segment: true };
        routes["/vod/media/1.m4s"] = { segment: true };

        const heartbeat = await check(new DashMonitorType(), "/vod/live.mpd?token=secret");

        assert.strictEqual(heartbeat.status, UP);
        // The MPD's query string is not passed on to segments
        assert.ok(requests.every((r) => r.url === "/vod/live.mpd?token=secret" || !r.url.includes("token")));
    });

    test("check() fails and names the URL without query when the init segment answers 404", async () => {
        routes["/live.mpd"] = { body: staticNumberMpd };
        routes["/seg-v1-00001.m4s"] = { segment: true };

        await assert.rejects(check(new DashMonitorType(), "/live.mpd?token=secret"), (error) => {
            assert.match(error.message, /^init segment http:\/\/127\.0\.0\.1:\d+\/init-v1\.mp4 returned HTTP 404$/);
            return true;
        });
    });

    test("check() fails when the newest segment answers 404", async () => {
        routes["/live.mpd"] = { body: staticNumberMpd };
        routes["/init-v1.mp4"] = { segment: true };

        await assert.rejects(check(new DashMonitorType()), /newest segment .*seg-v1-00001\.m4s returned HTTP 404/);
    });

    test("check() skips the media segment for a dynamic $Number$ template with duration and says so", async () => {
        routes["/live.mpd"] = {
            body: mpd(
                { type: "dynamic" },
                `<Period><AdaptationSet contentType="video">
                    <SegmentTemplate initialization="init.mp4" media="$Number$.m4s" duration="2" startNumber="1"/>
                    <Representation id="v1" bandwidth="1"/></AdaptationSet></Period>`
            ),
        };
        routes["/init.mp4"] = { segment: true };

        const heartbeat = await check(new DashMonitorType());

        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /media segment skipped \(dynamic manifest without SegmentTimeline\)/);
        assert.deepStrictEqual(
            requests.map((r) => r.url),
            ["/live.mpd", "/init.mp4"]
        );
    });

    test("check() fetches the BaseURL file for a SegmentBase manifest", async () => {
        routes["/live.mpd"] = {
            body: mpd(
                { type: "static" },
                `<Period><AdaptationSet contentType="video">
                    <Representation id="v1" bandwidth="1">
                        <BaseURL>video.mp4</BaseURL>
                        <SegmentBase indexRange="0-800"><Initialization range="0-500"/></SegmentBase>
                    </Representation></AdaptationSet></Period>`
            ),
        };
        routes["/video.mp4"] = { segment: true };

        const heartbeat = await check(new DashMonitorType());

        assert.strictEqual(heartbeat.msg, "static, 1 adaptation set, 1 representation, media file 206");
    });

    test("check() is manifest-only for a SegmentList manifest without a file BaseURL", async () => {
        routes["/live.mpd"] = {
            body: mpd(
                { type: "static" },
                `<Period><AdaptationSet contentType="video">
                    <Representation id="v1" bandwidth="1">
                        <SegmentList duration="2"><SegmentURL media="a.m4s"/></SegmentList>
                    </Representation></AdaptationSet></Period>`
            ),
        };

        const heartbeat = await check(new DashMonitorType());

        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /no SegmentTemplate, manifest only$/);
        assert.strictEqual(requests.length, 1);
    });

    test("check() fails when the manifest has no Representation", async () => {
        routes["/live.mpd"] = {
            body: mpd({ type: "static" }, `<Period><AdaptationSet contentType="video"></AdaptationSet></Period>`),
        };

        await assert.rejects(check(new DashMonitorType()), /live\.mpd has no Representation/);
    });

    test("check() fails when the document has no MPD root", async () => {
        routes["/live.mpd"] = { body: "<html><body>Welcome</body></html>" };

        await assert.rejects(check(new DashMonitorType()), /live\.mpd has no MPD root element/);
    });

    test("check() fails with the status when the manifest answers 404", async () => {
        await assert.rejects(check(new DashMonitorType(), "/none.mpd"), /manifest .*\/none\.mpd returned HTTP 404/);
    });

    describe("staleness", () => {
        const timelineMpd = (lastTime) =>
            mpd(
                { type: "dynamic" },
                `<Period><AdaptationSet contentType="video">
                    <SegmentTemplate timescale="1000" initialization="init.mp4" media="s-$Time$.m4s">
                        <SegmentTimeline><S t="0" d="4000" r="${lastTime}"/></SegmentTimeline>
                    </SegmentTemplate>
                    <Representation id="v1" bandwidth="1"/></AdaptationSet></Period>`
            );

        /**
         * Create a type instance with a controllable clock
         * @returns {{type: DashMonitorType, clock: {now: number}}} Type and clock
         */
        function withClock() {
            const clock = { now: 1_000_000 };
            const type = new DashMonitorType();
            type.now = () => clock.now;
            return { type, clock };
        }

        test("check() fails with a stale message when the newest segment is unchanged past max(3 x duration, 30s)", async () => {
            routes["/live.mpd"] = { body: timelineMpd(3) };
            routes["/init.mp4"] = { segment: true };
            routes["/s-12000.m4s"] = { segment: true };
            const { type, clock } = withClock();

            await check(type, "/live.mpd", { id: 3 });
            clock.now += 20_000;
            await check(type, "/live.mpd", { id: 3 });
            clock.now += 11_000;

            await assert.rejects(
                check(type, "/live.mpd", { id: 3 }),
                /^Error: manifest stale: newest segment unchanged for 31s$/
            );
        });

        test("check() stays UP when the timeline advances", async () => {
            routes["/live.mpd"] = { body: timelineMpd(3) };
            routes["/init.mp4"] = { segment: true };
            routes["/s-12000.m4s"] = { segment: true };
            routes["/s-16000.m4s"] = { segment: true };
            routes["/s-20000.m4s"] = { segment: true };
            const { type, clock } = withClock();

            await check(type, "/live.mpd", { id: 3 });
            clock.now += 100_000;
            routes["/live.mpd"] = { body: timelineMpd(4) };
            await check(type, "/live.mpd", { id: 3 });
            clock.now += 100_000;
            routes["/live.mpd"] = { body: timelineMpd(5) };
            const heartbeat = await check(type, "/live.mpd", { id: 3 });

            assert.strictEqual(heartbeat.status, UP);
            assert.match(heartbeat.msg, /\(t=20000\)$/);
        });

        test("check() never fails as stale for a monitor without id", async () => {
            routes["/live.mpd"] = { body: timelineMpd(3) };
            routes["/init.mp4"] = { segment: true };
            routes["/s-12000.m4s"] = { segment: true };
            const { type, clock } = withClock();

            await check(type);
            clock.now += 3_600_000;
            const heartbeat = await check(type);

            assert.strictEqual(heartbeat.status, UP);
            assert.strictEqual(type.state.size, 0);
        });

        test("check() does not apply staleness to a static manifest and clears its state", async () => {
            routes["/live.mpd"] = { body: timelineMpd(3).replace("dynamic", "static") };
            routes["/init.mp4"] = { segment: true };
            routes["/s-12000.m4s"] = { segment: true };
            const { type, clock } = withClock();
            type.state.set(3, { key: "x", since: 0 });

            await check(type, "/live.mpd", { id: 3 });
            clock.now += 3_600_000;
            const heartbeat = await check(type, "/live.mpd", { id: 3 });

            assert.strictEqual(heartbeat.status, UP);
            assert.strictEqual(type.state.size, 0);
        });
    });

    describe("helpers", () => {
        test("fillTemplate() substitutes identifiers, widths and $$", () => {
            assert.strictEqual(
                fillTemplate("$RepresentationID$/$Bandwidth$/$Number%05d$-$Time$$$.m4s", {
                    RepresentationID: "v1",
                    Bandwidth: 800000,
                    Number: 42,
                    Time: 9000,
                }),
                "v1/800000/00042-9000$.m4s"
            );
        });

        test("parseXml() handles namespaces prefixes, entities, comments and CDATA", () => {
            const doc = parseXml(
                `<?xml version="1.0"?><!-- c --><dash:MPD type='dynamic'><BaseURL>http://h/a?x=1&amp;y=2</BaseURL><Note><![CDATA[<b>]]></Note><E a="1"/></dash:MPD>`
            );
            const root = doc.children[0];

            assert.strictEqual(root.name, "MPD");
            assert.strictEqual(root.attrs.type, "dynamic");
            assert.strictEqual(root.children[0].text, "http://h/a?x=1&y=2");
            assert.strictEqual(root.children[1].text, "<b>");
            assert.strictEqual(root.children[2].attrs.a, "1");
        });
    });
});
