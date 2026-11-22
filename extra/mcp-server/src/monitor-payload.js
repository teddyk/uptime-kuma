import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MASK, hasMask, maskMonitor } from "./redact.js";

/**
 * Every key the server's editMonitor handler reads from the monitor object (the `monitor.<x>` side of its
 * assignments), without `id`. Derived from server/server.js; keep in step when that handler changes.
 */
export const EDITABLE_FIELDS = Object.freeze([
    "accepted_statuscodes",
    "authDomain",
    "authMethod",
    "authWorkstation",
    "basic_auth_pass",
    "basic_auth_user",
    "bearer_token",
    "body",
    "cacheBust",
    "conditions",
    "databaseConnectionString",
    "databaseQuery",
    "description",
    "dns_resolve_server",
    "dns_resolve_type",
    "docker_container",
    "docker_host",
    "domainExpiryNotification",
    "expectedValue",
    "expiryNotification",
    "forkOptions",
    "game",
    "gamedigGivenPortOnly",
    "gamedigToken",
    "grpcBody",
    "grpcEnableTls",
    "grpcMetadata",
    "grpcMethod",
    "grpcProtobuf",
    "grpcServiceName",
    "grpcUrl",
    "headers",
    "hostname",
    "httpBodyEncoding",
    "ignoreTls",
    "interval",
    "invertKeyword",
    "ipFamily",
    "jsonPath",
    "jsonPathOperator",
    "kafkaProducerAllowAutoTopicCreation",
    "kafkaProducerBrokers",
    "kafkaProducerMessage",
    "kafkaProducerSaslOptions",
    "kafkaProducerSsl",
    "kafkaProducerTopic",
    "keyword",
    "location",
    "manual_status",
    "maxredirects",
    "maxretries",
    "method",
    "mqttCheckType",
    "mqttPassword",
    "mqttSuccessMessage",
    "mqttTopic",
    "mqttUsername",
    "mqttWebsocketPath",
    "name",
    "notificationIDList",
    "ntpRootDispersionThreshold",
    "ntpStratumThreshold",
    "ntpTimeOffsetThreshold",
    "oauth_audience",
    "oauth_auth_method",
    "oauth_client_id",
    "oauth_client_secret",
    "oauth_scopes",
    "oauth_token_url",
    "packetSize",
    "parent",
    "ping_count",
    "ping_numeric",
    "ping_per_request_timeout",
    "port",
    "protocol",
    "proxyId",
    "pushToken",
    "rabbitmqNodes",
    "rabbitmqPassword",
    "rabbitmqUsername",
    "radiusCalledStationId",
    "radiusCallingStationId",
    "radiusPassword",
    "radiusSecret",
    "radiusUsername",
    "remote_browser",
    "resendInterval",
    "responseMaxLength",
    "retryInterval",
    "retryOnlyOnStatusCodeFailure",
    "saveErrorResponse",
    "saveResponse",
    "screenshot_delay",
    "sftpPath",
    "smtpSecurity",
    "snmpOid",
    "snmpVersion",
    "sshAuthMethod",
    "sshPassphrase",
    "sshPassword",
    "sshPrivateKey",
    "sshUsername",
    "subtype",
    "system_service_name",
    "timeout",
    "tlsCa",
    "tlsCert",
    "tlsKey",
    "type",
    "upsideDown",
    "url",
    "wsIgnoreSecWebsocketAcceptHeader",
    "wsSubprotocol",
]);

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Values the web form starts a new monitor with: `monitorDefaults` in src/pages/EditMonitor.vue
 * (without humanReadableInterval, which the server drops) plus what the form's init() adds.
 * @returns {object} Fresh defaults for an http monitor
 */
function baseDefaults() {
    return {
        type: "http",
        name: "",
        parent: null,
        url: "https://",
        wsSubprotocol: "",
        method: "GET",
        protocol: null,
        location: "world",
        ipFamily: null,
        interval: 60,
        retryInterval: 60,
        resendInterval: 0,
        maxretries: 0,
        retryOnlyOnStatusCodeFailure: false,
        notificationIDList: {},
        ignoreTls: false,
        upsideDown: false,
        expiryNotification: false,
        domainExpiryNotification: true,
        maxredirects: 10,
        accepted_statuscodes: ["200-299"],
        saveResponse: false,
        saveErrorResponse: true,
        responseMaxLength: 1024,
        dns_resolve_type: "A",
        dns_resolve_server: "",
        docker_container: "",
        docker_host: null,
        proxyId: null,
        basic_auth_user: "",
        basic_auth_pass: "",
        bearer_token: "",
        mqttUsername: "",
        mqttPassword: "",
        mqttTopic: "",
        mqttWebsocketPath: "",
        mqttSuccessMessage: "",
        mqttCheckType: "keyword",
        authMethod: null,
        oauth_auth_method: "client_secret_basic",
        httpBodyEncoding: "json",
        kafkaProducerBrokers: [],
        kafkaProducerSaslOptions: { mechanism: "None" },
        cacheBust: false,
        kafkaProducerSsl: false,
        kafkaProducerAllowAutoTopicCreation: false,
        gamedigGivenPortOnly: true,
        gamedigToken: "",
        remote_browser: null,
        screenshot_delay: 0,
        rabbitmqNodes: [],
        rabbitmqUsername: "",
        rabbitmqPassword: "",
        conditions: [],
        forkOptions: { checkIps: [], checkDns: false, headerConditions: [] },
        system_service_name: "",
        sshAuthMethod: "password",
        ntpStratumThreshold: 5,
        ntpTimeOffsetThreshold: 1000,
        ntpRootDispersionThreshold: 500,
        ping_count: 3,
        ping_numeric: true,
        packetSize: 56,
        ping_per_request_timeout: 2,
        // The form's type watcher sets these whatever the type is
        snmpVersion: "2c",
        jsonPath: "$",
        jsonPathOperator: "==",
    };
}

/**
 * What the form's `monitor.type` watcher changes when a type is picked on a new monitor.
 * The Icecast, HLS and MPEG-DASH types ("icecast", "hls", "dash") use the http defaults.
 * @param {string} type Monitor type
 * @returns {object} Overrides for the base defaults, including `timeout`
 */
function typeDefaults(type) {
    switch (type) {
        case "websocket-upgrade":
            return { url: "wss://", accepted_statuscodes: ["1000"], timeout: 48 };
        case "dns":
            return { port: 53, dns_resolve_server: "1.1.1.1", timeout: 48 };
        case "radius":
            return { port: 1812, timeout: 48 };
        case "snmp":
            return { port: 161, timeout: 5 };
        case "ntp":
            return { port: 123, interval: 300, retryInterval: 300, timeout: 48 };
        case "sftp":
            return { port: 22, timeout: 48 };
        case "ping":
            return { timeout: 10 };
        case "kafka-producer":
            return { timeout: 1 };
        case "push":
            return {
                pushToken: Array.from(randomBytes(32), (b) => ALPHANUMERIC[b % ALPHANUMERIC.length]).join(""),
                timeout: 48,
            };
        default:
            return { timeout: 48 };
    }
}

/**
 * Throw when accepted_statuscodes is not an array of strings, which the server would reject vaguely.
 * @param {object} monitor Monitor payload
 * @returns {void}
 * @throws {Error} When accepted_statuscodes is missing or holds a non-string
 */
function checkStatusCodes(monitor) {
    const codes = monitor.accepted_statuscodes;
    if (!Array.isArray(codes) || !codes.every((code) => typeof code === "string")) {
        throw new Error('accepted_statuscodes must be an array of strings, for example ["200-299"]');
    }
}

/**
 * Throw when any value carries the mask placeholder.
 * @param {object} values Field name to value
 * @returns {void}
 * @throws {Error} Naming the keys whose value holds MASK
 */
function checkNoMask(values) {
    const masked = Object.keys(values).filter((key) => hasMask(values[key]));
    if (masked.length > 0) {
        throw new Error(`Fields contain the masked placeholder ${MASK}; send the real value: ${masked.join(", ")}`);
    }
}

/**
 * Turn the notification ids a caller gives into the map the server expects.
 * @param {number[]|object} ids Array of ids, or a map of id to true
 * @returns {object} Map of id to true
 */
function toNotificationMap(ids) {
    return Array.isArray(ids) ? Object.fromEntries(ids.map((id) => [id, true])) : { ...ids };
}

/**
 * Build the payload for the `add` event the way the web form does.
 * @param {object} input Input
 * @param {string} input.type Monitor type, for example "http"
 * @param {string} input.name Monitor name
 * @param {object} input.fields Fields that override the defaults
 * @param {number[]|object} input.notificationIds Notification ids to attach; default is every default notification
 * @param {object[]} notifications Notification list from KumaClient.getNotifications
 * @returns {object} Full monitor payload
 * @throws {Error} When fields has an unknown key or a masked value, or accepted_statuscodes is not strings
 */
export function buildAddPayload({ type, name, fields = {}, notificationIds }, notifications) {
    const defaults = { ...baseDefaults(), ...typeDefaults(type) };
    const allowed = new Set([...EDITABLE_FIELDS, ...Object.keys(defaults)]);
    const unknown = Object.keys(fields).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        throw new Error(`Unknown fields: ${unknown.join(", ")}`);
    }
    checkNoMask(fields);

    const payload = { ...defaults, ...structuredClone(fields), type, name };
    // The form links the retry interval to the interval, and clamps a default timeout to 80% of it
    if (fields.interval !== undefined && fields.retryInterval === undefined) {
        payload.retryInterval = payload.interval;
    }
    if (fields.timeout === undefined && type !== "ping") {
        payload.timeout = Math.min(payload.timeout, Math.floor(payload.interval * 8) / 10);
    }
    payload.notificationIDList =
        notificationIds === undefined
            ? Object.fromEntries(notifications.filter((n) => n.isDefault).map((n) => [n.id, true]))
            : toNotificationMap(notificationIds);
    checkStatusCodes(payload);
    return payload;
}

/**
 * Build the full object for the `editMonitor` event: the current monitor with a patch on top.
 * @param {object} current Unmasked monitor from KumaClient.getMonitor
 * @param {object} patch Fields to change
 * @param {number[]|object} notificationIds When given, replaces the attached notifications
 * @returns {object} Full monitor object
 * @throws {Error} When the patch has an unknown key or a half-masked value, or accepted_statuscodes is not strings
 */
export function buildEditPayload(current, patch, notificationIds) {
    const unknown = Object.keys(patch ?? {}).filter((key) => !EDITABLE_FIELDS.includes(key));
    if (unknown.length > 0) {
        throw new Error(`Unknown fields: ${unknown.join(", ")}`);
    }
    // A bare MASK means "keep the stored value", so it is simply not applied
    const changes = Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== MASK));
    checkNoMask(changes);

    const payload = { ...structuredClone(current), ...structuredClone(changes) };
    if (notificationIds !== undefined) {
        payload.notificationIDList = toNotificationMap(notificationIds);
    }
    checkStatusCodes(payload);
    return payload;
}

/**
 * Compare two monitor objects over the editable fields and report the differences in masked form.
 * A change that the masking hides (a new password, say) is flagged with secretChanged.
 * @param {object} before Monitor before the change
 * @param {object} after Monitor after the change
 * @returns {object} Field name to { before, after } for every field that differs
 */
export function diffFields(before, after) {
    const maskedBefore = maskMonitor(before);
    const maskedAfter = maskMonitor(after);
    const changed = {};
    for (const field of EDITABLE_FIELDS) {
        if (isDeepStrictEqual(before[field], after[field])) {
            continue;
        }
        changed[field] = { before: maskedBefore[field], after: maskedAfter[field] };
        if (isDeepStrictEqual(maskedBefore[field], maskedAfter[field])) {
            changed[field].secretChanged = true;
        }
    }
    return changed;
}
