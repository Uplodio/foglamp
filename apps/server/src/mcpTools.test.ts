import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { absoluteLinks, registerToolSet } from "./mcpTools";

async function connect(tools: ToolSet) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const registered = registerToolSet(server, tools, { appOrigin: "https://app.example/" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, registered };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

describe("registerToolSet", () => {
  test("exposes the zod input schema and answers with JSON text, links absolute", async () => {
    const { client, registered } = await connect({
      listThings: tool({
        description: "List things.",
        inputSchema: z.object({ limit: z.number().int().optional() }),
        execute: async ({ limit }) => ({
          rows: [
            { id: "a", link: "/traces/a" },
            { id: "b", link: "/traces/b" },
          ].slice(0, limit ?? 2),
        }),
      }),
    });
    expect(registered).toEqual(["listThings"]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["listThings"]);
    expect(tools[0]?.description).toBe("List things.");
    expect(tools[0]?.inputSchema.properties).toHaveProperty("limit");
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);

    const result = await client.callTool({ name: "listThings", arguments: { limit: 1 } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      rows: [{ id: "a", link: "https://app.example/traces/a" }],
    });
  });

  test("a throwing tool becomes an isError result, not a protocol error", async () => {
    const { client } = await connect({
      boom: tool({
        description: "Always fails.",
        inputSchema: z.object({ reason: z.string().optional() }),
        execute: async (): Promise<{ ok: boolean }> => {
          throw new Error("Project not found or not accessible");
        },
      }),
    });
    const result = await client.callTool({ name: "boom", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Project not found or not accessible");
  });

  test("skips tools that cannot execute", async () => {
    const { registered } = await connect({
      clientSide: tool({
        description: "No execute: runs on the caller.",
        inputSchema: z.object({ q: z.string() }),
      }),
    });
    expect(registered).toEqual([]);
  });
});

describe("absoluteLinks", () => {
  test("rewrites only root-relative `link` strings, at any depth", () => {
    expect(
      absoluteLinks(
        {
          link: "/sessions/s1",
          other: "/not-a-link",
          nested: [{ link: "https://already.example/x" }, { link: "/traces/t" }],
        },
        "https://app.example",
      ),
    ).toEqual({
      link: "https://app.example/sessions/s1",
      other: "/not-a-link",
      nested: [{ link: "https://already.example/x" }, { link: "https://app.example/traces/t" }],
    });
  });
});
