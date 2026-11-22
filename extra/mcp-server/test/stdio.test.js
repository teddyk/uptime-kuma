import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeKuma } from "./helpers/fake-kuma.js";

const INDEX = fileURLToPath(new URL("../index.js", import.meta.url));
const READ_TOOLS = ["get_beat_detail", "get_monitor", "list_monitors", "list_notifications", "review_snapshot"];
const WRITE_TOOLS = ["add_monitor", "edit_monitor", "pause_monitor", "resume_monitor"];
const MONITORS = {
    1: {
        id: 1,
        name: "Site",
        type: "http",
        url: "https://example.com/?token=abc",
        active: true,
        basic_auth_pass: "clear-pass",
        accepted_statuscodes: ["200-299"],
    },
};
const BEATS = { 1: [{ status: 1, time: "2026-01-02 03:04:05.000", msg: "200 - OK", ping: 12 }] };

const cleanups = [];
afterEach(async () => {
    while (cleanups.length > 0) {
        await cleanups.pop()();
    }
});

/**
 * Start a fake Kuma and the real server process, and connect an MCP client to it over stdio.
 * @param {object} env Extra environment variables for the server process
 * @returns {Promise<{client: Client, fake: object}>} Connected client and the fake
 */
async function start(env = {}) {
    const fake = await startFakeKuma({ monitors: MONITORS, beats: BEATS });
    cleanups.push(() => fake.close());
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [INDEX],
        env: { ...process.env, KUMA_URL: fake.url, KUMA_USERNAME: "admin", KUMA_PASSWORD: "secret", ...env },
        stderr: "ignore",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    cleanups.push(() => client.close());
    await client.connect(transport);
    return { client, fake };
}

/**
 * Call a tool and parse its JSON text result.
 * @param {Client} client Connected MCP client
 * @param {string} name Tool name
 * @param {object} args Tool arguments
 * @returns {Promise<object>} Parsed result
 */
async function call(client, name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
}

describe("server process over stdio", () => {
    it("offers only the read tools by default and serves data from Kuma", async () => {
        const { client, fake } = await start({ KUMA_MCP_WRITE: "" });
        const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
        assert.deepEqual(names, READ_TOOLS);

        const list = await call(client, "list_monitors");
        assert.equal(list.count, 1);
        assert.equal(list.monitors[0].status, "up");
        assert.equal(list.monitors[0].target, "https://example.com/?token=***");

        const detail = await call(client, "get_monitor", { id: 1 });
        assert.equal(detail.monitor.basic_auth_pass, "***");
        assert.equal(detail.beats.length, 1);

        const refused = await client.callTool({ name: "pause_monitor", arguments: { id: 1 } });
        assert.ok(refused.isError);
        assert.ok(fake.calls.every((c) => c.event !== "pauseMonitor"));
    });

    it("adds the write tools when KUMA_MCP_WRITE is 1", async () => {
        const { client, fake } = await start({ KUMA_MCP_WRITE: "1" });
        const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
        assert.deepEqual(names, [...READ_TOOLS, ...WRITE_TOOLS].sort());

        const added = await call(client, "add_monitor", {
            type: "http",
            name: "New",
            fields: { url: "https://example.org/health" },
        });
        assert.equal(added.monitor.name, "New");
        assert.equal(fake.calls.filter((c) => c.event === "add").length, 1);

        await call(client, "pause_monitor", { id: added.monitorId });
        const paused = await call(client, "list_monitors", { status: "paused" });
        assert.deepEqual(
            paused.monitors.map((m) => m.id),
            [added.monitorId]
        );
    });

    it("does not start with a wrong password", async () => {
        await assert.rejects(start({ KUMA_PASSWORD: "wrong" }));
    });
});
