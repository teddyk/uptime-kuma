#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KumaClient } from "./src/kuma-client.js";
import { loadConfig } from "./src/config.js";
import { createServer } from "./src/server.js";

/**
 * Start the MCP server on stdio. stdout carries the protocol, so diagnostics go to stderr.
 * @returns {Promise<void>} Resolves once the transport is connected
 */
async function main() {
    const config = loadConfig();
    const kuma = new KumaClient(config);
    await kuma.connect();

    const server = createServer({ kuma, writeEnabled: config.writeEnabled });
    const transport = new StdioServerTransport();
    transport.onclose = () => kuma.close();
    // The stdio transport does not close itself when the client hangs up; the open Kuma socket would keep us alive.
    process.stdin.on("end", () => transport.close());
    await server.connect(transport);
    console.error(`uptime-kuma-fork MCP server ready (writes ${config.writeEnabled ? "enabled" : "disabled"})`);
}

main().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exit(1);
});
