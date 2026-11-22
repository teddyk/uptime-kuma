const { MonitorType } = require("./monitor-type");
const { UP } = require("../../src/util");
const { StreamCheck, stripQuery } = require("./stream-check");

/**
 * Minimum staleness window in seconds for a live manifest
 */
const MIN_STALE_SECONDS = 30;

/**
 * Decode the XML entities that matter in manifests
 * @param {string} text Text with entities
 * @returns {string} Decoded text
 */
function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity) => {
        switch (entity) {
            case "amp":
                return "&";
            case "lt":
                return "<";
            case "gt":
                return ">";
            case "quot":
                return '"';
            case "apos":
                return "'";
            default: {
                const code = entity[1] === "x" ? parseInt(entity.substring(2), 16) : parseInt(entity.substring(1), 10);
                try {
                    return String.fromCodePoint(code);
                } catch {
                    return match;
                }
            }
        }
    });
}

/**
 * Minimal tolerant XML reader, enough for MPD manifests. It builds an element tree with local
 * element names (namespace prefixes are dropped), attributes and the text of each element.
 * Comments, CDATA, processing instructions and DOCTYPE are skipped, mismatched end tags are ignored.
 * It does not validate, resolve namespaces or handle DTD entities.
 * @param {string} xml XML text
 * @returns {{name: string, attrs: object, children: object[], text: string}} Document node, its children are the root elements
 */
function parseXml(xml) {
    const document = { name: "#document", attrs: {}, children: [], text: "" };
    const stack = [document];
    const tokenPattern =
        /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>/]+))*)\s*(\/?)>/g;
    const attrPattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

    let lastIndex = 0;
    let match;
    while ((match = tokenPattern.exec(xml)) !== null) {
        const top = stack[stack.length - 1];
        top.text += decodeEntities(xml.substring(lastIndex, match.index));
        lastIndex = tokenPattern.lastIndex;

        if (match[1] !== undefined) {
            top.text += match[1];
        } else if (match[3] !== undefined) {
            const name = match[3].replace(/^.*:/, "");
            if (match[2] === "/") {
                for (let i = stack.length - 1; i > 0; i--) {
                    if (stack[i].name === name) {
                        stack.length = i;
                        break;
                    }
                }
            } else {
                const node = { name, attrs: {}, children: [], text: "" };
                let attr;
                attrPattern.lastIndex = 0;
                while ((attr = attrPattern.exec(match[4])) !== null) {
                    node.attrs[attr[1]] = decodeEntities(attr[2] ?? attr[3] ?? attr[4]);
                }
                top.children.push(node);
                if (match[5] !== "/") {
                    stack.push(node);
                }
            }
        }
    }
    return document;
}

/**
 * @param {object} node XML node
 * @param {string} name Element name
 * @returns {object[]} Direct children with that name
 */
function children(node, name) {
    return node.children.filter((child) => child.name === name);
}

/**
 * @param {object} node XML node
 * @param {string} name Element name
 * @returns {object|undefined} First direct child with that name
 */
function child(node, name) {
    return node.children.find((candidate) => candidate.name === name);
}

/**
 * Substitute DASH template identifiers, including %0Nd width formatting and $$ escapes.
 * @param {string} template Template string such as "seg-$RepresentationID$-$Number%05d$.m4s"
 * @param {object} values Identifier values (RepresentationID, Bandwidth, Number, Time)
 * @returns {string} Filled template, unknown identifiers stay untouched
 */
function fillTemplate(template, values) {
    return template.replace(
        /\$(?:\$|(RepresentationID|Number|Bandwidth|Time|SubNumber)(?:%0(\d+)d)?\$)/g,
        (match, identifier, width) => {
            if (!identifier) {
                return "$";
            }
            if (values[identifier] === undefined) {
                return match;
            }
            const value = String(values[identifier]);
            return width ? value.padStart(Number(width), "0") : value;
        }
    );
}

/**
 * Find the newest segment described by a SegmentTimeline.
 * A negative repeat count (repeat until the end of the Period) is treated as no repeat.
 * @param {object} timeline SegmentTimeline node
 * @param {number} startNumber Number of the first segment
 * @returns {{time: number, number: number, duration: number}|null} Start time, number and duration (timescale units) of the newest segment
 */
function newestInTimeline(timeline, startNumber) {
    let newest = null;
    let nextTime = 0;
    let count = 0;
    for (const segment of children(timeline, "S")) {
        const duration = Number(segment.attrs.d);
        if (!(duration > 0)) {
            continue;
        }
        const start = segment.attrs.t !== undefined ? Number(segment.attrs.t) : nextTime;
        const repeat = Math.max(0, parseInt(segment.attrs.r ?? "0", 10) || 0);
        count += repeat + 1;
        newest = { time: start + repeat * duration, number: startNumber + count - 1, duration };
        nextTime = start + (repeat + 1) * duration;
    }
    return newest;
}

/**
 * @param {string} word Singular word
 * @param {number} count Count
 * @returns {string} "1 word" or "N words"
 */
function plural(word, count) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * @param {string} url Absolute URL
 * @returns {boolean} True when the last path segment looks like a file name (has an extension)
 */
function looksLikeFile(url) {
    return /\.[A-Za-z0-9]{1,5}$/.test(new URL(url).pathname);
}

class DashMonitorType extends MonitorType {
    name = "dash";

    /**
     * Returns the current time in ms, replaceable in tests
     * @type {Function}
     */
    now = () => Date.now();

    /**
     * Staleness state of live manifests by monitor id
     * @type {Map<number, {key: string, since: number}>}
     */
    state = new Map();

    /**
     * Checks an MPEG-DASH manifest: it must parse and have a Representation, the init segment and the
     * newest media segment of the first video Representation are fetched, and for live manifests with a
     * SegmentTimeline the newest segment must keep advancing.
     *
     * Limits: the MPD is read by a small tolerant reader. Only the first Period is looked at. Segment
     * addressing is supported for SegmentTemplate ($RepresentationID$, $Bandwidth$, $Number$, $Time$ with
     * %0Nd widths, with or without SegmentTimeline). SegmentBase and SegmentList manifests are
     * validated and, when a BaseURL names a file, that file is fetched. Negative S@r values count as 0.
     * Number-based templates of dynamic manifests have no media segment fetch, because the live edge
     * depends on the clock. The query string of the MPD URL is not passed on to segment URLs.
     * publishTime, availabilityStartTime and minimumUpdatePeriod are not evaluated, and
     * ContentProtection is ignored.
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const check = new StreamCheck(monitor);
        try {
            const manifest = await check.fetchText("manifest", monitor.url);
            heartbeat.ping = manifest.ms;
            const shownUrl = stripQuery(monitor.url);

            const mpd = parseXml(manifest.text).children.find((node) => node.name === "MPD");
            if (!mpd) {
                throw new Error(`manifest ${shownUrl} has no MPD root element`);
            }
            const dynamic = mpd.attrs.type === "dynamic";

            const period = child(mpd, "Period");
            if (!period) {
                throw new Error(`manifest ${shownUrl} has no Period`);
            }
            const adaptationSets = children(period, "AdaptationSet");
            const withRepresentations = adaptationSets.filter((set) => children(set, "Representation").length > 0);
            if (withRepresentations.length === 0) {
                throw new Error(`manifest ${shownUrl} has no Representation`);
            }
            const representationCount = adaptationSets.reduce(
                (sum, set) => sum + children(set, "Representation").length,
                0
            );

            const isVideo = (set) =>
                set.attrs.contentType === "video" ||
                /^video\//.test(set.attrs.mimeType || "") ||
                children(set, "Representation").some((rep) => /^video\//.test(rep.attrs.mimeType || ""));
            const adaptationSet = withRepresentations.find(isVideo) || withRepresentations[0];
            const representation = children(adaptationSet, "Representation")[0];
            const levels = [mpd, period, adaptationSet, representation];

            // BaseURL chain, each level is relative to the one above and the first level to the MPD URL
            let baseUrl = manifest.url;
            let hasBaseUrl = false;
            try {
                for (const level of levels) {
                    const baseElement = child(level, "BaseURL");
                    if (baseElement && baseElement.text.trim()) {
                        baseUrl = new URL(baseElement.text.trim(), baseUrl).href;
                        hasBaseUrl = true;
                    }
                }
            } catch {
                throw new Error(`manifest ${shownUrl} has an invalid BaseURL`);
            }

            // SegmentTemplate attributes are inherited from Period, AdaptationSet and Representation
            const templates = [period, adaptationSet, representation]
                .map((level) => child(level, "SegmentTemplate"))
                .filter(Boolean);

            const parts = [
                dynamic ? "dynamic" : "static",
                plural("adaptation set", adaptationSets.length),
                plural("representation", representationCount),
            ];

            if (templates.length === 0) {
                if (hasBaseUrl && looksLikeFile(baseUrl)) {
                    const media = await check.probe("media file", baseUrl);
                    parts.push(`media file ${media.status}`);
                } else {
                    parts.push("no SegmentTemplate, manifest only");
                }
                heartbeat.msg = parts.join(", ");
                heartbeat.status = UP;
                this.state.delete(monitor.id);
                return;
            }

            const template = Object.assign({}, ...templates.map((node) => node.attrs));
            const timeline = templates
                .map((node) => child(node, "SegmentTimeline"))
                .filter(Boolean)
                .pop();
            const startNumber = template.startNumber !== undefined ? parseInt(template.startNumber, 10) : 1;
            const values = { RepresentationID: representation.attrs.id, Bandwidth: representation.attrs.bandwidth };

            // Probes start only after the staleness check, a throw before would leave them unhandled
            const probes = [];
            if (template.initialization) {
                const url = new URL(fillTemplate(template.initialization, values), baseUrl).href;
                probes.push(() => check.probe("init segment", url).then((result) => `init ${result.status}`));
            } else {
                parts.push("no init segment");
            }

            // Which media segment to fetch
            let mediaUrl = null;
            let mediaLabel = "";
            let staleKey = null;
            let staleLimit = null;
            if (template.media && timeline) {
                const newest = newestInTimeline(timeline, startNumber);
                if (!newest) {
                    throw new Error(`manifest ${shownUrl} has a SegmentTimeline without segments`);
                }
                mediaUrl = new URL(
                    fillTemplate(template.media, { ...values, Number: newest.number, Time: newest.time }),
                    baseUrl
                ).href;
                mediaLabel = /\$Time[$%]/.test(template.media) ? `t=${newest.time}` : `n=${newest.number}`;
                staleKey = `${newest.time}:${newest.number}`;
                const timescale = Number(template.timescale) > 0 ? Number(template.timescale) : 1;
                staleLimit = Math.max((3 * newest.duration) / timescale, MIN_STALE_SECONDS);
            } else if (template.media && template.duration && !dynamic && !/\$Time[$%]/.test(template.media)) {
                mediaUrl = new URL(fillTemplate(template.media, { ...values, Number: startNumber }), baseUrl).href;
                mediaLabel = `n=${startNumber}`;
            } else if (template.media) {
                parts.push(
                    dynamic && !timeline
                        ? "media segment skipped (dynamic manifest without SegmentTimeline)"
                        : "media segment skipped (no SegmentTimeline or duration)"
                );
            }

            if (mediaUrl) {
                probes.push(() =>
                    check
                        .probe("newest segment", mediaUrl)
                        .then((result) => `newest segment ${result.status} (${mediaLabel})`)
                );
            }

            // Staleness first, a manifest that stopped advancing is the more useful reason
            if (dynamic && staleKey !== null) {
                this.checkStale(monitor, staleKey, staleLimit);
            } else {
                this.state.delete(monitor.id);
            }

            const results = await Promise.all(probes.map((start) => start()));
            heartbeat.msg = parts.concat(results).join(", ");
            heartbeat.status = UP;
        } finally {
            check.close();
        }
    }

    /**
     * Fail when the newest segment of a live manifest did not change for too long.
     * Monitors without id are skipped.
     * @param {object} monitor Monitor
     * @param {string} key Identifies the newest segment
     * @param {number} limit Allowed unchanged time in seconds
     * @returns {void}
     * @throws {Error} When the manifest is stale
     */
    checkStale(monitor, key, limit) {
        if (!monitor.id) {
            return;
        }
        const now = this.now();
        const previous = this.state.get(monitor.id);
        if (!previous || previous.key !== key) {
            this.state.set(monitor.id, { key, since: now });
            return;
        }
        const unchangedFor = (now - previous.since) / 1000;
        if (unchangedFor > limit) {
            throw new Error(`manifest stale: newest segment unchanged for ${Math.round(unchangedFor)}s`);
        }
    }
}

module.exports = {
    DashMonitorType,
    parseXml,
    fillTemplate,
};
