import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { buildAddPayload } from "../src/monitor-payload.js";

const READ_TOOLS = ["get_beat_detail", "get_monitor", "list_monitors", "list_notifications", "review_snapshot"];
const WRITE_TOOLS = ["add_monitor", "edit_monitor", "pause_monitor", "resume_monitor"];
const SECRET = "hunter2-secret-value";

/**
 * Build a stub with the KumaClient method list.
 * @param {object} overrides Methods that replace the defaults
 * @returns {object} Stub client, with `added` and `edited` recording write calls
 */
function makeKuma(overrides = {}) {
    const monitors = {
        1: {
            id: 1,
            name: "Web front",
            type: "http",
            url: "https://web.example.com/health",
            active: true,
            interval: 60,
            maxretries: 0,
            accepted_statuscodes: ["200-299"],
            basic_auth_user: "monitor",
            basic_auth_pass: SECRET,
            headers: JSON.stringify({ Authorization: "Bearer " + SECRET, Accept: "text/html" }),
            tags: [],
            notificationIDList: { 1: true },
        },
        2: {
            id: 2,
            name: "Database",
            type: "port",
            hostname: "192.0.2.10",
            port: 5432,
            active: true,
            interval: 60,
            accepted_statuscodes: ["200-299"],
            tags: [],
            notificationIDList: {},
        },
        3: {
            id: 3,
            name: "Paused job",
            type: "http",
            url: "https://job.example.com",
            active: false,
            accepted_statuscodes: ["200-299"],
            tags: [],
            notificationIDList: {},
        },
    };
    const notifications = [
        { id: 1, name: "Ops mail", isDefault: true, active: true },
        { id: 2, name: "Pager", isDefault: false, active: true },
    ];
    const beat = (monitorId, i, status) => ({
        monitorId,
        status,
        time: new Date(Date.UTC(2026, 0, 2, 3, 0, 0) + i * 60000).toISOString().replace("T", " ").replace("Z", ""),
        msg: status === 1 ? "200 - OK" : "timeout",
        ping: 20 + i,
        important: false,
        duration: 60,
        retries: 0,
        hasDetail: false,
    });
    const beats = {
        1: Array.from({ length: 30 }, (_, i) => beat(1, i, 1)),
        2: Array.from({ length: 30 }, (_, i) => beat(2, i, i < 25 ? 1 : 0)),
        3: [],
    };
    let nextId = 10;

    const kuma = {
        added: [],
        edited: [],
        monitors,
        getMonitors: () => Object.values(monitors),
        getBeats: (id) => beats[id] ?? [],
        getLastBeat: (id) => (beats[id] ?? []).at(-1) ?? null,
        getUptime: () => ({ 24: 0.99, 720: 0.98, "1y": 0.97 }),
        getNotifications: () => notifications,
        getMonitor: async (id) => {
            if (!monitors[id]) {
                throw new Error("Monitor not found");
            }
            return structuredClone(monitors[id]);
        },
        getBeatDetail: async () => ({ detail: { v: 1, body: "x".repeat(10000) }, body: "y".repeat(10000) }),
        addMonitor: async (payload) => {
            kuma.added.push(payload);
            const id = nextId++;
            monitors[id] = { ...structuredClone(payload), id };
            return id;
        },
        editMonitor: async (monitor) => {
            kuma.edited.push(structuredClone(monitor));
            monitors[monitor.id] = structuredClone(monitor);
        },
        pauseMonitor: async (id) => {
            monitors[id].active = false;
        },
        resumeMonitor: async (id) => {
            monitors[id].active = true;
        },
        ...overrides,
    };
    return kuma;
}

/**
 * Link an SDK client to a server built by createServer.
 * @param {object} kuma Stub client
 * @param {boolean} writeEnabled Whether write tools are registered
 * @returns {Promise<Client>} Connected client
 */
async function connect(kuma, writeEnabled) {
    const server = createServer({ kuma, writeEnabled });
    const client = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

/**
 * Call a tool and return the raw result plus the parsed JSON text.
 * @param {Client} client MCP client
 * @param {string} name Tool name
 * @param {object} args Tool arguments
 * @returns {Promise<{result: object, data: *}>} Raw result and parsed payload (the message text on errors)
 */
async function call(client, name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    return { result, data: result.isError ? text : JSON.parse(text) };
}

test("read-only mode lists exactly the five read tools", async () => {
    const client = await connect(makeKuma(), false);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), READ_TOOLS);
    for (const tool of tools) {
        assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
        assert.ok(tool.description.length > 40, tool.name);
    }
});

test("write mode lists nine tools", async () => {
    const client = await connect(makeKuma(), true);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
});

test("a write tool is refused in read-only mode", async () => {
    const kuma = makeKuma();
    const client = await connect(kuma, false);
    let failed = false;
    try {
        const result = await client.callTool({ name: "pause_monitor", arguments: { id: 1 } });
        failed = result.isError === true;
    } catch {
        failed = true;
    }
    assert.equal(failed, true);
    assert.equal(kuma.monitors[1].active, true);
});

test("get_monitor masks secrets and returns the newest beats oldest first", async () => {
    const client = await connect(makeKuma(), false);
    const { result, data } = await call(client, "get_monitor", { id: 1, beats: 5 });
    assert.equal(result.content[0].text.includes(SECRET), false);
    assert.equal(data.monitor.basic_auth_pass, "***");
    assert.equal(data.status, "up");
    assert.equal(data.uptime["24"], 0.99);
    assert.equal(data.beats.length, 5);
    assert.equal(data.beats.at(-1).ping, 49);
    assert.ok(data.beats[0].time < data.beats[4].time);

    assert.equal((await call(client, "get_monitor", { id: 1 })).data.beats.length, 20);
    assert.deepEqual((await call(client, "get_monitor", { id: 1, beats: 0 })).data.beats, []);
});

test("list_monitors filters by status and search", async () => {
    const client = await connect(makeKuma(), false);

    const all = (await call(client, "list_monitors")).data;
    assert.equal(all.count, 3);

    const down = (await call(client, "list_monitors", { status: "down" })).data;
    assert.deepEqual(
        down.monitors.map((row) => row.id),
        [2]
    );

    const paused = (await call(client, "list_monitors", { status: "paused" })).data;
    assert.deepEqual(
        paused.monitors.map((row) => row.id),
        [3]
    );

    const byName = (await call(client, "list_monitors", { search: "WEB" })).data;
    assert.deepEqual(
        byName.monitors.map((row) => row.id),
        [1]
    );

    const byTarget = (await call(client, "list_monitors", { search: "192.0.2.10" })).data;
    assert.deepEqual(
        byTarget.monitors.map((row) => row.id),
        [2]
    );
});

test("get_beat_detail truncates the detail body and the body", async () => {
    const client = await connect(makeKuma(), false);
    const { data } = await call(client, "get_beat_detail", { monitorId: 1, time: "2026-01-02 03:04:05.000" });
    assert.ok(data.detail.body.length < 4100);
    assert.ok(data.detail.body.endsWith("... (truncated)"));
    assert.ok(data.body.length < 4100);
    assert.ok(data.body.endsWith("... (truncated)"));
});

test("list_notifications returns id, name, isDefault and active only", async () => {
    const client = await connect(makeKuma(), false);
    const { data } = await call(client, "list_notifications");
    assert.equal(data.notifications.length, 2);
    assert.deepEqual(Object.keys(data.notifications[0]).sort(), ["active", "id", "isDefault", "name"]);
});

test("review_snapshot reports the down monitor", async () => {
    const client = await connect(makeKuma(), false);
    const { data } = await call(client, "review_snapshot", { windowMinutes: 1440 });
    assert.equal(data.windowMinutes, 1440);
    assert.equal(data.totals.total, 3);
    assert.equal(data.totals.down, 1);
    assert.equal(data.quiet, false);
    assert.equal(data.notUp[0].id, 2);
});

test("review_snapshot rejects a window outside 1..1440", async () => {
    const client = await connect(makeKuma(), false);
    const { result } = await call(client, "review_snapshot", { windowMinutes: 5000 });
    assert.equal(result.isError, true);
});

test("add_monitor sends the payload from buildAddPayload and returns the masked monitor", async () => {
    const kuma = makeKuma();
    const client = await connect(kuma, true);
    const args = { type: "http", name: "New site", fields: { url: "https://new.example.com" } };

    const { data } = await call(client, "add_monitor", args);
    const expected = buildAddPayload(
        { type: "http", name: "New site", fields: { url: "https://new.example.com" } },
        kuma.getNotifications()
    );
    assert.deepEqual(kuma.added, [expected]);
    assert.equal(data.monitorId, 10);
    assert.equal(data.monitor.name, "New site");
    assert.equal(data.monitor.id, 10);
});

test("add_monitor with a masked value or unknown key comes back as an error", async () => {
    const kuma = makeKuma();
    const client = await connect(kuma, true);
    const masked = await call(client, "add_monitor", {
        type: "http",
        name: "X",
        fields: { basic_auth_pass: "***" },
    });
    assert.equal(masked.result.isError, true);
    const unknown = await call(client, "add_monitor", { type: "http", name: "X", fields: { nonsense: 1 } });
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.data, /nonsense/);
    assert.equal(kuma.added.length, 0);
});

test("edit_monitor keeps a stored secret when the patch sends the mask, and reports changed", async () => {
    const kuma = makeKuma();
    const client = await connect(kuma, true);
    const { result, data } = await call(client, "edit_monitor", {
        id: 1,
        patch: { basic_auth_pass: "***", interval: 30 },
    });

    assert.equal(kuma.edited.length, 1);
    assert.equal(kuma.edited[0].basic_auth_pass, SECRET);
    assert.equal(kuma.edited[0].interval, 30);
    assert.equal(kuma.edited[0].name, "Web front");
    assert.equal(data.monitorId, 1);
    assert.deepEqual(data.changed.interval, { before: 60, after: 30 });
    assert.equal("basic_auth_pass" in data.changed, false);
    assert.equal(result.content[0].text.includes(SECRET), false);
});

test("edit_monitor with an empty patch and no notificationIds is an error", async () => {
    const kuma = makeKuma();
    const client = await connect(kuma, true);
    const { result } = await call(client, "edit_monitor", { id: 1, patch: {} });
    assert.equal(result.isError, true);
    assert.equal(kuma.edited.length, 0);
});

test("edit_monitor with notificationIds replaces the attached notifications", async () => {
    const kuma = makeKuma();
    const client = await connect(kuma, true);
    const { data } = await call(client, "edit_monitor", { id: 1, notificationIds: [2] });
    assert.deepEqual(kuma.edited[0].notificationIDList, { 2: true });
    assert.ok("notificationIDList" in data.changed);
});

test("pause_monitor and resume_monitor call Kuma and report the state", async () => {
    const kuma = makeKuma();
    const client = await connect(kuma, true);
    assert.deepEqual((await call(client, "pause_monitor", { id: 1 })).data, { monitorId: 1, status: "paused" });
    assert.equal(kuma.monitors[1].active, false);
    assert.deepEqual((await call(client, "resume_monitor", { id: 1 })).data, { monitorId: 1, status: "resumed" });
    assert.equal(kuma.monitors[1].active, true);
});

test("a thrown Kuma error comes back as isError with its message", async () => {
    const client = await connect(makeKuma(), false);
    const { result, data } = await call(client, "get_monitor", { id: 999 });
    assert.equal(result.isError, true);
    assert.equal(data, "Monitor not found");
});
