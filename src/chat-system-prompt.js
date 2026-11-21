import { promptText } from "./prompt-files.js";

export const DEFAULT_CHAT_PERSONA = ['identity', 'relationship', 'personality'].map(promptText).join('');
export const CHAT_FEATURE_PROMPT = ["memory","voice","emotion","gallery","tools","monologue"].map(promptText).join('');
export const CHAT_PROMPT_SEPARATOR = promptText('separator');
export const CHAT_SYSTEM_PROMPT = DEFAULT_CHAT_PERSONA + CHAT_PROMPT_SEPARATOR + CHAT_FEATURE_PROMPT;
