import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";
import { Server } from "socket.io";
import { ALLOWED_EVENTS, KumaClient } from "../src/kuma-client.js";
import { startFakeKuma } from "./helpers/fake-kuma.js";

const MONITORS = {
    1: {
        id: 1,
        name: "Site",
        type: "http",
        url: "https://example.com",
        active: true,
        accepted_statuscodes: ["200-299"],
    },
    2: { id: 2, name: "Host", type: "port", hostname: "192.0.2.10", port: 443, active: true },
};
const NOTIFICATIONS = [
    { id: 1, name: "Chat", active: true, isDefault: true },
    { id: 2, name: "Mail", active: false, isDefault: false },
];

const cleanups = [];
afterEach(async () => {
    while (cleanups.length > 0) {
        await cleanups.pop()();
    }
});

/**
 * Start a fake and a client for it; both are closed after the test.
 * @param {object} fakeOptions Options for startFakeKuma
 * @param {object} clientOptions Extra options for KumaClient
 * @returns {Promise<{fake: object, client: KumaClient}>} Fake server and unconnected client
 */
async function setup(fakeOptions = {}, clientOptions = {}) {
    const fake = await startFakeKuma({ monitors: MONITORS, notifications: NOTIFICATIONS, ...fakeOptions });
    const client = new KumaClient({ url: fake.url, username: "admin", password: "secret", ...clientOptions });
    cleanups.push(async () => {
        client.close();
        await fake.close();
    });
    return { fake, client };
}

/**
 * Poll until a condition holds.
 * @param {Function} condition Returns true when done
 * @param {number} timeoutMs Give up after this long
 * @returns {Promise<void>} Resolves when the condition holds
 */
async function waitFor(condition, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > end) {
            throw new Error("waitFor timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe("KumaClient login", () => {
    it("logs in with a password and fills the caches before connect() resolves", async () => {
        const { client } = await setup({
            beats: { 1: [{ status: 1, time: "2026-01-02 03:04:05.000", ping: 12 }] },
        });
        await client.connect();
        assert.deepEqual(
            client
                .getMonitors()
                .map((m) => m.id)
                .sort(),
            [1, 2]
        );
        assert.equal(client.getLastBeat(1).status, 1);
        assert.deepEqual(client.getUptime(1), { 24: 1, 720: 0.995, "1y": 0.99 });
        assert.equal(client.getNotifications().length, 2);
    });

    it("logs in with a JWT and does not send the password", async () => {
        const { fake, client } = await setup({}, { jwt: "test-jwt", password: "wrong" });
        await client.connect();
        assert.deepEqual(
            fake.calls.map((c) => c.event),
            ["loginByToken"]
        );
        assert.equal(client.getMonitors().length, 2);
    });

    it("rejects a wrong password", async () => {
        const { client } = await setup({}, { password: "nope" });
        await assert.rejects(client.connect(), /authIncorrectCreds/);
    });

    it("rejects a wrong JWT", async () => {
        const { client } = await setup({}, { jwt: "bad" });
        await assert.rejects(client.connect(), /authInvalidToken/);
    });

    it("rejects with the KUMA_JWT hint when 2FA is on", async () => {
        const { client } = await setup({ twoFA: true });
        await assert.rejects(client.connect(), /Two-factor.*KUMA_JWT/);
    });

    it("rejects when nothing listens", async () => {
        const client = new KumaClient({ url: "http://127.0.0.1:1", username: "a", password: "b", timeoutMs: 500 });
        cleanups.push(async () => client.close());
        await assert.rejects(client.connect(), /Cannot connect/);
    });
});

describe("KumaClient caches", () => {
    it("normalizes raw rows and never keeps the response blob", async () => {
        const { client } = await setup({
            beats: {
                1: [
                    { status: 1, time: "2026-01-02 03:04:05.000", msg: "OK", ping: 10, important: 1 },
                    { status: 0, time: "2026-01-02 03:05:05.000", msg: "boom", response: "kd1:abc", retries: 2 },
                ],
            },
        });
        await client.connect();
        const [first, second] = client.getBeats(1);
        assert.deepEqual(first, {
            monitorId: 1,
            status: 1,
            time: "2026-01-02 03:04:05.000",
            msg: "OK",
            ping: 10,
            important: true,
            duration: 0,
            retries: 0,
            hasDetail: false,
        });
        assert.equal(second.hasDetail, true);
        assert.equal(second.retries, 2);
        assert.equal(second.important, false);
        assert.ok(client.getBeats(1).every((beat) => !("response" in beat)));
    });

    it("keeps at most 100 beats, newest last", async () => {
        const rows = Array.from({ length: 120 }, (_, i) => ({ status: 1, time: `2026-01-02 00:00:${i}`, ping: i }));
        const { client } = await setup({ beats: { 1: rows } });
        await client.connect();
        const beats = client.getBeats(1);
        assert.equal(beats.length, 100);
        assert.equal(beats.at(-1).ping, 119);
        assert.equal(beats[0].ping, 20);
    });

    it("appends a live heartbeat in the same shape and trims to 100", async () => {
        const rows = Array.from({ length: 100 }, (_, i) => ({ status: 1, time: `2026-01-02 00:00:${i}`, ping: i }));
        const { fake, client } = await setup({ beats: { 1: rows } });
        await client.connect();
        fake.io.emit("heartbeat", {
            monitorID: 1,
            status: 0,
            time: "2026-01-02 04:00:00.000",
            msg: "down now",
            ping: null,
            important: true,
            duration: 5,
            retries: 1,
            response: null,
            hasDetail: true,
        });
        await waitFor(() => client.getLastBeat(1).status === 0);
        const last = client.getLastBeat(1);
        assert.deepEqual(last, {
            monitorId: 1,
            status: 0,
            time: "2026-01-02 04:00:00.000",
            msg: "down now",
            ping: null,
            important: true,
            duration: 5,
            retries: 1,
            hasDetail: true,
        });
        assert.equal(client.getBeats(1).length, 100);
        assert.equal(client.getBeats(1)[0].ping, 1);
    });

    it("returns null and empty values for unknown monitors", async () => {
        const { client } = await setup();
        await client.connect();
        assert.equal(client.getLastBeat(99), null);
        assert.deepEqual(client.getBeats(99), []);
        assert.deepEqual(client.getUptime(99), {});
    });

    it("applies monitor list updates and deletes", async () => {
        const { fake, client } = await setup();
        await client.connect();
        fake.io.emit("updateMonitorIntoList", { 2: { id: 2, name: "Renamed" }, 3: { id: 3, name: "New" } });
        await waitFor(() => client.getMonitors().length === 3);
        const host = client.getMonitors().find((m) => m.id === 2);
        assert.equal(host.name, "Renamed");
        assert.equal(host.hostname, "192.0.2.10");
        fake.io.emit("deleteMonitorFromList", 3);
        await waitFor(() => client.getMonitors().length === 2);
    });

    it("reduces notifications to id, name, isDefault and active", async () => {
        const { client } = await setup();
        await client.connect();
        assert.deepEqual(client.getNotifications(), [
            { id: 1, name: "Chat", isDefault: true, active: true },
            { id: 2, name: "Mail", isDefault: false, active: false },
        ]);
        assert.ok(!JSON.stringify(client.getNotifications()).includes("do-not-leak"));
    });
});

describe("KumaClient requests", () => {
    it("reads, adds, edits, pauses and resumes monitors", async () => {
        const { client } = await setup();
        await client.connect();

        const monitor = await client.getMonitor(1);
        assert.equal(monitor.name, "Site");

        const id = await client.addMonitor({ name: "Added", type: "http", accepted_statuscodes: ["200-299"] });
        assert.equal(typeof id, "number");
        await waitFor(() => client.getMonitors().some((m) => m.id === id));

        await client.editMonitor({ ...monitor, name: "Edited" });
        assert.equal((await client.getMonitor(1)).name, "Edited");

        await client.pauseMonitor(1);
        assert.equal((await client.getMonitor(1)).active, false);
        await client.resumeMonitor(1);
        assert.equal((await client.getMonitor(1)).active, true);
    });

    it("returns the stored detail of a beat", async () => {
        const time = "2026-01-02 03:04:05.000";
        const { client } = await setup({ details: { [`1|${time}`]: { detail: { v: 1, body: "hello" } } } });
        await client.connect();
        assert.deepEqual(await client.getBeatDetail(1, time), { detail: { v: 1, body: "hello" }, body: null });
        await assert.rejects(client.getBeatDetail(1, "2000-01-01 00:00:00.000"), /Heartbeat not found/);
    });

    it("rejects with the server message when ok is false", async () => {
        const { client } = await setup();
        await client.connect();
        await assert.rejects(client.getMonitor(999), /^Error: Monitor not found$/);
        await assert.rejects(
            client.addMonitor({ name: "x", type: "http", accepted_statuscodes: [200] }),
            /not all strings/
        );
    });

    it("refuses an event outside ALLOWED_EVENTS without sending it", async () => {
        const { fake, client } = await setup();
        await client.connect();
        assert.ok(Object.isFrozen(ALLOWED_EVENTS));
        assert.ok(!ALLOWED_EVENTS.includes("deleteMonitor"));
        await assert.rejects(client._emit("deleteMonitor", 1, false), /not allowed/);
        await assert.rejects(client._emit("setSettings", {}), /not allowed/);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(fake.calls.every((c) => c.event !== "deleteMonitor" && c.event !== "setSettings"));
    });

    it("rejects with a timeout when the server never answers", async () => {
        const httpServer = createServer();
        const io = new Server(httpServer);
        io.on("connection", (socket) => {
            socket.emit("info", {});
            socket.on("login", (data, callback) => callback({ ok: true }));
        });
        await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
        const client = new KumaClient({
            url: `http://127.0.0.1:${httpServer.address().port}`,
            username: "a",
            password: "b",
            timeoutMs: 200,
        });
        cleanups.push(async () => {
            client.close();
            await new Promise((resolve) => io.close(resolve));
        });
        await client.connect();
        await assert.rejects(client.getMonitor(1), /getMonitor timed out after 200 ms/);
    });

    it("turns Kuma's answer for an unknown monitor id into a readable error", async () => {
        const httpServer = createServer();
        const io = new Server(httpServer);
        io.on("connection", (socket) => {
            socket.emit("info", {});
            socket.on("login", (data, callback) => callback({ ok: true }));
            socket.on("getMonitor", (id, callback) =>
                callback({ ok: false, msg: "Cannot read properties of null (reading 'id')" })
            );
        });
        await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
        const client = new KumaClient({
            url: `http://127.0.0.1:${httpServer.address().port}`,
            username: "a",
            password: "b",
        });
        cleanups.push(async () => {
            client.close();
            await new Promise((resolve) => io.close(resolve));
        });
        await client.connect();
        await assert.rejects(client.getMonitor(7), /^Error: Monitor 7 not found$/);
    });

    it("logs in only after the greeting, and once per connection", async () => {
        const { fake, client } = await setup();
        await client.connect();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(fake.calls.filter((c) => c.event === "login").length, 1);
    });

    it("rejects when the server never greets", async () => {
        const httpServer = createServer();
        const io = new Server(httpServer);
        await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
        const client = new KumaClient({
            url: `http://127.0.0.1:${httpServer.address().port}`,
            username: "a",
            password: "b",
            timeoutMs: 200,
        });
        cleanups.push(async () => {
            client.close();
            await new Promise((resolve) => io.close(resolve));
        });
        await assert.rejects(client.connect(), /No greeting from/);
    });

    it("rejects before connect() was called", async () => {
        const client = new KumaClient({ url: "http://127.0.0.1:1", username: "a", password: "b" });
        await assert.rejects(client.getMonitor(1), /Not connected/);
    });
});

describe("KumaClient reconnect", () => {
    it("logs in again after the transport was cut", async () => {
        const { fake, client } = await setup();
        await client.connect();
        const logins = () => fake.calls.filter((c) => c.event === "login").length;
        assert.equal(logins(), 1);

        // Closing the engine (not socket.disconnect) makes the client reconnect on its own
        for (const socket of fake.io.sockets.sockets.values()) {
            socket.conn.close();
        }
        await waitFor(() => logins() === 2);
        await waitFor(async () => {
            try {
                return (await client.getMonitor(1)).id === 1;
            } catch (_) {
                return false;
            }
        });
    });
});
