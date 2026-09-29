import { classifyD1DailyLimitError, dailyLimitMcpMessage } from "../lib/daily-limit";

/**
 * R3 (budget audit, MAJOR): a D1 daily-cap error thrown inside a tool handler is already caught by
 * the MCP SDK itself (server/mcp.js's tools/call dispatch) and turned into an ordinary-looking
 * `CallToolResult` whose text is the raw D1 error — never an exception this file could catch with
 * try/catch. Rewriting that text here is the "catch" for this surface: mirrors
 * sanitizeToolsListResponse's own JSON/SSE handling, and returns the SAME response object,
 * untouched, whenever nothing matches, so a caller that compares identity (or just never needed a
 * rewrite) sees no difference.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewriteToolErrorPayload(payload: unknown): { payload: unknown; changed: boolean } {
  if (!isRecord(payload) || !isRecord(payload.result) || payload.result.isError !== true) {
    return { payload, changed: false };
  }
  const content = payload.result.content;
  if (!Array.isArray(content) || !content.length) return { payload, changed: false };
  const first = content[0];
  if (!isRecord(first) || typeof first.text !== "string") return { payload, changed: false };

  const kind = classifyD1DailyLimitError(new Error(first.text));
  if (!kind) return { payload, changed: false };

  const rewritten = {
    ...payload,
    result: {
      ...payload.result,
      content: [{ ...first, text: dailyLimitMcpMessage(kind) }, ...content.slice(1)],
    },
  };
  return { payload: rewritten, changed: true };
}

export async function rewriteDailyLimitToolErrors(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
    return response;
  }

  if (contentType.includes("text/event-stream")) {
    const body = await response.clone().text();
    let changedAny = false;
    const rewritten = body.split("\n").map(line => {
      if (!line.startsWith("data: ")) return line;
      try {
        const { payload, changed } = rewriteToolErrorPayload(JSON.parse(line.slice(6)));
        if (!changed) return line;
        changedAny = true;
        return `data: ${JSON.stringify(payload)}`;
      } catch {
        return line;
      }
    }).join("\n");
    if (!changedAny) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(rewritten, { status: response.status, statusText: response.statusText, headers });
  }

  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    return response;
  }
  const { payload, changed } = rewriteToolErrorPayload(parsed);
  if (!changed) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers });
}
