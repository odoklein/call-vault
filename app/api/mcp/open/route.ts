import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createVaultMcpServer } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/mcp/open — the same call-vault MCP with NO authentication and access to EVERY line.
 * For ChatGPT custom connectors that cannot send a Bearer token. Anyone who knows the URL can read
 * all calls, transcripts and phone numbers, so it is off unless MCP_OPEN_ACCESS=true (404 otherwise).
 */
async function handle(req: Request): Promise<Response> {
  if (process.env.MCP_OPEN_ACCESS !== "true") return new Response("Not found", { status: 404 });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await createVaultMcpServer({ kind: "admin" }).connect(transport);
  return transport.handleRequest(req);
}

export { handle as POST, handle as GET, handle as DELETE };
