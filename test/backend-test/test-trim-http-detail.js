process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server", "debug"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { trimHttpDetail } = require("../../server/jobs/trim-http-detail");
const { HTTP_DETAIL_PREFIX } = require("../../server/http-detail");
const { Settings } = require("../../server/settings");
const TestDB = require("../mock-testdb");

const testDb = new TestDB("./data/test-trim-http-detail");

const DETAIL = HTTP_DETAIL_PREFIX + "abc";
const LEGACY = "legacy-body";

/**
 * Insert one heartbeat row.
 * @param {number} monitorID monitor id
 * @param {number} hoursAgo age of the beat in hours
 * @param {number} important 1 for a status change
 * @param {string|null} response stored response value
 * @returns {Promise<void>}
 */
async function addBeat(monitorID, hoursAgo, important, response) {
    const time = dayjs.utc().subtract(hoursAgo, "hour").format("YYYY-MM-DD HH:mm:ss.SSS");
    await R.exec("INSERT INTO heartbeat (monitor_id, status, time, important, response) VALUES (?, 0, ?, ?, ?)", [
        monitorID,
        time,
        important,
        response,
    ]);
}

describe("Trim HTTP details", () => {
    let monitorID;

    before(async () => {
        await testDb.create();
        const bean = R.dispense("monitor");
        bean.name = "trim";
        bean.type = "http";
        bean.url = "http://localhost";
        monitorID = await R.store(bean);

        await addBeat(monitorID, 30, 0, DETAIL); // old, no change: trimmed
        await addBeat(monitorID, 30, 1, DETAIL); // old, status change: kept
        await addBeat(monitorID, 30, 0, LEGACY); // old, stock format: kept
        await addBeat(monitorID, 2, 0, DETAIL); // recent: kept
        await addBeat(monitorID, 2, 1, DETAIL); // recent change: kept
        await trimHttpDetail();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("old beats without a status change lose their details", async () => {
        const rows = await R.getAll(
            "SELECT response FROM heartbeat WHERE monitor_id = ? AND important = 0 AND time < DATETIME('now', '-24 hours') ORDER BY id",
            [monitorID]
        );
        assert.deepStrictEqual(
            rows.map((r) => r.response),
            [null, LEGACY]
        );
    });

    test("old status changes keep their details", async () => {
        const row = await R.getRow(
            "SELECT response FROM heartbeat WHERE monitor_id = ? AND important = 1 AND time < DATETIME('now', '-24 hours')",
            [monitorID]
        );
        assert.strictEqual(row.response, DETAIL);
    });

    test("beats of the last 24 hours keep their details", async () => {
        const rows = await R.getAll(
            "SELECT response FROM heartbeat WHERE monitor_id = ? AND time > DATETIME('now', '-24 hours')",
            [monitorID]
        );
        assert.deepStrictEqual(
            rows.map((r) => r.response),
            [DETAIL, DETAIL]
        );
    });

    test("no heartbeat row is deleted", async () => {
        const count = await R.getCell("SELECT COUNT(*) FROM heartbeat WHERE monitor_id = ?", [monitorID]);
        assert.strictEqual(Number(count), 5);
    });
});
