const { describe, test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { Notification } = require("../../server/notification");
const batcher = require("../../server/notification-batcher");
const { UP, DOWN } = require("../../src/util");

const ENV = "UPTIME_KUMA_NOTIFICATION_GROUP_WINDOW";

/**
 * Build a fake notification bean
 * @param {number} id Notification id
 * @returns {object} Bean-like object
 */
function bean(id) {
    return { id, name: `n${id}`, config: JSON.stringify({ id, type: "smtp" }) };
}

/**
 * Build a fake heartbeat JSON
 * @param {number} status Heartbeat status
 * @returns {object} Heartbeat JSON
 */
function hb(status) {
    return { status };
}

describe("NotificationBatcher", () => {
    let send;

    beforeEach(() => {
        mock.timers.enable({ apis: ["setTimeout"] });
        send = mock.method(Notification, "send", async () => {});
        process.env[ENV] = "10";
    });

    afterEach(async () => {
        mock.timers.reset();
        mock.restoreAll();
        batcher.buffers.clear();
        delete process.env[ENV];
    });

    test("feature off sends immediately", async () => {
        for (const value of [undefined, "0", "abc", "-5"]) {
            if (value === undefined) {
                delete process.env[ENV];
            } else {
                process.env[ENV] = value;
            }
            send.mock.resetCalls();
            const m = { name: "m" };
            const h = hb(DOWN);
            await batcher.enqueue(bean(1), "msg", m, h);
            assert.equal(send.mock.callCount(), 1, `value ${value}`);
            assert.deepEqual(send.mock.calls[0].arguments, [{ id: 1, type: "smtp" }, "msg", m, h]);
            assert.equal(batcher.buffers.size, 0);
        }
    });

    test("single item in window is sent unchanged", async () => {
        const m = { name: "m" };
        const h = hb(DOWN);
        await batcher.enqueue(bean(1), "[m] down", m, h);
        assert.equal(send.mock.callCount(), 0);

        mock.timers.tick(10000);
        await batcher.flushAll();
        assert.equal(send.mock.callCount(), 1);
        const args = send.mock.calls[0].arguments;
        assert.deepEqual(args, [{ id: 1, type: "smtp" }, "[m] down", m, h]);
        assert.equal(args[2], m);
        assert.equal(args[3], h);
    });

    test("multiple items for the same id become one combined message", async () => {
        await batcher.enqueue(bean(1), "[a] down", { name: "a" }, hb(DOWN));
        mock.timers.tick(9000);
        // the window is fixed, a later item does not extend it
        await batcher.enqueue(bean(1), "[b] down", { name: "b" }, hb(DOWN));
        await batcher.enqueue(bean(1), "[c] up", { name: "c" }, hb(UP));
        assert.equal(send.mock.callCount(), 0);

        mock.timers.tick(1000);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(send.mock.callCount(), 1);
        assert.deepEqual(send.mock.calls[0].arguments, [
            { id: 1, type: "smtp" },
            "3 alerts (2 Down, 1 Up)\n[a] down\n[b] down\n[c] up",
            null,
            null,
        ]);
        assert.equal(batcher.buffers.size, 0);
    });

    test("different notification ids flush separately", async () => {
        await batcher.enqueue(bean(1), "[a] down", {}, hb(DOWN));
        await batcher.enqueue(bean(2), "[b] down", {}, hb(DOWN));
        await batcher.enqueue(bean(1), "[c] down", {}, hb(DOWN));
        await batcher.flushAll();

        assert.equal(send.mock.callCount(), 2);
        const byId = Object.fromEntries(send.mock.calls.map((c) => [c.arguments[0].id, c.arguments]));
        assert.equal(byId[1][1], "2 alerts (2 Down)\n[a] down\n[c] down");
        assert.equal(byId[1][2], null);
        assert.equal(byId[2][1], "[b] down");
        assert.deepEqual(byId[2][2], {});
    });

    test("flushAll sends pending immediately", async () => {
        await batcher.enqueue(bean(1), "[a] down", {}, hb(DOWN));
        await batcher.enqueue(bean(2), "[b] up", {}, hb(UP));
        assert.equal(send.mock.callCount(), 0);

        await batcher.flushAll();
        assert.equal(send.mock.callCount(), 2);
        assert.equal(batcher.buffers.size, 0);

        // the cleared timers must not send again
        mock.timers.tick(20000);
        assert.equal(send.mock.callCount(), 2);
    });

    test("a throwing send does not prevent the others", async () => {
        mock.restoreAll();
        send = mock.method(Notification, "send", async (config) => {
            if (config.id === 1) {
                throw new Error("boom");
            }
        });
        await batcher.enqueue(bean(1), "[a] down", {}, hb(DOWN));
        await batcher.enqueue(bean(2), "[b] down", {}, hb(DOWN));
        await batcher.flushAll();

        assert.equal(send.mock.callCount(), 2);
        assert.deepEqual(
            send.mock.calls.map((c) => c.arguments[0].id).sort(),
            [1, 2]
        );
    });
});
