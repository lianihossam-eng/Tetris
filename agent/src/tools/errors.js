export class ToolError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ToolError";
    this.code = code;
  }
}

export function requireObject(value, toolName) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError("INVALID_INPUT", `${toolName} input must be an object.`);
  }
}

export function requireString(value, field, { maxLength = 4096, allowEmpty = false } = {}) {
  if (typeof value !== "string"
    || (!allowEmpty && value.trim().length === 0)
    || value.length > maxLength) {
    throw new ToolError("INVALID_INPUT", `${field} must be ${allowEmpty ? "a" : "a non-empty"} string no longer than ${maxLength} characters.`);
  }
  return value;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}
