const net = require("net");
const dns = require("dns");

const HEADER_OPERATORS = ["exists", "not_exists", "equals", "not_equals", "contains", "not_contains", "regex"];
const MAX_ITEMS = 20;
const MAX_TEXT = 500;

/**
 * Read the fork options of a monitor. Never throws: anything unreadable gives the empty defaults.
 * @param {string|object|null|undefined} raw value of monitor.fork_options, or an already parsed object
 * @returns {{checkIps: string[], checkDns: boolean, skipPeer: boolean, headerConditions: {name: string, operator: string, value: string}[]}} options
 */
function parseForkOptions(raw) {
    let data = raw;
    if (typeof raw === "string") {
        try {
            data = JSON.parse(raw);
        } catch (_) {
            data = null;
        }
    }
    if (!data || typeof data !== "object") {
        return { checkIps: [], checkDns: false, skipPeer: false, headerConditions: [] };
    }
    return {
        checkIps: Array.isArray(data.checkIps) ? data.checkIps.filter((ip) => net.isIP(ip) !== 0) : [],
        checkDns: Boolean(data.checkDns),
        skipPeer: Boolean(data.skipPeer),
        headerConditions: Array.isArray(data.headerConditions)
            ? data.headerConditions.filter((c) => c && c.name && HEADER_OPERATORS.includes(c.operator))
            : [],
    };
}

/**
 * Check the fork options sent by the edit form and return them in the stored shape.
 * @param {object|undefined} input monitor.forkOptions from the client
 * @returns {{checkIps: string[], headerConditions: object[]}} clean options
 * @throws {Error} when an IP or a condition is not valid
 */
function validateForkOptions(input) {
    if (input === undefined || input === null) {
        return { checkIps: [], checkDns: false, skipPeer: false, headerConditions: [] };
    }
    if (typeof input !== "object") {
        throw new Error("Invalid fork options");
    }

    const checkIps = [];
    for (const item of Array.isArray(input.checkIps) ? input.checkIps : []) {
        const ip = String(item).trim();
        if (!ip) {
            continue;
        }
        if (net.isIP(ip) === 0) {
            throw new Error(`Not a valid IP address: ${ip}`);
        }
        if (!checkIps.includes(ip)) {
            checkIps.push(ip);
        }
    }

    const headerConditions = [];
    for (const item of Array.isArray(input.headerConditions) ? input.headerConditions : []) {
        const name = String(item?.name ?? "")
            .trim()
            .toLowerCase();
        if (!name) {
            continue;
        }
        const operator = item.operator;
        const valueless = operator === "exists" || operator === "not_exists";
        const value = valueless ? "" : String(item.value ?? "");
        if (!HEADER_OPERATORS.includes(operator)) {
            throw new Error(`Unknown header condition operator: ${operator}`);
        }
        if (name.length > MAX_TEXT || value.length > MAX_TEXT) {
            throw new Error(`Header condition for ${name} is too long`);
        }
        if (operator === "regex") {
            try {
                new RegExp(value, "i");
            } catch (e) {
                throw new Error(`Invalid regular expression for header ${name}: ${e.message}`);
            }
        }
        headerConditions.push({ name, operator, value });
    }

    if (checkIps.length > MAX_ITEMS || headerConditions.length > MAX_ITEMS) {
        throw new Error(`At most ${MAX_ITEMS} IPs and ${MAX_ITEMS} header conditions are allowed`);
    }
    return { checkIps, checkDns: Boolean(input.checkDns), skipPeer: Boolean(input.skipPeer), headerConditions };
}

/**
 * Addresses one check goes to. An empty string stands for normal DNS resolution of the hostname.
 * @param {{checkIps: string[], checkDns: boolean}} options fork options
 * @returns {string[]} one entry per request; an empty list means a single normal request
 */
function ipTargets(options) {
    if (options.checkIps.length === 0) {
        return [];
    }
    return [...(options.checkDns ? [""] : []), ...options.checkIps];
}

/**
 * Check the response headers against the header conditions. All conditions must pass.
 * Names and values are compared without regard to case.
 * @param {object} headers response headers
 * @param {{name: string, operator: string, value: string}[]} conditions header conditions
 * @returns {void}
 * @throws {Error} naming the first condition that does not pass
 */
function checkHeaderConditions(headers, conditions) {
    if (!conditions.length) {
        return;
    }
    const lower = {};
    for (const [key, value] of Object.entries(headers || {})) {
        lower[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }

    for (const { name, operator, value } of conditions) {
        const actual = lower[name.toLowerCase()];
        const present = actual !== undefined;
        const a = (actual ?? "").toLowerCase();
        const v = value.toLowerCase();
        let pass;
        switch (operator) {
            case "exists":
                pass = present;
                break;
            case "not_exists":
                pass = !present;
                break;
            case "equals":
                pass = present && a === v;
                break;
            case "not_equals":
                pass = a !== v;
                break;
            case "contains":
                pass = present && a.includes(v);
                break;
            case "not_contains":
                pass = !a.includes(v);
                break;
            case "regex":
                pass = present && new RegExp(value, "i").test(actual);
                break;
            default:
                pass = false;
        }
        if (!pass) {
            const got = present ? `got "${actual}"` : "header is missing";
            const expected = value === "" ? operator : `${operator} "${value}"`;
            throw new Error(`Header condition failed: ${name} ${expected} (${got})`);
        }
    }
}

/**
 * Build a DNS lookup function that sends one hostname to a fixed IP and resolves every other name normally.
 * The request keeps the hostname as Host header and TLS server name.
 * @param {string} hostname hostname of the monitor URL
 * @param {string} ip address to connect to
 * @returns {Function} lookup function for http(s).Agent options
 */
function pinnedLookup(hostname, ip) {
    const family = net.isIP(ip);
    return (name, options, callback) => {
        if (typeof options === "function") {
            callback = options;
            options = {};
        }
        if (name !== hostname) {
            return dns.lookup(name, options, callback);
        }
        if (options?.all) {
            callback(null, [{ address: ip, family }]);
        } else {
            callback(null, ip, family);
        }
    };
}

module.exports = {
    HEADER_OPERATORS,
    parseForkOptions,
    validateForkOptions,
    ipTargets,
    checkHeaderConditions,
    pinnedLookup,
};
