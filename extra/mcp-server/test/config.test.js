import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const base = { KUMA_URL: "https://kuma.example.com", KUMA_USERNAME: "admin", KUMA_PASSWORD: "secret" };

test("loadConfig requires KUMA_URL", () => {
    assert.throws(() => loadConfig({ KUMA_JWT: "token" }), /KUMA_URL/);
});

test("loadConfig requires a JWT or a username and password", () => {
    assert.throws(() => loadConfig({ KUMA_URL: base.KUMA_URL }), /KUMA_JWT.*KUMA_USERNAME.*KUMA_PASSWORD/);
    assert.throws(() => loadConfig({ KUMA_URL: base.KUMA_URL, KUMA_USERNAME: "admin" }), /KUMA_PASSWORD/);
    assert.throws(() => loadConfig({ KUMA_URL: base.KUMA_URL, KUMA_PASSWORD: "secret" }), /KUMA_USERNAME/);
});

test("loadConfig accepts username and password", () => {
    assert.deepEqual(loadConfig(base), {
        url: base.KUMA_URL,
        username: "admin",
        password: "secret",
        jwt: undefined,
        writeEnabled: false,
    });
});

test("loadConfig accepts a JWT alone", () => {
    const config = loadConfig({ KUMA_URL: base.KUMA_URL, KUMA_JWT: "token" });
    assert.equal(config.jwt, "token");
    assert.equal(config.username, undefined);
});

test("loadConfig enables writes only for 1 or true", () => {
    assert.equal(loadConfig({ ...base, KUMA_MCP_WRITE: "1" }).writeEnabled, true);
    assert.equal(loadConfig({ ...base, KUMA_MCP_WRITE: "true" }).writeEnabled, true);
    for (const value of ["0", "false", "TRUE", "yes", "", " 1"]) {
        assert.equal(loadConfig({ ...base, KUMA_MCP_WRITE: value }).writeEnabled, false, value);
    }
    assert.equal(loadConfig(base).writeEnabled, false);
});

test("loadConfig reads process.env by default", () => {
    const saved = { ...process.env };
    try {
        process.env.KUMA_URL = base.KUMA_URL;
        process.env.KUMA_JWT = "token";
        assert.equal(loadConfig().url, base.KUMA_URL);
    } finally {
        for (const key of ["KUMA_URL", "KUMA_JWT"]) {
            if (saved[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = saved[key];
            }
        }
    }
});
