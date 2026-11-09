import { ToolError } from "./errors.js";
import { createCraftTools } from "./craft.js";
import { createShellTool } from "./shell.js";
import { createSkillTool } from "./skills.js";
import { createTaskTool } from "./task.js";
import { createTodoTool } from "./todo.js";
import { createWebFetchTool } from "./web.js";
import { createWorkspaceTools } from "./workspace.js";

export async function createEquipmentTools({
  activeEquipment,
  workspaceRoot,
  stateDirectory,
  skillsRoot,
  approveShell,
  runSubagent,
  craftCommand,
} = {}) {
  if (!activeEquipment || !Array.isArray(activeEquipment.tools)) {
    throw new ToolError("INVALID_EQUIPMENT_PLAN", "Active equipment must include a validated tools array.");
  }

  const selected = new Set(activeEquipment.tools);
  if (selected.size !== activeEquipment.tools.length
    || activeEquipment.tools.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new ToolError("INVALID_EQUIPMENT_PLAN", "Active equipment contains duplicate or invalid tool names.");
  }

  const handlers = new Map();
  function add(tool) {
    if (!tool || typeof tool.name !== "string" || handlers.has(tool.name)) {
      throw new ToolError("DUPLICATE_TOOL_HANDLER", `Duplicate or invalid tool handler: ${tool?.name ?? "unknown"}.`);
    }
    if (typeof tool.idempotent !== "boolean" || typeof tool.execute !== "function") {
      throw new ToolError("INVALID_TOOL_HANDLER", `Tool handler ${tool.name} must define idempotent and execute.`);
    }
    handlers.set(tool.name, tool);
  }

  const workspaceTools = ["read_file", "write_file", "edit_file", "glob_files", "grep_files"];
  if (workspaceTools.some((name) => selected.has(name))) {
    for (const tool of await createWorkspaceTools(workspaceRoot)) add(tool);
  }
  if (selected.has("shell")) add(await createShellTool(workspaceRoot, { approve: approveShell }));
  if (selected.has("web_fetch")) add(createWebFetchTool());
  if (selected.has("todo")) add(createTodoTool(stateDirectory));
  if (selected.has("skill")) add(await createSkillTool(activeEquipment.skills ?? [], skillsRoot));
  if (selected.has("task")) add(createTaskTool(runSubagent));
  if (selected.has("craft_chat") || selected.has("craft_report")) {
    for (const tool of await createCraftTools({
      workspaceRoot,
      stateDirectory,
      command: craftCommand,
    })) add(tool);
  }

  const result = [];
  for (const name of activeEquipment.tools) {
    const tool = handlers.get(name);
    if (!tool) throw new ToolError("TOOL_HANDLER_MISSING", `Active equipment has no handler for tool ${name}.`, { name });
    result.push(tool);
  }
  return result;
}
