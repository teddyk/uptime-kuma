const { Notification } = require("./notification");
const { log, UP, DOWN } = require("../src/util");

/**
 * Groups alerts that hit the same notification config within a fixed time window
 * into one combined message. Enabled by UPTIME_KUMA_NOTIFICATION_GROUP_WINDOW (seconds).
 * Unset, 0 or invalid sends every alert immediately, as upstream does.
 */
class NotificationBatcher {
    /**
     * Pending items per notification id
     * @type {Map<number, {bean: object, items: object[], timer: NodeJS.Timeout}>}
     */
    buffers = new Map();

    /**
     * Get the window length in milliseconds, 0 when the feature is off
     * @returns {number} Window in ms
     */
    getWindowMs() {
        const seconds = Number(process.env.UPTIME_KUMA_NOTIFICATION_GROUP_WINDOW);
        return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    }

    /**
     * Send now, or buffer for the notification's window. Never throws.
     * @param {object} notificationBean Notification bean (id, name, config)
     * @param {string} msg Alert message
     * @param {object} monitorJSON Monitor JSON
     * @param {object} heartbeatJSON Heartbeat JSON
     * @returns {Promise<void>}
     */
    async enqueue(notificationBean, msg, monitorJSON, heartbeatJSON) {
        const windowMs = this.getWindowMs();
        if (windowMs === 0) {
            await this.sendSafe(notificationBean, msg, monitorJSON, heartbeatJSON);
            return;
        }

        let buffer = this.buffers.get(notificationBean.id);
        if (!buffer) {
            buffer = { bean: notificationBean, items: [], timer: null };
            buffer.timer = setTimeout(() => this.flush(notificationBean.id), windowMs);
            // A pending timer must not keep the process alive, shutdown calls flushAll()
            buffer.timer.unref?.();
            this.buffers.set(notificationBean.id, buffer);
        }
        buffer.items.push({ msg, monitorJSON, heartbeatJSON });
    }

    /**
     * Send the pending items of one notification id
     * @param {number} id Notification id
     * @returns {Promise<void>}
     */
    async flush(id) {
        const buffer = this.buffers.get(id);
        if (!buffer) {
            return;
        }
        this.buffers.delete(id);
        clearTimeout(buffer.timer);

        const { bean, items } = buffer;
        if (items.length === 1) {
            await this.sendSafe(bean, items[0].msg, items[0].monitorJSON, items[0].heartbeatJSON);
            return;
        }

        const down = items.filter((i) => i.heartbeatJSON?.status === DOWN).length;
        const up = items.filter((i) => i.heartbeatJSON?.status === UP).length;
        const counts = [];
        if (down > 0) {
            counts.push(`${down} Down`);
        }
        if (up > 0) {
            counts.push(`${up} Up`);
        }
        const header = `${items.length} alerts` + (counts.length > 0 ? ` (${counts.join(", ")})` : "");
        const combined = [header, ...items.map((i) => i.msg)].join("\n");
        await this.sendSafe(bean, combined, null, null);
    }

    /**
     * Send everything pending immediately
     * @returns {Promise<void>}
     */
    async flushAll() {
        await Promise.all([...this.buffers.keys()].map((id) => this.flush(id)));
    }

    /**
     * Send one notification, log errors like the upstream loop
     * @param {object} bean Notification bean
     * @param {string} msg Message
     * @param {object} monitorJSON Monitor JSON or null
     * @param {object} heartbeatJSON Heartbeat JSON or null
     * @returns {Promise<void>}
     */
    async sendSafe(bean, msg, monitorJSON, heartbeatJSON) {
        try {
            await Notification.send(JSON.parse(bean.config), msg, monitorJSON, heartbeatJSON);
        } catch (e) {
            log.error("monitor", "Cannot send notification to " + bean.name);
            log.error("monitor", e);
        }
    }
}

module.exports = new NotificationBatcher();
