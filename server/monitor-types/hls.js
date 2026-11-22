const { MonitorType } = require("./monitor-type");
const { UP } = require("../../src/util");
const { StreamCheck, stripQuery } = require("./stream-check");

/**
 * Maximum number of variant playlists fetched from a master playlist
 */
const MAX_VARIANTS = 12;

/**
 * Minimum staleness window in seconds for a live playlist
 */
const MIN_STALE_SECONDS = 30;

/**
 * Parse an HLS playlist. Master and media playlists are both handled, tags that are not needed are ignored.
 * @param {string} text Playlist text
 * @returns {{isMaster: boolean, variants: string[], segments: string[], mapUri: (string|null), targetDuration: (number|null), mediaSequence: number, endList: boolean}} Parsed playlist, URIs as written
 * @throws {Error} When the text does not start with #EXTM3U
 */
function parsePlaylist(text) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");

    if (lines.length === 0 || !lines[0].startsWith("#EXTM3U")) {
        throw new Error("does not start with #EXTM3U");
    }

    const playlist = {
        isMaster: false,
        variants: [],
        segments: [],
        mapUri: null,
        targetDuration: null,
        mediaSequence: 0,
        endList: false,
    };

    let expectVariantUri = false;
    for (const line of lines) {
        if (line.startsWith("#")) {
            if (line.startsWith("#EXT-X-STREAM-INF")) {
                playlist.isMaster = true;
                expectVariantUri = true;
            } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
                playlist.targetDuration = parseFloat(line.substring(22));
            } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
                playlist.mediaSequence = parseInt(line.substring(22), 10) || 0;
            } else if (line.startsWith("#EXT-X-ENDLIST")) {
                playlist.endList = true;
            } else if (line.startsWith("#EXT-X-MAP:")) {
                const match = line.match(/URI="([^"]*)"/);
                if (match) {
                    playlist.mapUri = match[1];
                }
            }
        } else if (expectVariantUri) {
            playlist.variants.push(line);
            expectVariantUri = false;
        } else {
            playlist.segments.push(line);
        }
    }

    return playlist;
}

class HLSMonitorType extends MonitorType {
    name = "hls";

    /**
     * Returns the current time in ms, replaceable in tests
     * @type {Function}
     */
    now = () => Date.now();

    /**
     * Staleness state of live playlists by monitor id
     * @type {Map<number, {mediaSequence: number, lastSegment: string, since: number}>}
     */
    state = new Map();

    /**
     * Checks an HLS playlist: master and variant playlists, the newest segment and the init segment
     * of the first variant, and for live streams that the playlist keeps advancing.
     *
     * Limits: only the first variant is checked for staleness and segment fetch, audio-only
     * renditions from EXT-X-MEDIA and I-frame playlists are not fetched, EXT-X-KEY keys are never
     * fetched and EXT-X-BYTERANGE is ignored.
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const check = new StreamCheck(monitor);
        try {
            const first = await check.fetchText("playlist", monitor.url);
            heartbeat.ping = first.ms;

            let playlist;
            try {
                playlist = parsePlaylist(first.text);
            } catch (error) {
                throw new Error(`playlist ${stripQuery(monitor.url)} ${error.message}`);
            }

            let primary = playlist;
            let primaryUrl = first.url;
            let variantsLabel = "media playlist";

            if (playlist.isMaster) {
                const variantUrls = [];
                for (const uri of playlist.variants) {
                    const resolved = resolveUrl(uri, first.url);
                    if (!variantUrls.includes(resolved)) {
                        variantUrls.push(resolved);
                    }
                }
                if (variantUrls.length === 0) {
                    throw new Error(`playlist ${stripQuery(monitor.url)} lists no variant URIs`);
                }
                const fetchedUrls = variantUrls.slice(0, MAX_VARIANTS);
                variantsLabel =
                    variantUrls.length > fetchedUrls.length
                        ? `${fetchedUrls.length} of ${variantUrls.length} variants`
                        : `${fetchedUrls.length} variant${fetchedUrls.length === 1 ? "" : "s"}`;

                const results = await Promise.all(
                    fetchedUrls.map(async (url) => {
                        const fetched = await check.fetchText("variant playlist", url);
                        let parsed;
                        try {
                            parsed = parsePlaylist(fetched.text);
                        } catch (error) {
                            throw new Error(`variant playlist ${stripQuery(url)} ${error.message}`);
                        }
                        if (parsed.isMaster) {
                            throw new Error(
                                `variant playlist ${stripQuery(url)} is a master playlist, not a media playlist`
                            );
                        }
                        if (parsed.segments.length === 0) {
                            throw new Error(`variant playlist ${stripQuery(url)} contains no segments`);
                        }
                        return { parsed, url: fetched.url };
                    })
                );
                primary = results[0].parsed;
                primaryUrl = results[0].url;
            } else if (playlist.segments.length === 0) {
                throw new Error(`playlist ${stripQuery(monitor.url)} contains no segments`);
            }

            const live = !primary.endList;
            this.checkStale(monitor, primary, live);

            const newestSegmentUrl = resolveUrl(primary.segments[primary.segments.length - 1], primaryUrl);
            const probes = [check.probe("newest segment", newestSegmentUrl)];
            if (primary.mapUri) {
                probes.push(check.probe("init segment", resolveUrl(primary.mapUri, primaryUrl)));
            }
            const [segment, init] = await Promise.all(probes);

            const parts = [live ? "live" : "vod", variantsLabel, `seq ${primary.mediaSequence}`];
            if (primary.targetDuration) {
                parts.push(`target ${primary.targetDuration}s`);
            }
            if (init) {
                parts.push(`init ${init.status}`);
            }
            parts.push(`newest segment ${segment.status} in ${segment.ms}ms`);

            heartbeat.msg = parts.join(", ");
            heartbeat.status = UP;
        } finally {
            check.close();
        }
    }

    /**
     * Fail when a live media playlist did not advance for too long. VOD and monitors without id are skipped.
     * @param {object} monitor Monitor
     * @param {object} playlist Parsed media playlist
     * @param {boolean} live False for a playlist with EXT-X-ENDLIST
     * @returns {void}
     * @throws {Error} When the playlist is stale
     */
    checkStale(monitor, playlist, live) {
        if (!monitor.id) {
            return;
        }
        if (!live) {
            this.state.delete(monitor.id);
            return;
        }

        const now = this.now();
        const lastSegment = playlist.segments[playlist.segments.length - 1];
        const previous = this.state.get(monitor.id);

        if (!previous || previous.mediaSequence !== playlist.mediaSequence || previous.lastSegment !== lastSegment) {
            this.state.set(monitor.id, { mediaSequence: playlist.mediaSequence, lastSegment, since: now });
            return;
        }

        const limit = Math.max(3 * (playlist.targetDuration || 0), MIN_STALE_SECONDS);
        const unchangedFor = (now - previous.since) / 1000;
        if (unchangedFor > limit) {
            throw new Error(
                `playlist stale: media sequence ${playlist.mediaSequence} unchanged for ${Math.round(unchangedFor)}s`
            );
        }
    }
}

/**
 * Resolve a playlist URI against the playlist URL. The query string is kept exactly as written
 * and is never inherited from the base.
 * @param {string} uri URI from the playlist
 * @param {string} base URL of the playlist
 * @returns {string} Absolute URL
 */
function resolveUrl(uri, base) {
    return new URL(uri, base).href;
}

module.exports = {
    HLSMonitorType,
    parsePlaylist,
};
