process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server", "debug"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const Monitor = require("../../server/model/monitor");
const { Settings } = require("../../server/settings");
const TestDB = require("../mock-testdb");

const testDb = new TestDB("./data/test-monitor-group-pause");

describe("Monitors under a paused group", () => {
    let userID;

    /**
     * Store a monitor row.
     * @param {string} name monitor name
     * @param {string} type monitor type
     * @param {boolean} active the monitor's own active value
     * @param {number|null} parent id of the parent group
     * @returns {Promise<number>} id of the stored monitor
     */
    async function storeMonitor(name, type, active, parent = null) {
        const bean = R.dispense("monitor");
        bean.name = name;
        bean.type = type;
        bean.active = active;
        bean.parent = parent;
        bean.user_id = userID;
        bean.interval = 60;
        await R.store(bean);
        return bean.id;
    }

    /**
     * Names of the monitors a server start would run.
     * @returns {Promise<string[]>} sorted names
     */
    async function runnableNames() {
        return (await Monitor.getRunnableList()).map((monitor) => monitor.name).sort();
    }

    before(async () => {
        await testDb.create();

        const user = R.dispense("user");
        user.username = "group-pause-test";
        user.password = "group-pause-test";
        user.active = true;
        await R.store(user);
        userID = user.id;

        await storeMonitor("top-level", "http", true);

        const pausedGroup = await storeMonitor("paused-group", "group", false);
        await storeMonitor("child-of-paused", "http", true, pausedGroup);
        const nestedGroup = await storeMonitor("nested-group", "group", true, pausedGroup);
        await storeMonitor("grandchild-of-paused", "http", true, nestedGroup);

        const activeGroup = await storeMonitor("active-group", "group", true);
        await storeMonitor("child-of-active", "http", true, activeGroup);
        await storeMonitor("paused-child-of-active", "http", false, activeGroup);
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    test("getRunnableList() leaves out monitors with a paused group at any level above them", async () => {
        assert.deepStrictEqual(await runnableNames(), ["active-group", "child-of-active", "top-level"]);
    });

    test("getRunnableList() keeps the children's own active value, so resuming the group brings them back", async () => {
        const child = await R.getRow("SELECT active FROM monitor WHERE name = ?", ["child-of-paused"]);
        assert.strictEqual(child.active, 1);

        await R.exec("UPDATE monitor SET active = 1 WHERE name = ?", ["paused-group"]);

        assert.deepStrictEqual(await runnableNames(), [
            "active-group",
            "child-of-active",
            "child-of-paused",
            "grandchild-of-paused",
            "nested-group",
            "paused-group",
            "top-level",
        ]);
    });
});
