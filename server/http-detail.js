const net = require("node:net");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { RESPONSE_BODY_LENGTH_DEFAULT } = require("../src/util");

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * Marker at the start of a stored value that holds an HTTP detail object.
 * It lets sync code tell a detail row from a legacy plain-body row without decompressing.
 */
const HTTP_DETAIL_PREFIX = "kd1:";

const SENSITIVE_HEADERS = /authorization|cookie|token|secret|password|api-?key|signature/i;

/**
 * Copy headers to a plain object with lowercase names, string values and sensitive values masked.
 * @param {object} headers Headers object (axios or node)
 * @returns {object} Sanitized headers
 */
function sanitizeHeaders(headers) {
    const result = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null || typeof value === "function") {
            continue;
        }
        const key = name.toLowerCase();
        if (SENSITIVE_HEADERS.test(key)) {
            result[key] = "***";
        } else if (Array.isArray(value)) {
            result[key] = value.join(", ");
        } else if (typeof value === "object") {
            continue;
        } else {
            result[key] = String(value);
        }
    }
    return result;
}

/**
 * Remove user and password from a URL string.
 * @param {string} url URL
 * @returns {string} URL without credentials
 */
function stripUrlCredentials(url) {
    try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        return parsed.toString();
    } catch (e) {
        return url;
    }
}

/**
 * Get the node ClientRequest behind an axios request. Axios wraps it in a follow-redirects
 * object on errors, whose current request is the last one that was sent.
 * @param {object} request axios `request` value
 * @returns {object|undefined} Node ClientRequest
 */
function getClientRequest(request) {
    return request?._currentRequest || request;
}

/**
 * Build a plain object that describes the HTTP request and its response or failure.
 * @param {object} options Options
 * @param {object} options.response Axios response (success), or the response of a monitor check that failed afterwards
 * @param {object} options.error Axios error. May carry `error.response`, or only `error.request`, `error.code`, `error.address` and `error.port`
 * @param {number} options.maxBodyLength Maximum characters of the body to keep
 * @returns {object} HTTP detail
 */
function buildHttpDetail({ response, error, maxBodyLength = RESPONSE_BODY_LENGTH_DEFAULT }) {
    const res = response || error?.response || null;
    const config = res?.config || error?.config;
    const req = getClientRequest(res?.request || error?.request);
    const socket = req?.socket;

    // The socket can already be destroyed, so fall back to what trackPeerAddress recorded
    const peer = socket ? peers.get(socket) : undefined;
    const ip = socket?.remoteAddress || peer?.address || error?.address || null;
    const port = socket?.remotePort || peer?.port || error?.port || null;

    let requestHeaders = {};
    let url = config?.url || null;
    let method = config?.method;
    if (typeof req?.getHeaders === "function") {
        requestHeaders = sanitizeHeaders(req.getHeaders());
        if (req.path && requestHeaders.host && req.protocol) {
            url = `${req.protocol}//${requestHeaders.host}${req.path}`;
        }
        method = req.method || method;
    } else {
        requestHeaders = sanitizeHeaders(config?.headers);
    }

    let body = null;
    if (res && res.data !== undefined && res.data !== null) {
        body = res.data;
        if (typeof body !== "string") {
            try {
                body = JSON.stringify(body);
            } catch (e) {
                body = String(body);
            }
        }
        if (body.length > maxBodyLength) {
            body = body.substring(0, maxBodyLength) + "... (truncated)";
        }
    }

    return {
        v: 1,
        ip,
        port,
        request: {
            method: method ? String(method).toUpperCase() : null,
            url: url ? stripUrlCredentials(url) : null,
            headers: requestHeaders,
        },
        response: res
            ? {
                  status: res.status,
                  statusText: res.statusText,
                  headers: sanitizeHeaders(res.headers),
              }
            : null,
        body,
        error: error ? { code: error.code ?? null, message: error.message } : null,
    };
}

/**
 * Peer address of sockets created by tracked agents. A monitor's non-keepalive socket is
 * already destroyed when the detail is built, and then no longer knows its peer.
 * @type {WeakMap<object, {address: string|null, port: number|null}>}
 */
const peers = new WeakMap();

/**
 * Record the peer address of every socket an agent creates.
 * @param {object} agent http or https Agent
 * @returns {void}
 */
function trackPeerAddress(agent) {
    const createConnection = agent.createConnection;
    agent.createConnection = function (options, ...rest) {
        const socket = createConnection.call(this, options, ...rest);
        if (socket?.once) {
            const peer = {
                address: net.isIP(options?.host || "") ? options.host : null,
                port: Number(options?.port) || null,
            };
            peers.set(socket, peer);
            // Fallback for platforms where the connected socket does not report its peer
            socket.once("lookup", (err, address) => {
                if (!err && address && !peer.address) {
                    peer.address = address;
                }
            });
            socket.once("connect", () => {
                if (socket.remoteAddress) {
                    peer.address = socket.remoteAddress;
                    peer.port = socket.remotePort;
                }
            });
        }
        return socket;
    };
}

/**
 * Check whether a stored heartbeat response value holds an HTTP detail object. Sync and cheap.
 * @param {string|null} value Stored value of heartbeat.response
 * @returns {boolean} True if the value was written by encodeHttpDetail
 */
function isHttpDetailValue(value) {
    return typeof value === "string" && value.startsWith(HTTP_DETAIL_PREFIX);
}

/**
 * Compress an HTTP detail object for storage in heartbeat.response.
 * @param {object} detail Result of buildHttpDetail
 * @returns {Promise<string>} Prefix + base64 of the brotli compressed JSON
 */
async function encodeHttpDetail(detail) {
    // Offload brotli compression from main event loop to libuv thread pool
    const compressed = await brotliCompress(Buffer.from(JSON.stringify(detail), "utf8"));
    return HTTP_DETAIL_PREFIX + compressed.toString("base64");
}

/**
 * Decode a stored heartbeat.response value.
 * @param {string|null} value Stored value of heartbeat.response
 * @returns {Promise<object|null>} The detail object, or null for empty, legacy plain-body or undecodable values
 */
async function decodeHttpDetail(value) {
    if (!value || typeof value !== "string") {
        return null;
    }

    try {
        const encoded = value.startsWith(HTTP_DETAIL_PREFIX) ? value.substring(HTTP_DETAIL_PREFIX.length) : value;
        const text = (await brotliDecompress(Buffer.from(encoded, "base64"))).toString("utf8");
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && parsed.v === 1 && parsed.request) {
            return parsed;
        }
    } catch (e) {
        // Legacy plain body, or not valid JSON
    }
    return null;
}

/**
 * Format an HTTP detail object as plain text for alerts.
 * @param {object} detail Result of buildHttpDetail
 * @param {object} options Options
 * @param {number} options.maxBody Maximum characters of the body
 * @returns {string} Text block
 */
function formatHttpDetailText(detail, { maxBody = 2000 } = {}) {
    const lines = [];
    const formatHeaders = (headers) => Object.entries(headers || {}).map(([k, v]) => `  ${k}: ${v}`);

    lines.push(`Request: ${detail.request?.method ?? ""} ${detail.request?.url ?? ""}`.trimEnd());

    if (detail.ip) {
        const host = detail.ip.includes(":") ? `[${detail.ip}]` : detail.ip;
        lines.push(`Sent to: ${host}${detail.port ? ":" + detail.port : ""}`);
    } else {
        lines.push("Sent to: unknown");
    }

    const requestHeaders = formatHeaders(detail.request?.headers);
    if (requestHeaders.length > 0) {
        lines.push("Request headers:", ...requestHeaders);
    }

    if (detail.response) {
        lines.push(`Response: ${detail.response.status} ${detail.response.statusText ?? ""}`.trimEnd());
        const responseHeaders = formatHeaders(detail.response.headers);
        if (responseHeaders.length > 0) {
            lines.push("Response headers:", ...responseHeaders);
        }
    } else {
        const reason = [detail.error?.code, detail.error?.message].filter(Boolean).join(" ");
        lines.push(`No response: ${reason}`.trimEnd());
    }

    if (detail.body) {
        const body = detail.body.length > maxBody ? detail.body.substring(0, maxBody) + "... (truncated)" : detail.body;
        lines.push("Body:", body);
    }

    if (detail.peer) {
        const ping = detail.peer.ping ? ` (${detail.peer.ping} ms)` : "";
        lines.push("", `Peer check: ${detail.peer.status === 1 ? "UP" : "DOWN"} - ${detail.peer.msg ?? ""}${ping}`);
        if (detail.peer.detail) {
            lines.push(formatHttpDetailText(detail.peer.detail, { maxBody }));
        }
    }

    return lines.join("\n");
}

/**
 * Add the peer's result to a stored HTTP detail, so one heartbeat keeps both responses.
 * @param {string|null} value Stored value of heartbeat.response for the local check
 * @param {{status: number, msg: string, ping: number, response: string}} answer Peer response body
 * @returns {Promise<string|null>} New value for heartbeat.response. Unchanged when the local check stored no detail.
 */
async function attachPeerResult(value, answer) {
    const detail = await decodeHttpDetail(value);
    if (!detail) {
        return value;
    }
    const peerDetail = await decodeHttpDetail(answer.response);
    if (peerDetail) {
        delete peerDetail.peer;
    }
    detail.peer = {
        status: answer.status,
        msg: answer.msg,
        ping: answer.ping ?? null,
        detail: peerDetail,
    };
    return await encodeHttpDetail(detail);
}

module.exports = {
    HTTP_DETAIL_PREFIX,
    buildHttpDetail,
    encodeHttpDetail,
    decodeHttpDetail,
    isHttpDetailValue,
    trackPeerAddress,
    formatHttpDetailText,
    attachPeerResult,
};
