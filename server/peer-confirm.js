const crypto = require("crypto");
const axios = require("axios");
const { R } = require("redbean-node");
const { log, UP, DOWN, PENDING } = require("../src/util");
const { attachPeerResult } = require("./http-detail");
const { parseForkOptions } = require("./fork-options");

/**
 * Monitor types the peer cannot check for us: they depend on state of the main host or the main DB.
 */
const UNSUPPORTED_TYPES = [
    "push",
    "group",
    "manual",
    "docker",
    "pm2",
    "system-service",
    "tailscale-ping",
    "globalping",
    "real-browser",
];

/**
 * Monitor columns that point to rows which only exist in the main DB.
 */
const REFERENCE_FIELDS = ["proxy_id", "docker_host", "remote_browser"];

const DEFAULT_HOLD = 3;

/**
 * Is peer confirmation configured on this (main) instance?
 * @returns {boolean} True if both the peer URL and the token are set
 */
function isEnabled() {
    return Boolean(process.env.UPTIME_KUMA_PEER_URL && process.env.UPTIME_KUMA_PEER_TOKEN);
}

/**
 * Max consecutive beats a failed check is held as PENDING while the peer is unreachable.
 * @returns {number} Hold count
 */
function getHold() {
    const hold = parseInt(process.env.UPTIME_KUMA_PEER_HOLD, 10);
    return Number.isNaN(hold) || hold < 0 ? DEFAULT_HOLD : hold;
}

/**
 * Constant-time check of an Authorization header against the shared token.
 * @param {string|undefined} header Value of the Authorization header
 * @param {string|undefined} token Configured shared secret
 * @returns {boolean} True if the header is "Bearer <token>"
 */
function checkToken(header, token) {
    if (!token || typeof header !== "string" || !header.startsWith("Bearer ")) {
        return false;
    }
    const hash = (value) => crypto.createHash("sha256").update(value).digest();
    return crypto.timingSafeEqual(hash(header.slice("Bearer ".length)), hash(token));
}

/**
 * Can the peer run the check for this raw monitor row?
 * @param {object} row Raw monitor row (snake_case columns)
 * @returns {boolean} True if the peer can run it
 */
function isSupported(row) {
    return (
        Boolean(row) &&
        typeof row.type === "string" &&
        !UNSUPPORTED_TYPES.includes(row.type) &&
        !REFERENCE_FIELDS.some((field) => row[field])
    );
}

/**
 * Pure decision: what happens to a DOWN beat given the peer's answer.
 * @param {object|null} answer Peer response body, or null if the peer was unreachable
 * @param {number} held Consecutive beats already held because the peer was unreachable
 * @param {number} hold Max beats to hold
 * @param {string} msg Message of the failed local check
 * @returns {{status: number, msg: string, held: number}} New beat status, message and hold counter
 */
function decide(answer, held, hold, msg) {
    if (!answer) {
        if (held < hold) {
            return {
                status: PENDING,
                msg: `Local check failed, peer unreachable (hold ${held + 1}/${hold}): ${msg}`,
                held: held + 1,
            };
        }
        return { status: DOWN, msg, held };
    }
    if (answer.ok && answer.status === DOWN) {
        return { status: DOWN, msg: msg + " (peer confirmed)", held: 0 };
    }
    if (answer.ok && answer.status === UP) {
        return { status: PENDING, msg: "Local check failed, peer reports UP: " + msg, held: 0 };
    }
    return { status: DOWN, msg, held: 0 };
}

/**
 * Ask the peer to run the check once.
 * @param {object} row Raw monitor row
 * @param {number} timeout Monitor timeout in seconds
 * @returns {Promise<object|null>} Peer response body, or null if unreachable or invalid
 */
async function askPeer(row, timeout) {
    const base = process.env.UPTIME_KUMA_PEER_URL.replace(/\/+$/, "");
    try {
        const res = await axios.post(
            base + "/api/peer-check",
            { monitor: row },
            {
                headers: { Authorization: "Bearer " + process.env.UPTIME_KUMA_PEER_TOKEN },
                timeout: (timeout + 5) * 1000,
                validateStatus: (status) => status === 200,
            }
        );
        return res.data && typeof res.data.ok === "boolean" ? res.data : null;
    } catch (e) {
        log.warn("peer", `Peer check failed: ${e.message}`);
        return null;
    }
}

/**
 * Apply the peer decision to a DOWN heartbeat bean.
 * @param {import("../server/model/monitor")} monitor Monitor that is about to go DOWN
 * @param {import("redbean-node").Bean} bean DOWN heartbeat, status and msg may be changed
 * @param {number} held Consecutive beats already held because the peer was unreachable
 * @returns {Promise<number>} New hold counter
 */
async function confirmDown(monitor, bean, held) {
    const row = await R.getRow("SELECT * FROM monitor WHERE id = ?", [monitor.id]);
    // The row is read on every call, so the per-monitor opt-out applies without a restart
    if (!isSupported(row) || parseForkOptions(row.fork_options).skipPeer) {
        return held;
    }
    const answer = await askPeer(row, monitor.timeout);
    const result = decide(answer, held, getHold(), bean.msg);
    log.info(
        "peer",
        `Monitor #${monitor.id} '${monitor.name}': peer answer ${JSON.stringify(answer && { ...answer, response: undefined })} -> status ${result.status}`
    );
    bean.status = result.status;
    bean.msg = result.msg;
    if (answer?.ok) {
        // Keep the peer's response next to the local one
        bean.response = await attachPeerResult(bean.response, answer);
    }
    return result.held;
}

module.exports = {
    isEnabled,
    getHold,
    checkToken,
    isSupported,
    decide,
    confirmDown,
};
