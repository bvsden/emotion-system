// Persona and format settings shared by every module.
//
// ⚠ Adapt these to your own setup before use:
//   - `character` / `user`: how the question text refers to the AI character
//     and to you. Pronouns ("他" / "她") or names both work.
//   - `userName`: the name used in the avoidance reminder shown to the character.
//   - `addressUser`: how the character addresses you inside action descriptions
//     (usually "你"); used by the local touch reader.
//   - `actionPattern` / `actionLabel`: how action descriptions are marked in
//     your chats. The default reads 【…】. If you write *…* or （…）, change
//     both: the pattern is used by the local touch reader, the label is shown
//     to Jev in the touch question.
//   - `runtimeEventTag`: tag name for runtime events injected to the character.

const DEFAULTS = Object.freeze({
  character: '他',
  user: '她',
  userName: '她',
  addressUser: '你',
  actionPattern: /【([^】]{1,200})】/g,
  actionLabel: '【】',
  runtimeEventTag: 'runtime_event',
});

let current = { ...DEFAULTS };

export function configureEmotionSystem(options = {}) {
  const next = { ...current, ...options };
  if (!(next.actionPattern instanceof RegExp) || !next.actionPattern.global) {
    throw new Error('actionPattern must be a global RegExp with one capture group, e.g. /\\*([^*]{1,200})\\*/g');
  }
  current = next;
  return getEmotionConfig();
}

export function resetEmotionConfig() {
  current = { ...DEFAULTS };
}

export function getEmotionConfig() {
  return { ...current };
}

// Replaces {char} / {user} / {userName} / {addr} in question and prompt text.
export function fillPersona(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll('{char}', current.character)
      .replaceAll('{user}', current.user)
      .replaceAll('{userName}', current.userName)
      .replaceAll('{addr}', current.addressUser);
  }
  if (Array.isArray(value)) return value.map(fillPersona);
  if (value && typeof value === 'object' && !(value instanceof RegExp)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPersona(v)]));
  }
  return value;
}
