const { BeanModel } = require("redbean-node/dist/bean-model");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const brotliDecompress = promisify(zlib.brotliDecompress);
const { decodeHttpDetail, isHttpDetailValue } = require("../http-detail");

/**
 * status:
 *      0 = DOWN
 *      1 = UP
 *      2 = PENDING
 *      3 = MAINTENANCE
 */
class Heartbeat extends BeanModel {
    /**
     * Return an object that ready to parse to JSON for public
     * Only show necessary data to public
     * @returns {object} Object ready to parse
     */
    toPublicJSON() {
        return {
            status: this.status,
            time: this.time,
            msg: "", // Hide for public
            ping: this.ping,
        };
    }

    /**
     * Return an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        // Detail rows are fetched on demand (getHeartbeatDetail), so the blob is not shipped in lists
        const hasDetail = isHttpDetailValue(this._response);
        return {
            monitorID: this._monitorId,
            status: this._status,
            time: this._time,
            msg: this._msg,
            ping: this._ping,
            important: this._important,
            duration: this._duration,
            retries: this._retries,
            response: hasDetail ? null : this._response,
            hasDetail,
        };
    }

    /**
     * Return an object that ready to parse to JSON
     * @param {{ decodeResponse?: boolean }} opts Options for JSON serialization
     * @returns {Promise<object>} Object ready to parse
     */
    async toJSONAsync(opts) {
        let response;
        let httpDetail;
        if (opts?.decodeResponse) {
            httpDetail = (await decodeHttpDetail(this._response)) || undefined;
            response = httpDetail ? httpDetail.body : await Heartbeat.decodeResponseValue(this._response);
        }

        return {
            monitorID: this._monitorId,
            status: this._status,
            time: this._time,
            msg: this._msg,
            ping: this._ping,
            important: this._important,
            duration: this._duration,
            retries: this._retries,
            response,
            httpDetail,
        };
    }

    /**
     * Decode compressed response payload stored in database.
     * @param {string|null} response Encoded response payload.
     * @returns {string|null} Decoded response payload.
     */
    static async decodeResponseValue(response) {
        if (!response) {
            return response;
        }

        try {
            // Offload brotli decode from main event loop to libuv thread pool
            return (await brotliDecompress(Buffer.from(response, "base64"))).toString("utf8");
        } catch (error) {
            return response;
        }
    }
}

module.exports = Heartbeat;
