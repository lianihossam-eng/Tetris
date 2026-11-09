import { ToolError, requireObject, requireString, throwIfAborted } from "./errors.js";

const MAX_GOAL_LENGTH = 8_000;
const MAX_RESULT_CHARS = 32_000;

export function createTaskTool(runSubagent) {
  if (typeof runSubagent !== "function") {
    throw new ToolError("INVALID_CONFIGURATION", "Task tool needs a subagent runner.");
  }

  return {
    name: "task",
    description: "Delegate one bounded research or implementation task to an isolated child agent. Child agents cannot delegate again.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", minLength: 1, maxLength: MAX_GOAL_LENGTH },
        mode: { type: "string", enum: ["research", "implementation"] },
      },
      required: ["goal"],
      additionalProperties: false,
    },
    idempotent: false,
    writes: true,
    async execute(input, context = {}) {
      requireObject(input, "task");
      const goal = requireString(input.goal, "goal", { maxLength: MAX_GOAL_LENGTH }).trim();
      if (goal.length === 0) throw new ToolError("INVALID_INPUT", "goal must not be empty.");
      const mode = input.mode ?? "research";
      if (mode !== "research" && mode !== "implementation") {
        throw new ToolError("INVALID_INPUT", "mode must be research or implementation.");
      }
      throwIfAborted(context.signal);

      const result = await runSubagent({
        goal,
        mode,
        parentSessionId: context.sessionId,
        signal: context.signal,
      });
      if (!result || typeof result.text !== "string" || typeof result.stopReason !== "string") {
        throw new ToolError("TASK_FAILED", "The subagent returned an invalid result.");
      }

      return {
        mode,
        sessionId: result.sessionId ?? null,
        stopReason: result.stopReason,
        text: result.text.slice(0, MAX_RESULT_CHARS),
        truncated: result.text.length > MAX_RESULT_CHARS,
      };
    },
  };
}
