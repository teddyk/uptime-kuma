const { MonitorType } = require("./monitor-type");
const { UP } = require("../../src/util");
const { StreamCheck } = require("./stream-check");

/**
 * Body bytes that must arrive before the timeout to prove audio is flowing
 */
const MIN_BODY_BYTES = 16 * 1024;

class IcecastMonitorType extends MonitorType {
    name = "icecast";

    /**
     * Checks an Icecast/Shoutcast mount: HTTP 200, an audio content-type and at least 16 KB of body
     * before the monitor timeout. The connection is aborted afterwards.
     *
     * Limit: Node's HTTP parser rejects the legacy "ICY 200 OK" status line of old Shoutcast v1
     * servers, such a stream is reported DOWN with an "invalid HTTP response" message.
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const check = new StreamCheck(monitor);
        try {
            const start = Date.now();
            let response;
            try {
                response = await check.open(monitor.url, { headers: { "Icy-MetaData": "1" } });
            } catch (error) {
                throw new Error(check.errorMessage(error));
            }

            if (response.status !== 200) {
                check.release(response);
                throw new Error(`unexpected HTTP status ${response.status}`);
            }

            const contentType = String(response.headers["content-type"] || "")
                .split(";")[0]
                .trim()
                .toLowerCase();
            if (!contentType.startsWith("audio/") && contentType !== "application/ogg") {
                check.release(response);
                throw new Error(`unexpected content-type "${contentType || "none"}", expected audio/*`);
            }

            let bytes = 0;
            let firstByteAt = null;
            let result;
            try {
                result = await check.consume(response, (chunk) => {
                    if (firstByteAt === null) {
                        firstByteAt = Date.now();
                    }
                    bytes += chunk.length;
                    return bytes >= MIN_BODY_BYTES;
                });
            } catch (error) {
                throw new Error(`stream error after ${bytes} bytes: ${check.errorMessage(error)}`);
            }

            const seconds = ((Date.now() - start) / 1000).toFixed(1);
            if (firstByteAt !== null) {
                heartbeat.ping = firstByteAt - start;
            }
            if (result === "timeout") {
                throw new Error(`stream stalled: only ${bytes} bytes in ${seconds}s`);
            }
            if (result !== "stopped") {
                throw new Error(`stream ended: only ${bytes} bytes in ${seconds}s`);
            }

            const parts = [`${response.status} - ${contentType}`];
            const bitrate = parseInt(response.headers["icy-br"], 10);
            if (bitrate > 0) {
                parts.push(`${bitrate} kbps`);
            }
            if (response.headers["icy-name"]) {
                parts.push(`"${response.headers["icy-name"]}"`);
            }
            parts.push(`${Math.round(bytes / 1024)} KB in ${seconds}s`);

            heartbeat.msg = parts.join(", ");
            heartbeat.status = UP;
        } finally {
            check.close();
        }
    }
}

module.exports = {
    IcecastMonitorType,
    MIN_BODY_BYTES,
};
