const { R } = require("redbean-node");
const { log } = require("../../src/util");
const Database = require("../database");
const { HTTP_DETAIL_PREFIX } = require("../http-detail");

/**
 * Drops the stored HTTP details of heartbeats older than 24 hours, except on status changes.
 * Every beat keeps its details for a day. After that only the important beats keep them.
 * @returns {Promise<void>}
 */
const trimHttpDetail = async () => {
    try {
        await R.exec(
            "UPDATE heartbeat SET response = NULL WHERE important = 0 AND response LIKE ? AND time < " +
                Database.sqlHourOffset(),
            [HTTP_DETAIL_PREFIX + "%", -24]
        );
        log.debug("trimHttpDetail", "HTTP details trimmed.");
    } catch (e) {
        log.error("trimHttpDetail", `Failed to trim HTTP details: ${e.message}`);
    }
};

module.exports = {
    trimHttpDetail,
};
