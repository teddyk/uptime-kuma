/**
 * Read the server settings from environment variables.
 * @param {object} env Environment, defaults to process.env
 * @returns {{url: string, username: string|undefined, password: string|undefined, jwt: string|undefined,
 *     writeEnabled: boolean}} Validated settings
 * @throws {Error} When KUMA_URL or the login variables are missing
 */
export function loadConfig(env = process.env) {
    const url = env.KUMA_URL;
    const jwt = env.KUMA_JWT || undefined;
    const username = env.KUMA_USERNAME || undefined;
    const password = env.KUMA_PASSWORD || undefined;

    if (!url) {
        throw new Error("KUMA_URL is required");
    }
    if (!jwt && !(username && password)) {
        throw new Error("Set KUMA_JWT, or both KUMA_USERNAME and KUMA_PASSWORD");
    }

    return {
        url,
        username,
        password,
        jwt,
        writeEnabled: env.KUMA_MCP_WRITE === "1" || env.KUMA_MCP_WRITE === "true",
    };
}
