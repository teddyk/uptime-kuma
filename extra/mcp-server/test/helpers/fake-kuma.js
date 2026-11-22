import { createServer } from "node:http";
import { Server } from "socket.io";

const NOT_LOGGED_IN = { ok: false, msg: "You are not logged in." };
const ROOM = "user";
const GREETING_DELAY_MS = 50;

/**
 * Start a socket.io server that mimics the parts of Uptime Kuma this package talks to.
 * @param {object} options Options
 * @param {string} options.username Accepted login name
 * @param {string} options.password Accepted login password
 * @param {string} options.jwt Accepted login token
 * @param {object} options.monitors Monitor id to monitor object, as Kuma pushes them
 * @param {object} options.beats Monitor id to raw heartbeat rows; missing columns are filled in
 * @param {object[]} options.notifications Notification list items, each with id, name, active, isDefault
 * @param {object} options.details Key "<monitorId>|<time>" to `{ detail, body }` for getHeartbeatDetail
 * @param {boolean} options.twoFA Answer a login without a token with tokenRequired
 * @returns {Promise<{url: string, close: Function, io: object, calls: object[]}>} The running fake
 */
export async function startFakeKuma({
    username = "admin",
    password = "secret",
    jwt = "test-jwt",
    monitors = {},
    beats = {},
    notifications = [],
    details = {},
    twoFA = false,
} = {}) {
    const state = structuredClone(monitors);
    let nextId = Math.max(0, ...Object.keys(state).map(Number)) + 1;
    const calls = [];
    const httpServer = createServer();
    const io = new Server(httpServer);

    /**
     * Push everything Kuma pushes after a login, then the caller answers the login.
     * @param {object} socket Server side socket
     * @returns {void}
     */
    function afterLogin(socket) {
        socket.data.loggedIn = true;
        socket.join(ROOM);
        socket.emit("info", { primaryBaseURL: null, version: "fake" });
        socket.emit("monitorList", structuredClone(state));
        socket.emit(
            "notificationList",
            notifications.map((n) => ({ ...n, config: JSON.stringify({ secretToken: "do-not-leak" }) }))
        );
        for (const id of Object.keys(state)) {
            const rows = (beats[id] ?? []).map((row, index) => ({
                id: index + 1,
                important: 0,
                monitor_id: Number(id),
                msg: "",
                ping: null,
                duration: 0,
                down_count: 0,
                retries: 0,
                response: "compressed-blob",
                ...row,
            }));
            socket.emit("heartbeatList", Number(id), rows, false);
            socket.emit("uptime", Number(id), 24, 1);
            socket.emit("uptime", Number(id), 720, 0.995);
            socket.emit("uptime", Number(id), "1y", 0.99);
        }
    }

    /**
     * Wrap a handler so it answers `not logged in` for anonymous sockets and turns throws into ok:false.
     * @param {object} socket Server side socket
     * @param {Function} handler Handler that returns the answer object
     * @returns {Function} Event listener
     */
    function guarded(socket, handler) {
        return (...args) => {
            const callback = args.pop();
            if (!socket.data.loggedIn) {
                callback(NOT_LOGGED_IN);
                return;
            }
            try {
                callback(handler(...args));
            } catch (error) {
                callback({ ok: false, msg: error.message });
            }
        };
    }

    /**
     * Send one monitor to the user's sockets, as Kuma does before it answers.
     * @param {number} id Monitor id
     * @returns {void}
     */
    function pushUpdate(id) {
        io.to(ROOM).emit("updateMonitorIntoList", { [id]: structuredClone(state[id]) });
    }

    io.on("connection", async (socket) => {
        socket.onAny((event, ...args) => {
            calls.push({ event, args: args.filter((arg) => typeof arg !== "function") });
        });

        // Kuma reads settings before it greets with `info`, and registers its handlers only after that.
        // An event that arrives earlier is lost, so a client must wait for the greeting.
        await new Promise((resolve) => setTimeout(resolve, GREETING_DELAY_MS));
        socket.emit("info", { primaryBaseURL: null });

        socket.on("login", (data, callback) => {
            if (twoFA && !data.token) {
                callback({ tokenRequired: true });
            } else if (data.username === username && data.password === password) {
                afterLogin(socket);
                callback({ ok: true, token: jwt });
            } else {
                callback({ ok: false, msg: "authIncorrectCreds", msgi18n: true });
            }
        });

        socket.on("loginByToken", (token, callback) => {
            if (token === jwt) {
                afterLogin(socket);
                callback({ ok: true });
            } else {
                callback({ ok: false, msg: "authInvalidToken", msgi18n: true });
            }
        });

        socket.on(
            "add",
            guarded(socket, (monitor) => {
                if (!monitor.accepted_statuscodes.every((code) => typeof code === "string")) {
                    throw new Error("Accepted status codes are not all strings");
                }
                const id = nextId++;
                state[id] = { ...structuredClone(monitor), id, active: true };
                pushUpdate(id);
                return { ok: true, msg: "successAdded", monitorID: id };
            })
        );

        socket.on(
            "editMonitor",
            guarded(socket, (monitor) => {
                if (!state[monitor.id]) {
                    throw new Error("Monitor not found");
                }
                state[monitor.id] = { ...structuredClone(monitor), active: state[monitor.id].active };
                pushUpdate(monitor.id);
                return { ok: true, msg: "Saved.", monitorID: monitor.id };
            })
        );

        socket.on(
            "getMonitor",
            guarded(socket, (id) => {
                if (!state[id]) {
                    throw new Error("Monitor not found");
                }
                return { ok: true, monitor: structuredClone(state[id]) };
            })
        );

        for (const [event, active] of [
            ["pauseMonitor", false],
            ["resumeMonitor", true],
        ]) {
            socket.on(
                event,
                guarded(socket, (id) => {
                    if (!state[id]) {
                        throw new Error("Monitor not found");
                    }
                    state[id].active = active;
                    pushUpdate(id);
                    return { ok: true };
                })
            );
        }

        socket.on(
            "getHeartbeatDetail",
            guarded(socket, (monitorId, time) => {
                const entry = details[`${monitorId}|${time}`];
                if (!entry) {
                    throw new Error("Heartbeat not found.");
                }
                return { ok: true, detail: null, body: null, ...entry };
            })
        );
    });

    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address();

    return {
        url: `http://127.0.0.1:${port}`,
        io,
        calls,
        close: () => new Promise((resolve) => io.close(resolve)),
    };
}
