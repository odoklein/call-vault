import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { apiViewer } from "@/lib/api-keys";
import { createVaultMcpServer } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/mcp — the standalone call-vault MCP (Streamable HTTP, stateless, one server per request).
 * Bearer vault key; a client key only sees its granted lines (lib/access.ts). Independent of the
 * CRM's MCP: the two are joined by the caller on the prospect's phone number.
 */
async function handle(req: Request): Promise<Response> {
  const viewer = await apiViewer(req, "/api/mcp");
  if (!viewer) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="call-vault"' } },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await createVaultMcpServer(viewer).connect(transport);
  return transport.handleRequest(req);
}

export { handle as POST, handle as GET, handle as DELETE };
