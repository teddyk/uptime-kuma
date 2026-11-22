const { checkLogin } = require("../util-server");
const { UptimeCalculator } = require("../uptime-calculator");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const Heartbeat = require("../model/heartbeat");
const { decodeHttpDetail } = require("../http-detail");

module.exports.chartSocketHandler = (socket) => {
    socket.on("getMonitorChartData", async (monitorID, period, callback) => {
        try {
            checkLogin(socket);

            log.debug("monitor", `Get Monitor Chart Data: ${monitorID} User ID: ${socket.userID}`);

            if (period == null) {
                throw new Error("Invalid period.");
            }

            let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);

            let data;
            if (period <= 24) {
                data = uptimeCalculator.getDataArray(period * 60, "minute");
            } else if (period <= 720) {
                data = uptimeCalculator.getDataArray(period, "hour");
            } else {
                data = uptimeCalculator.getDataArray(period / 24, "day");
            }

            callback({
                ok: true,
                data,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getHeartbeatDetail", async (monitorID, time, callback) => {
        try {
            checkLogin(socket);

            const row = await R.getRow(
                `
                SELECT heartbeat.response
                FROM heartbeat
                JOIN monitor ON monitor.id = heartbeat.monitor_id
                WHERE heartbeat.monitor_id = ?
                  AND heartbeat.time = ?
                  AND monitor.user_id = ?
            `,
                [monitorID, time, socket.userID]
            );

            if (!row) {
                throw new Error("Heartbeat not found.");
            }

            const detail = await decodeHttpDetail(row.response);
            callback({
                ok: true,
                detail,
                // Legacy rows hold the plain response body only
                body: detail ? null : await Heartbeat.decodeResponseValue(row.response),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
