import { Type, type FunctionDeclaration } from "@google/genai";

/**
 * Every action tool requires "reasoning" as its FIRST declared property. Forcing a function
 * call every turn (functionCallingConfig.mode = ANY, so the loop always gets exactly one
 * action) means Gemini never emits an accompanying free-text part to explain itself -- so
 * the "why" has to live inside the structured call itself, not beside it. Listing it first
 * also nudges the model to produce its justification before committing to the action, the
 * same reason chain-of-thought prompts ask for reasoning before an answer.
 */
const REASONING_FIELD = {
  reasoning: {
    type: Type.STRING,
    description: "One brief sentence: why this specific action, right now, moves toward the goal.",
  },
};

export const DISCOVERY_TOOLS: FunctionDeclaration[] = [
  {
    name: "navigate",
    description:
      "Navigate the browser directly to a URL. Prefer clicking links/buttons seen in the observation; use this mainly for the initial entry point.",
    parameters: {
      type: Type.OBJECT,
      properties: { ...REASONING_FIELD, url: { type: Type.STRING } },
      required: ["reasoning", "url"],
    },
  },
  {
    name: "click",
    description:
      "Click a button, link, checkbox, or radio visible in the current observation. Identify it by its exact role and name as shown; add nth if the same (role, name) appears more than once.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ...REASONING_FIELD,
        role: { type: Type.STRING, enum: ["button", "link", "checkbox", "radio"] },
        name: { type: Type.STRING },
        nth: { type: Type.INTEGER, description: "0-based index if duplicates exist, default 0" },
      },
      required: ["reasoning", "role", "name"],
    },
  },
  {
    name: "type",
    description: "Type text into a textbox visible in the current observation, replacing any existing value.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ...REASONING_FIELD,
        role: { type: Type.STRING, enum: ["textbox"] },
        name: { type: Type.STRING },
        nth: { type: Type.INTEGER },
        text: { type: Type.STRING },
      },
      required: ["reasoning", "role", "name", "text"],
    },
  },
  {
    name: "select_option",
    description: "Choose an option from a dropdown (combobox) visible in the current observation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ...REASONING_FIELD,
        role: { type: Type.STRING, enum: ["combobox"] },
        name: { type: Type.STRING },
        nth: { type: Type.INTEGER },
        option: { type: Type.STRING },
      },
      required: ["reasoning", "role", "name", "option"],
    },
  },
  {
    name: "extract",
    description:
      "Read the visible text/value of an element in the current observation and store it under a named output for the caller.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ...REASONING_FIELD,
        role: { type: Type.STRING },
        name: { type: Type.STRING },
        nth: { type: Type.INTEGER },
        as: { type: Type.STRING, description: "Output name to store the value under, e.g. savingsBalance" },
      },
      required: ["reasoning", "role", "name", "as"],
    },
  },
  {
    name: "finish",
    description: "Call once the goal has been fully accomplished and the expected result/confirmation state is visible.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        success: { type: Type.BOOLEAN },
        summary: { type: Type.STRING },
      },
      required: ["success", "summary"],
    },
  },
  {
    name: "escalate",
    description:
      "Call if you are stuck, blocked, or hit something you cannot safely resolve alone: an unexpected error, an ambiguous state, repeated failed actions, or an action that needs human judgment/confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: { reason: { type: Type.STRING } },
      required: ["reason"],
    },
  },
];
