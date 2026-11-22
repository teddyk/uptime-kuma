export const MASK = "***";

const SECRET_FIELDS = [
    "basic_auth_pass",
    "bearer_token",
    "oauth_client_secret",
    "gamedigToken",
    "pushToken",
    "databaseConnectionString",
    "radiusPassword",
    "radiusSecret",
    "mqttPassword",
    "tlsKey",
    "rabbitmqPassword",
    "sshPassword",
    "sshPrivateKey",
    "sshPassphrase",
    "body",
    "grpcBody",
];
const JSON_HEADER_FIELDS = ["headers", "grpcMetadata"];
const SASL_SECRET_FIELDS = ["password", "secretAccessKey", "sessionToken"];
const DROPPED_FIELDS = ["screenshot", "includeSensitiveData"];
const SENSITIVE_HEADER_NAME = /authorization|cookie|token|secret|password|api-?key|signature/i;
const SENSITIVE_QUERY_NAME = /token|secret|password|passwd|api[-_]?key|signature|^(key|sig|auth)$/i;
const TRUNCATED_SUFFIX = "... (truncated)";

/**
 * Empty values stay visible, so a reader can tell "no password set" from "password hidden".
 * @param {any} value Field value
 * @returns {boolean} True when there is something to hide
 */
function isFilled(value) {
    return value !== "" && value !== null && value !== undefined;
}

/**
 * Mask the values of a headers-style JSON string whose names look sensitive.
 * @param {string} text JSON object as a string, name to value
 * @returns {string} Re-serialized JSON, or MASK when the text is not a JSON object
 */
function maskHeaderJson(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (_) {
        return MASK;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return MASK;
    }
    for (const [name, value] of Object.entries(parsed)) {
        if (SENSITIVE_HEADER_NAME.test(name) && isFilled(value)) {
            parsed[name] = MASK;
        }
    }
    return JSON.stringify(parsed, null, 4);
}

/**
 * Mask the password and the sensitive query values of a URL. A URL without either comes back untouched.
 * @param {any} url URL string; anything else passes through
 * @returns {any} The URL with secrets replaced by MASK
 */
export function maskUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (_) {
        return url;
    }
    let masked = false;
    if (parsed.password) {
        parsed.password = MASK;
        masked = true;
    }
    for (const name of new Set(parsed.searchParams.keys())) {
        if (SENSITIVE_QUERY_NAME.test(name) && parsed.searchParams.get(name)) {
            parsed.searchParams.set(name, MASK);
            masked = true;
        }
    }
    return masked ? parsed.toString() : url;
}

/**
 * Copy a monitor object with every secret replaced by MASK, so it is safe to show to a model.
 * @param {object} monitor Raw monitor object
 * @returns {object} Masked deep copy; the input is not changed
 */
export function maskMonitor(monitor) {
    const copy = structuredClone(monitor);
    for (const field of SECRET_FIELDS) {
        if (isFilled(copy[field])) {
            copy[field] = MASK;
        }
    }
    for (const field of JSON_HEADER_FIELDS) {
        if (isFilled(copy[field])) {
            copy[field] = maskHeaderJson(copy[field]);
        }
    }
    if (isFilled(copy.url)) {
        copy.url = maskUrl(copy.url);
    }
    const sasl = copy.kafkaProducerSaslOptions;
    if (sasl && typeof sasl === "object") {
        for (const field of SASL_SECRET_FIELDS) {
            if (isFilled(sasl[field])) {
                sasl[field] = MASK;
            }
        }
    }
    for (const field of DROPPED_FIELDS) {
        delete copy[field];
    }
    return copy;
}

/**
 * Tell whether a value carries a masked placeholder, which must never be written back as a real value.
 * @param {any} value String, or an object or array that may hold strings
 * @returns {boolean} True when MASK appears in the string or in any string nested in the value
 */
export function hasMask(value) {
    if (typeof value === "string") {
        return value.includes(MASK);
    }
    if (value && typeof value === "object") {
        return Object.values(value).some(hasMask);
    }
    return false;
}

/**
 * Cap a body string.
 * @param {any} body Body value
 * @param {number} maxBody Maximum characters to keep
 * @returns {any} The same value, or the capped string with a marker
 */
function capBody(body, maxBody) {
    if (typeof body === "string" && body.length > maxBody) {
        return body.slice(0, maxBody) + TRUNCATED_SUFFIX;
    }
    return body;
}

/**
 * Copy an HTTP detail with long bodies capped, so one beat cannot flood a model's context.
 * @param {object} detail Detail as returned by getBeatDetail
 * @param {number} maxBody Maximum characters of each body
 * @returns {object} Capped deep copy; null and undefined pass through
 */
export function truncateDetail(detail, maxBody = 4000) {
    if (!detail) {
        return detail;
    }
    const copy = structuredClone(detail);
    for (const target of [copy, copy.peer?.detail]) {
        if (target && "body" in target) {
            target.body = capBody(target.body, maxBody);
        }
    }
    return copy;
}
