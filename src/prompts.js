// The only texts the character ever sees from this system. Each lists options
// and never gives an order; the stable system prompt should say once that
// they are readings, not instructions (see README).
//
// Placeholders: {user} / {userName} come from config.js; {可用选项} and
// {等待时长} are filled per event.
import { fillPersona } from './config.js';

export const EMOTION_PROMPT_DEFAULTS = Object.freeze({
  care: '很心疼{user}。可用：{可用选项}。',
  arousal: '身体亲近感很高。可用：开启亲密流程。',
  avoidance: '{userName}处在负面情绪中。请自检判断自己是否正在回避冲突',
  longingWake: '等了 {等待时长}，思念很高。可用：{可用选项}。',
});

const cleanText = (value, max) => String(value ?? '')
  .replace(/[<>\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

export function normalizeEmotionPrompts(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const key of Object.keys(EMOTION_PROMPT_DEFAULTS)) {
    out[key] = cleanText(source[key], 200) || EMOTION_PROMPT_DEFAULTS[key];
  }
  return out;
}

export function renderEmotionPrompt(kind, data = {}, custom = {}) {
  const prompts = fillPersona(normalizeEmotionPrompts(custom));
  if (kind === 'care') {
    const options = Array.isArray(data.options) ? data.options.map(item => cleanText(item, 30)).filter(Boolean).slice(0, 4) : [];
    return options.length ? prompts.care.replaceAll('{可用选项}', options.join('、')) : '';
  }
  if (kind === 'arousal') return prompts.arousal;
  // The fixed prefix keeps the character from mistaking it for its own thought.
  if (kind === 'avoidance') return `系统提醒：${prompts.avoidance.replace(/^系统提醒[：:]\s*/, '')}`;
  if (kind === 'longingWake') {
    const duration = cleanText(data.duration, 60);
    const options = Array.isArray(data.options) ? data.options.map(item => cleanText(item, 40)).filter(Boolean).slice(0, 6) : [];
    return prompts.longingWake
      .replaceAll('{等待时长}', duration)
      .replaceAll('{可用选项}', options.join('、'));
  }
  return '';
}
