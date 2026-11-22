const http = require("http");
const https = require("https");
const axios = require("axios");

/**
 * Header used for probe requests of media segments. Servers that ignore it answer 200 and
 * the body is aborted after the first chunk anyway.
 */
const PROBE_RANGE = "bytes=0-1023";

/**
 * Maximum size of a playlist or manifest that is read into memory
 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/**
 * Default timeout in seconds when a monitor has none
 */
const DEFAULT_TIMEOUT_SECONDS = 48;

/**
 * Remove query string, fragment and credentials from a URL, tokens may be in them.
 * @param {string} url URL to clean
 * @returns {string} URL without query string
 */
function stripQuery(url) {
    try {
        const parsed = new URL(url);
        parsed.search = "";
        parsed.hash = "";
        parsed.username = "";
        parsed.password = "";
        return parsed.toString();
    } catch {
        return String(url).split(/[?#]/)[0];
    }
}

/**
 * One check run: shared overall deadline, abort handling and TLS settings for all requests
 * of a stream check. Every request and stream opened through it is torn down in close().
 */
class StreamCheck {
    /**
     * @param {object} monitor Monitor (only timeout and ignore TLS are read)
     */
    constructor(monitor) {
        const timeout = Number(monitor.timeout);
        this.timeoutSeconds = timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS;
        this.timedOut = false;
        this.controller = new AbortController();
        this.streams = new Set();

        const ignoreTls =
            typeof monitor.getIgnoreTls === "function" ? monitor.getIgnoreTls() : Boolean(monitor.ignoreTls);
        this.httpAgent = new http.Agent({ keepAlive: false });
        this.httpsAgent = new https.Agent({
            keepAlive: false,
            maxCachedSessions: 0,
            rejectUnauthorized: !ignoreTls,
        });

        this.timer = setTimeout(() => {
            this.timedOut = true;
            this.controller.abort();
            for (const stream of this.streams) {
                stream.destroy();
            }
        }, this.timeoutSeconds * 1000);
    }

    /**
     * Stop the deadline timer, abort pending requests and close all open streams and sockets.
     * @returns {void}
     */
    close() {
        clearTimeout(this.timer);
        this.controller.abort();
        for (const stream of this.streams) {
            stream.destroy();
        }
        this.streams.clear();
        this.httpAgent.destroy();
        this.httpsAgent.destroy();
    }

    /**
     * Start a streaming GET. Any HTTP status resolves, the caller decides what is acceptable.
     * @param {string} url URL to request
     * @param {object} options Options
     * @param {object} options.headers Extra request headers
     * @param {boolean} options.range Send the probe Range header
     * @returns {Promise<import("axios").AxiosResponse>} Response whose data is a readable stream
     */
    async open(url, { headers = {}, range = false } = {}) {
        const response = await axios.get(url, {
            responseType: "stream",
            headers: {
                ...headers,
                ...(range ? { Range: PROBE_RANGE } : {}),
            },
            validateStatus: () => true,
            signal: this.controller.signal,
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
        });
        // Destroying a response before it ended can emit an error, never let it go unhandled
        response.data.on("error", () => {});
        this.streams.add(response.data);
        return response;
    }

    /**
     * Release a response without reading its body
     * @param {import("axios").AxiosResponse} response Response from open()
     * @returns {void}
     */
    release(response) {
        response.data.destroy();
        this.streams.delete(response.data);
    }

    /**
     * Feed a response stream to onChunk until it returns true, the stream ends or the deadline passes.
     * The stream is always destroyed afterwards, which closes the connection.
     * @param {import("axios").AxiosResponse} response Response from open()
     * @param {Function} onChunk Called with each Buffer, return true to stop reading
     * @returns {Promise<string>} "stopped", "end" (or premature close) or "timeout"
     */
    consume(response, onChunk) {
        const stream = response.data;
        const signal = this.controller.signal;
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (value, error) => {
                if (finished) {
                    return;
                }
                finished = true;
                signal.removeEventListener("abort", onAbort);
                stream.destroy();
                this.streams.delete(stream);
                if (error) {
                    reject(error);
                } else {
                    resolve(value);
                }
            };
            const onAbort = () => finish("timeout");

            stream.on("data", (chunk) => {
                try {
                    if (onChunk(chunk)) {
                        finish("stopped");
                    }
                } catch (error) {
                    finish(null, error);
                }
            });
            stream.on("end", () => finish("end"));
            stream.on("close", () => finish("end"));
            stream.on("error", (error) => finish(null, error));

            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener("abort", onAbort);
            }
        });
    }

    /**
     * Read a response body as text, refusing bodies larger than MAX_TEXT_BYTES.
     * @param {import("axios").AxiosResponse} response Response from open()
     * @returns {Promise<string>} Body as UTF-8 text without BOM
     */
    async readText(response) {
        const chunks = [];
        let size = 0;
        const result = await this.consume(response, (chunk) => {
            size += chunk.length;
            if (size > MAX_TEXT_BYTES) {
                throw new Error(`body larger than ${MAX_TEXT_BYTES / 1024 / 1024} MB`);
            }
            chunks.push(chunk);
            return false;
        });
        if (result === "timeout") {
            throw this.timeoutError();
        }
        return Buffer.concat(chunks)
            .toString("utf8")
            .replace(/^\uFEFF/, "");
    }

    /**
     * @returns {Error} Error for an exceeded overall deadline
     */
    timeoutError() {
        return new Error(`timed out after ${this.timeoutSeconds}s`);
    }

    /**
     * Turn a request error into a short readable message.
     * @param {Error} error Error from axios or a stream
     * @returns {string} Message
     */
    errorMessage(error) {
        if (this.timedOut) {
            return this.timeoutError().message;
        }
        if (typeof error.code === "string" && error.code.startsWith("HPE_")) {
            // Node's HTTP parser rejects the legacy Shoutcast "ICY 200 OK" status line like this
            return `invalid HTTP response (${error.code}), the server may use a non-HTTP status line such as ICY 200 OK`;
        }
        return error.message || error.code || String(error);
    }

    /**
     * Fetch a text document (playlist or manifest). Must answer 200.
     * @param {string} label What is fetched, used in error messages
     * @param {string} url URL to fetch
     * @returns {Promise<{text: string, status: number, ms: number, url: string}>} Body, status, duration and final URL after redirects
     */
    async fetchText(label, url) {
        const start = Date.now();
        let response;
        try {
            response = await this.open(url);
        } catch (error) {
            throw new Error(`${label} ${stripQuery(url)}: ${this.errorMessage(error)}`);
        }
        if (response.status !== 200) {
            this.release(response);
            throw new Error(`${label} ${stripQuery(url)} returned HTTP ${response.status}`);
        }
        let text;
        try {
            text = await this.readText(response);
        } catch (error) {
            throw new Error(`${label} ${stripQuery(url)}: ${this.errorMessage(error)}`);
        }
        return {
            text,
            status: response.status,
            ms: Date.now() - start,
            url: finalUrl(response, url),
        };
    }

    /**
     * Fetch the start of a media file with a ranged GET and abort after the first byte.
     * @param {string} label What is fetched, used in error messages
     * @param {string} url URL to fetch
     * @returns {Promise<{status: number, ms: number}>} Status (200 or 206) and time to the first byte
     */
    async probe(label, url) {
        const start = Date.now();
        let response;
        try {
            response = await this.open(url, { range: true });
        } catch (error) {
            throw new Error(`${label} ${stripQuery(url)}: ${this.errorMessage(error)}`);
        }
        if (response.status !== 200 && response.status !== 206) {
            this.release(response);
            throw new Error(`${label} ${stripQuery(url)} returned HTTP ${response.status}`);
        }
        let bytes = 0;
        let ms = 0;
        let result;
        try {
            result = await this.consume(response, (chunk) => {
                bytes += chunk.length;
                ms = Date.now() - start;
                return bytes > 0;
            });
        } catch (error) {
            throw new Error(`${label} ${stripQuery(url)}: ${this.errorMessage(error)}`);
        }
        if (result === "timeout") {
            throw new Error(`${label} ${stripQuery(url)}: ${this.timeoutError().message}`);
        }
        if (bytes === 0) {
            throw new Error(`${label} ${stripQuery(url)} returned an empty body (HTTP ${response.status})`);
        }
        return { status: response.status, ms };
    }
}

/**
 * URL of a response after redirects
 * @param {import("axios").AxiosResponse} response Response
 * @param {string} fallback URL that was requested
 * @returns {string} Final URL
 */
function finalUrl(response, fallback) {
    return response.request?.res?.responseUrl || fallback;
}

module.exports = {
    StreamCheck,
    stripQuery,
    finalUrl,
    PROBE_RANGE,
    MAX_TEXT_BYTES,
};
