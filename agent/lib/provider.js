/**
 * Model provider abstraction.
 *
 * Both providers expose the same tiny surface:
 *   async runTurn({ system, messages, tools }) -> {
 *     stopReason: "tool_use" | "end_turn",
 *     assistantMessage: { role: "assistant", content: [...] },  // provider-native blocks
 *     toolCalls: [{ id, name, input }],
 *     text: string,  // concatenated text blocks
 *     usage: { input_tokens, output_tokens },
 *   }
 *
 * The caller (index.js) then appends the assistant message + any tool results
 * back into `messages` and loops until stopReason === "end_turn".
 *
 * Tool schemas fed in are in the common MCP shape:
 *   { name, description, input_schema }
 * Each provider module translates to its own tool format internally.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const PROVIDER = (process.env.MODEL_PROVIDER || "anthropic").toLowerCase();

// ---- Anthropic ------------------------------------------------------------

function makeAnthropicClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function runTurnAnthropic({ system, messages, tools }) {
  const client = makeAnthropicClient();
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

  const resp = await client.messages.create({
    model,
    max_tokens: 2048,
    system,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
    messages,
  });

  const toolCalls = [];
  let text = "";
  for (const block of resp.content) {
    if (block.type === "text") text += block.text;
    if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  return {
    stopReason: resp.stop_reason === "tool_use" ? "tool_use" : "end_turn",
    assistantMessage: { role: "assistant", content: resp.content },
    toolCalls,
    text,
    usage: {
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0,
    },
    model,
  };
}

function anthropicToolResultBlocks(results) {
  // Anthropic expects a user-turn message with tool_result blocks
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.id,
      content: JSON.stringify(r.output),
      is_error: !!r.isError,
    })),
  };
}

// ---- OpenAI ---------------------------------------------------------------

function makeOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * OpenAI's chat.completions API uses a different shape than Anthropic's:
 *   - `system` is a message with role "system"
 *   - tools are under `tools: [{type:"function", function:{name,description,parameters}}]`
 *   - tool calls come back on assistant messages as `tool_calls`
 *   - tool results are role "tool" messages with `tool_call_id`
 *
 * We accept messages in the common shape and translate internally so the
 * agent loop doesn't need to know which provider is active.
 */
async function runTurnOpenAI({ system, messages, tools }) {
  const client = makeOpenAIClient();
  const model = process.env.OPENAI_MODEL || "gpt-4o";

  // Translate common messages → OpenAI messages
  const oaMessages = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      // user with tool_result blocks (common Anthropic shape) → many "tool" msgs
      if (Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")) {
        for (const b of m.content) {
          if (b.type === "tool_result") {
            oaMessages.push({
              role: "tool",
              tool_call_id: b.tool_use_id,
              content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
            });
          } else if (b.type === "text") {
            oaMessages.push({ role: "user", content: b.text });
          }
        }
        continue;
      }
      oaMessages.push({
        role: "user",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
    } else if (m.role === "assistant") {
      // Assistant may be native OpenAI (already {content, tool_calls})
      // or native Anthropic (blocks). Translate if blocks.
      if (Array.isArray(m.content)) {
        const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        const tool_calls = m.content
          .filter((b) => b.type === "tool_use")
          .map((b) => ({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
        const asst = { role: "assistant", content: text || null };
        if (tool_calls.length) asst.tool_calls = tool_calls;
        oaMessages.push(asst);
      } else {
        oaMessages.push(m);
      }
    }
  }

  const resp = await client.chat.completions.create({
    model,
    messages: oaMessages,
    tools: tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    })),
    tool_choice: "auto",
  });

  const choice = resp.choices[0];
  const msg = choice.message;
  const toolCalls =
    (msg.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: safeJson(tc.function.arguments),
    })) || [];

  // Re-express as Anthropic-style blocks so the outer loop stays uniform
  const blocks = [];
  if (msg.content) blocks.push({ type: "text", text: msg.content });
  for (const tc of toolCalls) {
    blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
  }

  return {
    stopReason: toolCalls.length ? "tool_use" : "end_turn",
    assistantMessage: { role: "assistant", content: blocks },
    toolCalls,
    text: msg.content || "",
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.completion_tokens || 0,
    },
    model,
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function openaiToolResultBlocks(results) {
  // We keep the uniform tool_result block shape; the OpenAI translation happens
  // inside runTurnOpenAI next time we call.
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.id,
      content: JSON.stringify(r.output),
      is_error: !!r.isError,
    })),
  };
}

// ---- Unified surface ------------------------------------------------------

export async function runTurn(args) {
  if (PROVIDER === "openai") return runTurnOpenAI(args);
  return runTurnAnthropic(args);
}

export function toolResultMessage(results) {
  if (PROVIDER === "openai") return openaiToolResultBlocks(results);
  return anthropicToolResultBlocks(results);
}

export function activeProvider() {
  return PROVIDER;
}
