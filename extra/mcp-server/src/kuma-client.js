import { io } from "socket.io-client";

/** Socket events this client may send. Nothing else (delete, settings, notification changes) can leave it. */
export const ALLOWED_EVENTS = Object.freeze([
    "login",
    "loginByToken",
    "getMonitor",
    "getHeartbeatDetail",
    "add",
    "editMonitor",
    "pauseMonitor",
    "resumeMonitor",
]);

const MAX_BEATS = 100;

/**
 * Convert a raw database row from the pushed `heartbeatList` into the normalized beat.
 * The compressed `response` blob is dropped on purpose.
 * @param {number|string} monitorId Monitor id the list was pushed for
 * @param {object} row Raw snake_case row
 * @returns {object} Normalized beat
 */
function normalizeRow(monitorId, row) {
    return {
        monitorId: Number(row.monitor_id ?? monitorId),
        status: row.status,
        time: row.time,
        msg: row.msg,
        ping: row.ping,
        important: Boolean(row.important),
        duration: row.duration,
        retries: row.retries,
        hasDetail: typeof row.response === "string" && row.response.startsWith("kd1:"),
    };
}

/**
 * Convert a live `heartbeat` event (camelCase toJSON shape) into the normalized beat.
 * @param {object} beat Live heartbeat object
 * @returns {object} Normalized beat
 */
function normalizeLive(beat) {
    return {
        monitorId: Number(beat.monitorID),
        status: beat.status,
        time: beat.time,
        msg: beat.msg,
        ping: beat.ping,
        important: Boolean(beat.important),
        duration: beat.duration,
        retries: beat.retries,
        hasDetail: Boolean(beat.hasDetail),
    };
}

/** Socket.io client for an Uptime Kuma server. It keeps the pushed monitor, beat and uptime caches up to date. */
export class KumaClient {
    #url;
    #username;
    #password;
    #jwt;
    #timeoutMs;
    #socket = null;
    #monitors = {};
    #notifications = [];
    #beats = new Map();
    #uptime = new Map();

    /**
     * Create a client. Nothing connects until `connect()` is called.
     * @param {object} options Options
     * @param {string} options.url Base URL of the Kuma server
     * @param {string} options.username Login name, used when no jwt is given
     * @param {string} options.password Login password, used when no jwt is given
     * @param {string} options.jwt Login token; takes precedence over username and password
     * @param {number} options.timeoutMs Milliseconds to wait for a connection or an answer
     */
    constructor({ url, username, password, jwt, timeoutMs = 15000 }) {
        this.#url = url;
        this.#username = username;
        this.#password = password;
        this.#jwt = jwt;
        this.#timeoutMs = timeoutMs;
    }

    /**
     * Connect and log in. Resolves when the login callback said ok, which Kuma sends after all post-login pushes.
     * Only the first attempt decides the result: later reconnects log in again silently.
     * @returns {Promise<void>} Resolves when the caches are filled
     */
    async connect() {
        const socket = io(this.#url, { timeout: this.#timeoutMs });
        this.#socket = socket;
        this.#listen(socket);

        await new Promise((resolve, reject) => {
            let first = true;
            const fail = (error) => {
                if (first) {
                    first = false;
                    this.close();
                    reject(error);
                }
            };
            socket.on("connect_error", (error) => fail(new Error(`Cannot connect to ${this.#url}: ${error.message}`)));
            // A reconnected socket is anonymous, so every connect logs in again
            socket.on("connect", async () => {
                try {
                    await this.#login();
                    if (first) {
                        first = false;
                        resolve();
                    }
                } catch (error) {
                    fail(error);
                }
            });
        });
    }

    /**
     * Close the socket for good (no reconnect).
     * @returns {void}
     */
    close() {
        this.#socket?.close();
    }

    /**
     * All monitors of the pushed list, unmasked.
     * @returns {object[]} Raw monitor objects
     */
    getMonitors() {
        return Object.values(this.#monitors);
    }

    /**
     * Cached beats of a monitor.
     * @param {number} monitorId Monitor id
     * @returns {object[]} Normalized beats, oldest first, at most 100
     */
    getBeats(monitorId) {
        return [...(this.#beats.get(Number(monitorId)) ?? [])];
    }

    /**
     * Newest cached beat of a monitor.
     * @param {number} monitorId Monitor id
     * @returns {object|null} Normalized beat or null
     */
    getLastBeat(monitorId) {
        return this.#beats.get(Number(monitorId))?.at(-1) ?? null;
    }

    /**
     * Uptime values that arrived for a monitor.
     * @param {number} monitorId Monitor id
     * @returns {object} Map of period ("24", "720", "1y") to value; empty when nothing arrived
     */
    getUptime(monitorId) {
        return { ...this.#uptime.get(Number(monitorId)) };
    }

    /**
     * Notification channels, reduced to what is safe to show. The config JSON holds secrets and is never kept.
     * @returns {object[]} List of id, name, isDefault and active
     */
    getNotifications() {
        return this.#notifications.map((n) => ({
            id: n.id,
            name: n.name,
            isDefault: Boolean(n.isDefault),
            active: Boolean(n.active),
        }));
    }

    /**
     * Fetch the full monitor object, as the edit form gets it.
     * @param {number} id Monitor id
     * @returns {Promise<object>} Raw monitor object, unmasked
     */
    async getMonitor(id) {
        try {
            return (await this._emit("getMonitor", id)).monitor;
        } catch (error) {
            // Kuma answers an unknown id with the TypeError text of its failed lookup
            if (/reading 'id'/.test(error.message)) {
                throw new Error(`Monitor ${id} not found`);
            }
            throw error;
        }
    }

    /**
     * Fetch the stored HTTP detail of a heartbeat.
     * @param {number} monitorId Monitor id
     * @param {string} time Beat time exactly as the beat carries it
     * @returns {Promise<{detail: (object|null), body: (string|null)}>} The detail or, for legacy rows, the body
     */
    async getBeatDetail(monitorId, time) {
        const res = await this._emit("getHeartbeatDetail", monitorId, time);
        return { detail: res.detail, body: res.body };
    }

    /**
     * Add a monitor.
     * @param {object} payload Full monitor payload, as built by buildAddPayload
     * @returns {Promise<number>} Id of the new monitor
     */
    async addMonitor(payload) {
        return (await this._emit("add", payload)).monitorID;
    }

    /**
     * Save a monitor. The server assigns every field, so the object must be complete.
     * @param {object} monitor Full monitor object, as built by buildEditPayload
     * @returns {Promise<void>} Resolves when saved
     */
    async editMonitor(monitor) {
        await this._emit("editMonitor", monitor);
    }

    /**
     * Pause a monitor.
     * @param {number} id Monitor id
     * @returns {Promise<void>} Resolves when paused
     */
    async pauseMonitor(id) {
        await this._emit("pauseMonitor", id);
    }

    /**
     * Resume a monitor.
     * @param {number} id Monitor id
     * @returns {Promise<void>} Resolves when resumed
     */
    async resumeMonitor(id) {
        await this._emit("resumeMonitor", id);
    }

    /**
     * The only way out for socket events. Refuses events outside ALLOWED_EVENTS.
     * Underscore, not `#`, so the test can prove a refused event never reaches the server.
     * @param {string} event Event name
     * @param {...any} args Event arguments, without the callback
     * @returns {Promise<object>} The server answer when it said ok
     * @private
     */
    async _emit(event, ...args) {
        if (!ALLOWED_EVENTS.includes(event)) {
            throw new Error(`Event not allowed: ${event}`);
        }
        if (!this.#socket) {
            throw new Error("Not connected");
        }
        let res;
        try {
            res = await this.#socket.timeout(this.#timeoutMs).emitWithAck(event, ...args);
        } catch (_) {
            throw new Error(`${event} timed out after ${this.#timeoutMs} ms`);
        }
        if (res?.tokenRequired) {
            throw new Error("Two-factor authentication is on for this account: set KUMA_JWT instead of a password");
        }
        if (!res?.ok) {
            throw new Error(res?.msg ?? `${event} failed`);
        }
        return res;
    }

    /**
     * Log in with the token when there is one, else with username and password.
     * @returns {Promise<void>} Resolves when the server said ok
     */
    async #login() {
        if (this.#jwt) {
            await this._emit("loginByToken", this.#jwt);
        } else {
            await this._emit("login", { username: this.#username, password: this.#password });
        }
    }

    /**
     * Register the handlers for the lists and events Kuma pushes.
     * @param {object} socket socket.io client socket
     * @returns {void}
     */
    #listen(socket) {
        socket.on("monitorList", (list) => {
            this.#monitors = { ...list };
        });
        socket.on("updateMonitorIntoList", (list) => {
            for (const [id, monitor] of Object.entries(list)) {
                this.#monitors[id] = Object.assign(this.#monitors[id] ?? {}, monitor);
            }
        });
        socket.on("deleteMonitorFromList", (id) => {
            delete this.#monitors[id];
        });
        socket.on("notificationList", (list) => {
            this.#notifications = list;
        });
        socket.on("heartbeatList", (monitorId, rows) => {
            this.#beats.set(
                Number(monitorId),
                rows.slice(-MAX_BEATS).map((row) => normalizeRow(monitorId, row))
            );
        });
        socket.on("heartbeat", (beat) => {
            const beats = this.#beats.get(Number(beat.monitorID)) ?? [];
            beats.push(normalizeLive(beat));
            this.#beats.set(Number(beat.monitorID), beats.slice(-MAX_BEATS));
        });
        socket.on("uptime", (monitorId, period, value) => {
            const id = Number(monitorId);
            this.#uptime.set(id, { ...this.#uptime.get(id), [String(period)]: value });
        });
    }
}
