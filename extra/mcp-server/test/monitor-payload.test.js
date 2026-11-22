import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EDITABLE_FIELDS, buildAddPayload, buildEditPayload, diffFields } from "../src/monitor-payload.js";
import { MASK } from "../src/redact.js";

const NOTIFICATIONS = [
    { id: 1, name: "Chat", isDefault: true, active: true },
    { id: 2, name: "Mail", isDefault: false, active: true },
    { id: 3, name: "Pager", isDefault: true, active: true },
];

describe("EDITABLE_FIELDS", () => {
    it("holds the keys the editMonitor handler reads, but not id", () => {
        assert.ok(Object.isFrozen(EDITABLE_FIELDS));
        assert.ok(!EDITABLE_FIELDS.includes("id"));
        for (const field of ["forkOptions", "accepted_statuscodes", "notificationIDList", "url", "timeout", "port"]) {
            assert.ok(EDITABLE_FIELDS.includes(field), field);
        }
        assert.equal(new Set(EDITABLE_FIELDS).size, EDITABLE_FIELDS.length);
    });

    it("covers every key a new monitor is built with", () => {
        const payload = buildAddPayload({ type: "http", name: "x" }, []);
        const missing = Object.keys(payload).filter((key) => !EDITABLE_FIELDS.includes(key));
        assert.deepEqual(missing, []);
    });
});

describe("buildAddPayload", () => {
    it("starts from the web form defaults", () => {
        const payload = buildAddPayload({ type: "http", name: "Site", fields: { url: "https://example.com" } }, []);
        assert.equal(payload.type, "http");
        assert.equal(payload.name, "Site");
        assert.equal(payload.url, "https://example.com");
        assert.equal(payload.interval, 60);
        assert.equal(payload.retryInterval, 60);
        assert.equal(payload.maxretries, 0);
        assert.equal(payload.method, "GET");
        assert.deepEqual(payload.accepted_statuscodes, ["200-299"]);
        assert.deepEqual(payload.forkOptions, { checkIps: [], checkDns: false, headerConditions: [] });
        assert.deepEqual(payload.kafkaProducerSaslOptions, { mechanism: "None" });
        assert.ok(!("humanReadableInterval" in payload));
        assert.ok(!("id" in payload));
    });

    it("gives a fresh payload every time", () => {
        const a = buildAddPayload({ type: "http", name: "a" }, []);
        a.forkOptions.checkIps.push("192.0.2.1");
        a.accepted_statuscodes.push("300");
        const b = buildAddPayload({ type: "http", name: "b" }, []);
        assert.deepEqual(b.forkOptions.checkIps, []);
        assert.deepEqual(b.accepted_statuscodes, ["200-299"]);
    });

    it("gives http-like types timeout 48, which is 80% of the default interval", () => {
        for (const type of ["http", "keyword", "icecast", "hls", "dash", "port"]) {
            const payload = buildAddPayload({ type, name: "x" }, []);
            assert.equal(payload.timeout, 48, type);
            assert.equal(payload.type, type);
        }
        assert.equal(buildAddPayload({ type: "hls", name: "x" }, []).url, "https://");
    });

    it("uses the per-type timeout and values of the form", () => {
        assert.equal(buildAddPayload({ type: "ping", name: "x" }, []).timeout, 10);
        assert.equal(buildAddPayload({ type: "snmp", name: "x" }, []).timeout, 5);
        assert.equal(buildAddPayload({ type: "kafka-producer", name: "x" }, []).timeout, 1);
        const ws = buildAddPayload({ type: "websocket-upgrade", name: "x" }, []);
        assert.equal(ws.url, "wss://");
        assert.deepEqual(ws.accepted_statuscodes, ["1000"]);
        const dns = buildAddPayload({ type: "dns", name: "x" }, []);
        assert.equal(dns.port, 53);
        assert.equal(dns.dns_resolve_server, "1.1.1.1");
        const ntp = buildAddPayload({ type: "ntp", name: "x" }, []);
        assert.equal(ntp.interval, 300);
        assert.equal(ntp.timeout, 48);
        assert.match(buildAddPayload({ type: "push", name: "x" }, []).pushToken, /^[A-Za-z0-9]{32}$/);
    });

    it("links the retry interval to the interval and clamps a default timeout to 80% of it", () => {
        const payload = buildAddPayload({ type: "http", name: "x", fields: { interval: 20 } }, []);
        assert.equal(payload.retryInterval, 20);
        assert.equal(payload.timeout, 16);
        const explicit = buildAddPayload(
            { type: "http", name: "x", fields: { interval: 20, retryInterval: 90, timeout: 30 } },
            []
        );
        assert.equal(explicit.retryInterval, 90);
        assert.equal(explicit.timeout, 30);
    });

    it("applies fields over the defaults, but type and name come from their own arguments", () => {
        const payload = buildAddPayload(
            {
                type: "keyword",
                name: "Real name",
                fields: { name: "ignored", keyword: "ok", maxretries: 3, forkOptions: { checkIps: ["192.0.2.5"] } },
            },
            []
        );
        assert.equal(payload.name, "Real name");
        assert.equal(payload.keyword, "ok");
        assert.equal(payload.maxretries, 3);
        assert.deepEqual(payload.forkOptions, { checkIps: ["192.0.2.5"] });
    });

    it("attaches every default notification when none are given", () => {
        const payload = buildAddPayload({ type: "http", name: "x" }, NOTIFICATIONS);
        assert.deepEqual(payload.notificationIDList, { 1: true, 3: true });
    });

    it("uses the given notification ids instead, as an array or a map", () => {
        assert.deepEqual(
            buildAddPayload({ type: "http", name: "x", notificationIds: [2] }, NOTIFICATIONS).notificationIDList,
            { 2: true }
        );
        assert.deepEqual(
            buildAddPayload({ type: "http", name: "x", notificationIds: { 2: true } }, NOTIFICATIONS)
                .notificationIDList,
            { 2: true }
        );
        assert.deepEqual(
            buildAddPayload({ type: "http", name: "x", notificationIds: [] }, NOTIFICATIONS).notificationIDList,
            {}
        );
    });

    it("throws naming unknown keys", () => {
        assert.throws(
            () => buildAddPayload({ type: "http", name: "x", fields: { bogus: 1, another: 2, url: "https://a" } }, []),
            /bogus, another/
        );
        assert.throws(() => buildAddPayload({ type: "http", name: "x", fields: { id: 5 } }, []), /id/);
    });

    it("throws naming fields that carry the mask", () => {
        assert.throws(
            () => buildAddPayload({ type: "http", name: "x", fields: { basic_auth_pass: MASK } }, []),
            /basic_auth_pass/
        );
        assert.throws(
            () =>
                buildAddPayload(
                    { type: "http", name: "x", fields: { headers: JSON.stringify({ Authorization: MASK }) } },
                    []
                ),
            /headers/
        );
    });

    it("throws when accepted_statuscodes is not an array of strings", () => {
        assert.throws(
            () => buildAddPayload({ type: "http", name: "x", fields: { accepted_statuscodes: [200] } }, []),
            /accepted_statuscodes/
        );
        assert.throws(
            () => buildAddPayload({ type: "http", name: "x", fields: { accepted_statuscodes: "200-299" } }, []),
            /accepted_statuscodes/
        );
    });
});

describe("buildEditPayload", () => {
    const current = {
        id: 7,
        name: "Site",
        type: "http",
        url: "https://example.com",
        basic_auth_pass: "stored-secret",
        headers: JSON.stringify({ Authorization: "Bearer stored" }),
        accepted_statuscodes: ["200-299"],
        notificationIDList: { 1: true },
        forkOptions: { checkIps: [], checkDns: false, headerConditions: [] },
        extraServerField: "kept",
    };

    it("merges the patch onto the current object and keeps everything else", () => {
        const payload = buildEditPayload(current, { interval: 30, name: "Renamed" });
        assert.equal(payload.id, 7);
        assert.equal(payload.name, "Renamed");
        assert.equal(payload.interval, 30);
        assert.equal(payload.url, "https://example.com");
        assert.equal(payload.basic_auth_pass, "stored-secret");
        assert.equal(payload.extraServerField, "kept");
    });

    it("drops a patch value that is exactly the mask so the stored secret stays", () => {
        const payload = buildEditPayload(current, { basic_auth_pass: MASK, url: "https://example.org" });
        assert.equal(payload.basic_auth_pass, "stored-secret");
        assert.equal(payload.url, "https://example.org");
    });

    it("lets a real new secret through", () => {
        assert.equal(buildEditPayload(current, { basic_auth_pass: "new" }).basic_auth_pass, "new");
    });

    it("throws when a value only contains the mask", () => {
        assert.throws(() => buildEditPayload(current, { headers: JSON.stringify({ Authorization: MASK }) }), /headers/);
        assert.throws(() => buildEditPayload(current, { keyword: `a${MASK}b` }), /keyword/);
    });

    it("throws naming keys outside EDITABLE_FIELDS, including id", () => {
        assert.throws(() => buildEditPayload(current, { bogus: 1, id: 8 }), /bogus, id/);
        assert.throws(() => buildEditPayload(current, { active: false }), /active/);
    });

    it("replaces the notifications when ids are given", () => {
        assert.deepEqual(buildEditPayload(current, {}, [2, 3]).notificationIDList, { 2: true, 3: true });
        assert.deepEqual(buildEditPayload(current, {}, []).notificationIDList, {});
        assert.deepEqual(buildEditPayload(current, {}).notificationIDList, { 1: true });
    });

    it("validates accepted_statuscodes of the result", () => {
        assert.throws(() => buildEditPayload(current, { accepted_statuscodes: [200] }), /accepted_statuscodes/);
        assert.throws(() => buildEditPayload({ ...current, accepted_statuscodes: undefined }, {}), /accepted_/);
    });

    it("never mutates its inputs and shares no references with them", () => {
        const currentCopy = structuredClone(current);
        const patch = { forkOptions: { checkIps: ["192.0.2.9"], checkDns: true, headerConditions: [] } };
        const patchCopy = structuredClone(patch);
        const payload = buildEditPayload(current, patch, [4]);
        assert.deepEqual(current, currentCopy);
        assert.deepEqual(patch, patchCopy);
        payload.forkOptions.checkIps.push("x");
        payload.accepted_statuscodes.push("300");
        assert.deepEqual(patch, patchCopy);
        assert.deepEqual(current.accepted_statuscodes, ["200-299"]);
    });
});

describe("diffFields", () => {
    it("reports changed editable fields with before and after", () => {
        const before = { id: 1, name: "A", interval: 60, url: "https://a.example.com" };
        const after = { ...before, name: "B", interval: 30 };
        assert.deepEqual(diffFields(before, after), {
            name: { before: "A", after: "B" },
            interval: { before: 60, after: 30 },
        });
    });

    it("compares nested values deeply and ignores non-editable fields", () => {
        const before = { forkOptions: { checkIps: ["192.0.2.1"] }, id: 1, active: true, tags: [] };
        assert.deepEqual(diffFields(before, structuredClone({ ...before, active: false, tags: [1] })), {});
        const after = { ...before, forkOptions: { checkIps: ["192.0.2.1", "192.0.2.2"] } };
        assert.deepEqual(Object.keys(diffFields(before, after)), ["forkOptions"]);
    });

    it("shows secrets masked on both sides", () => {
        const before = { headers: JSON.stringify({ Authorization: "old", Accept: "a" }) };
        const after = { headers: JSON.stringify({ Authorization: "new", Accept: "b" }) };
        const diff = diffFields(before, after);
        assert.ok(!JSON.stringify(diff).includes("old"));
        assert.ok(!JSON.stringify(diff).includes("new"));
        assert.deepEqual(Object.keys(diff), ["headers"]);
    });

    it("flags a change that the masking hides", () => {
        assert.deepEqual(diffFields({ basic_auth_pass: "a" }, { basic_auth_pass: "b" }), {
            basic_auth_pass: { before: MASK, after: MASK, secretChanged: true },
        });
        assert.deepEqual(diffFields({ basic_auth_pass: "a", name: "x" }, { basic_auth_pass: "a", name: "x" }), {});
        assert.equal(diffFields({ interval: 60 }, { interval: 30 }).interval.secretChanged, undefined);
    });
});
