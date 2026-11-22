import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MASK, hasMask, maskMonitor, maskUrl, truncateDetail } from "../src/redact.js";

describe("maskMonitor", () => {
    it("masks every secret field that has a value", () => {
        const fields = [
            "basic_auth_pass",
            "bearer_token",
            "oauth_client_secret",
            "gamedigToken",
            "pushToken",
            "databaseConnectionString",
            "radiusPassword",
            "radiusSecret",
            "mqttPassword",
            "tlsKey",
            "rabbitmqPassword",
            "sshPassword",
            "sshPrivateKey",
            "sshPassphrase",
            "body",
            "grpcBody",
        ];
        const monitor = Object.fromEntries(fields.map((f) => [f, `clear-${f}`]));
        const masked = maskMonitor({ id: 1, name: "keep", ...monitor });
        for (const field of fields) {
            assert.equal(masked[field], MASK, field);
        }
        assert.equal(masked.name, "keep");
        assert.equal(masked.id, 1);
    });

    it("leaves empty, null and undefined values as they are", () => {
        const masked = maskMonitor({ basic_auth_pass: "", bearer_token: null, pushToken: undefined, headers: "" });
        assert.equal(masked.basic_auth_pass, "");
        assert.equal(masked.bearer_token, null);
        assert.ok("pushToken" in masked);
        assert.equal(masked.pushToken, undefined);
        assert.equal(masked.headers, "");
    });

    it("masks only sensitive header names and keeps the rest", () => {
        const headers = JSON.stringify({
            Authorization: "Bearer abc",
            "X-Api-Key": "k",
            "x-apikey": "k2",
            Cookie: "a=b",
            "X-Auth-Token": "t",
            "Client-Secret": "s",
            "X-Password": "p",
            "X-Signature": "sig",
            "Content-Type": "application/json",
            Accept: "*/*",
            "X-Empty-Token": "",
        });
        const masked = JSON.parse(maskMonitor({ headers }).headers);
        assert.equal(masked.Authorization, MASK);
        assert.equal(masked["X-Api-Key"], MASK);
        assert.equal(masked["x-apikey"], MASK);
        assert.equal(masked.Cookie, MASK);
        assert.equal(masked["X-Auth-Token"], MASK);
        assert.equal(masked["Client-Secret"], MASK);
        assert.equal(masked["X-Password"], MASK);
        assert.equal(masked["X-Signature"], MASK);
        assert.equal(masked["Content-Type"], "application/json");
        assert.equal(masked.Accept, "*/*");
        assert.equal(masked["X-Empty-Token"], "");
    });

    it("treats grpcMetadata like headers", () => {
        const masked = maskMonitor({ grpcMetadata: JSON.stringify({ authorization: "x", trace: "y" }) });
        assert.deepEqual(JSON.parse(masked.grpcMetadata), { authorization: MASK, trace: "y" });
    });

    it("masks headers that are not a JSON object", () => {
        assert.equal(maskMonitor({ headers: "Authorization: Bearer abc" }).headers, MASK);
        assert.equal(maskMonitor({ headers: "[1,2]" }).headers, MASK);
        assert.equal(maskMonitor({ grpcMetadata: "{broken" }).grpcMetadata, MASK);
    });

    it("masks the secrets inside the Kafka SASL options", () => {
        const masked = maskMonitor({
            kafkaProducerSaslOptions: {
                mechanism: "aws",
                username: "user",
                password: "pw",
                secretAccessKey: "sk",
                sessionToken: "st",
                accessKeyId: "id",
            },
        });
        assert.deepEqual(masked.kafkaProducerSaslOptions, {
            mechanism: "aws",
            username: "user",
            password: MASK,
            secretAccessKey: MASK,
            sessionToken: MASK,
            accessKeyId: "id",
        });
        assert.deepEqual(maskMonitor({ kafkaProducerSaslOptions: { mechanism: "None", password: "" } }), {
            kafkaProducerSaslOptions: { mechanism: "None", password: "" },
        });
        assert.equal(maskMonitor({ kafkaProducerSaslOptions: null }).kafkaProducerSaslOptions, null);
    });

    it("deletes screenshot and includeSensitiveData", () => {
        const masked = maskMonitor({ screenshot: "/screenshots/token.png", includeSensitiveData: true, name: "x" });
        assert.deepEqual(masked, { name: "x" });
    });

    it("does not mutate its input and returns a deep copy", () => {
        const input = {
            basic_auth_pass: "pw",
            headers: JSON.stringify({ Authorization: "a" }),
            kafkaProducerSaslOptions: { password: "pw" },
            screenshot: "s",
            forkOptions: { checkIps: ["192.0.2.1"], checkDns: false, headerConditions: [] },
        };
        const snapshot = structuredClone(input);
        const masked = maskMonitor(input);
        assert.deepEqual(input, snapshot);
        masked.forkOptions.checkIps.push("192.0.2.2");
        assert.deepEqual(input.forkOptions.checkIps, ["192.0.2.1"]);
    });
});

describe("maskUrl", () => {
    it("masks the password and sensitive query values", () => {
        assert.equal(maskUrl("https://user:hunter2@example.com/health"), "https://user:***@example.com/health");
        assert.equal(
            maskUrl("https://example.com/health?token=abc123&zone=eu&api_key=k"),
            "https://example.com/health?token=***&zone=eu&api_key=***"
        );
    });

    it("returns a URL without secrets, and anything that is not a URL, untouched", () => {
        assert.equal(maskUrl("https://example.com/a b?x=1"), "https://example.com/a b?x=1");
        assert.equal(maskUrl("https://"), "https://");
        assert.equal(maskUrl(null), null);
        assert.equal(maskUrl(undefined), undefined);
    });

    it("is applied to the monitor url", () => {
        assert.equal(maskMonitor({ url: "https://example.com/?secret=s" }).url, "https://example.com/?secret=***");
    });
});

describe("hasMask", () => {
    it("finds the mask in strings, objects and arrays", () => {
        assert.equal(hasMask(MASK), true);
        assert.equal(hasMask(`prefix ${MASK} suffix`), true);
        assert.equal(hasMask({ a: { b: ["x", MASK] } }), true);
        assert.equal(hasMask([{ deep: JSON.stringify({ Authorization: MASK }) }]), true);
    });

    it("is false for everything else", () => {
        assert.equal(hasMask("plain"), false);
        assert.equal(hasMask({ a: 1, b: null, c: ["x"] }), false);
        assert.equal(hasMask(null), false);
        assert.equal(hasMask(undefined), false);
        assert.equal(hasMask(42), false);
    });
});

describe("truncateDetail", () => {
    it("caps body and peer body with a marker and leaves short ones alone", () => {
        const detail = {
            v: 1,
            body: "a".repeat(50),
            peer: { status: 1, detail: { body: "b".repeat(50), ip: "192.0.2.1" } },
        };
        const out = truncateDetail(detail, 10);
        assert.equal(out.body, `${"a".repeat(10)}... (truncated)`);
        assert.equal(out.peer.detail.body, `${"b".repeat(10)}... (truncated)`);
        assert.equal(out.peer.detail.ip, "192.0.2.1");
        assert.equal(truncateDetail({ body: "short" }, 10).body, "short");
    });

    it("uses 4000 characters by default and does not mutate the input", () => {
        const detail = { body: "x".repeat(5000) };
        const out = truncateDetail(detail);
        assert.equal(out.body.length, 4000 + "... (truncated)".length);
        assert.equal(detail.body.length, 5000);
    });

    it("copes with a missing body, a missing peer and a null detail", () => {
        assert.deepEqual(truncateDetail({ v: 1 }), { v: 1 });
        assert.deepEqual(truncateDetail({ body: null, peer: { status: 0, detail: null } }), {
            body: null,
            peer: { status: 0, detail: null },
        });
        assert.equal(truncateDetail(null), null);
    });
});
