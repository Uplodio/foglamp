import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolSet } from "ai";

// Adapts an AI SDK ToolSet (Foggy's tools) to MCP tool registrations. Kept
// free of env/db imports so it can be unit-tested over an in-memory transport.
//
// Each tool keeps its zod input schema (the MCP SDK turns it into the JSON
// Schema clients see), runs the same execute() Foggy runs, and answers with one
// JSON text block. The tools emit dashboard paths as `link` (`/traces/<id>`);
// they're made absolute so the agent can hand the user a clickable URL.

export type RegisterOptions = {
  /** Dashboard origin (https://foglamp.example.com) prefixed onto `link`s. */
  appOrigin: string;
};

// AI SDK tools may carry a zod schema, a JSON-schema wrapper, or a lazy
// schema; only zod (v3 `_def` / v4 `_zod`) can be handed to the MCP SDK as-is.
function zodSchemaOf(schema: unknown): AnySchema | null {
  if (!schema || typeof schema !== "object") return null;
  return "_zod" in schema || "_def" in schema ? (schema as AnySchema) : null;
}

/** Rewrite every `link: "/path"` in a JSON-safe result to an absolute URL. */
export function absoluteLinks<T>(value: T, appOrigin: string): T {
  const origin = appOrigin.replace(/\/+$/, "");
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((item) => walk(item));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, inner]) => [k, walk(inner, k)]),
      );
    }
    if (key === "link" && typeof v === "string" && v.startsWith("/")) return origin + v;
    return v;
  };
  return walk(value) as T;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

/**
 * Register every executable tool of `tools` on `server`, annotated read-only.
 * A tool that throws becomes an `isError` result (the agent sees the message
 * and can adjust its call) rather than a protocol-level failure.
 */
export function registerToolSet(
  server: McpServer,
  tools: ToolSet,
  opts: RegisterOptions,
): string[] {
  const registered: string[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute;
    const inputSchema = zodSchemaOf(t.inputSchema);
    if (!execute || !inputSchema) continue;
    server.registerTool(
      name,
      {
        // ai@7 also allows a description function (resolved against a run
        // context the MCP side doesn't have); only static strings carry over.
        description: typeof t.description === "string" ? t.description : undefined,
        inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (
        args: unknown,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ): Promise<CallToolResult> => {
        try {
          const result = await execute(args as never, {
            toolCallId: String(extra.requestId),
            messages: [],
            abortSignal: extra.signal,
            // No agent run around an MCP call; Foggy's tools never read it.
            context: undefined,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(absoluteLinks(result, opts.appOrigin), null, 2),
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: errorText(err) }] };
        }
      },
    );
    registered.push(name);
  }
  return registered;
}
