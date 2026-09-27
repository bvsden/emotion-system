// Local touch reading. Reads only the action descriptions in the character's
// reply and the user's message and returns a level; no text leaves this module
// and nothing here is stored except the resulting level. Jev still judges
// receptivity and stop signals; who started the contact is read here too.
//
// ⚠ Adapt before use:
//   - the action format comes from config.js (`actionPattern`, default 【…】);
//   - the word lists below are Chinese and follow one writing style. Pass your
//     own through `readBracketTouch(..., { tiers, falseFriends, bodyPart })`
//     or edit them here. Rule-based by default; a local model (e.g. the
//     embedding model of your memory store) can replace `segmentLevel`, but
//     negation ("没有碰你") and who-did-what need explicit handling.
import { getEmotionConfig } from './config.js';

export const LOCAL_TOUCH_PARSER = 'bracket-v1';

// Strongest tier first; a segment takes the highest tier it matches.
export const TOUCH_TIERS = [
  { level: 'strong', value: 1, words: ['接吻', '吻住', '深吻', '舔', '吮', '咬', '啃', '揉捏', '压在身下', '缠在一起'] },
  { level: 'clear', value: 0.75, words: ['亲', '吻', '抱紧', '搂紧', '紧紧抱', '箍', '拥入', '埋进', '贴紧', '蹭', '抚', '摸', '捧着', '捧住', '揉', '抱起', '托着', '扣在', '按在', '掐', '捂着', '捂住'] },
  { level: 'light', value: 0.5, words: ['抱', '搂', '拥', '贴', '靠在', '靠着', '枕', '牵', '握', '拍', '捋', '顺着', '挂在', '扒', '依偎', '环过', '环住', '覆', '搭在', '拉进', '拢', '抵着', '埋', '扶', '趴在', '划过', '划了', '滑到', '滑过', '别到', '拽', '攥', '穿过你的头发', '捂'] },
  { level: 'faint', value: 0.25, words: ['碰', '戳', '捏', '勾', '拨', '拉了拉'] },
];
// Words that contain a contact character but are not contact.
export const TOUCH_FALSE_FRIENDS = ['亲口', '亲自', '亲手', '亲爱', '亲密', '亲人', '亲身', '抱歉', '抱怨', '拍照', '拍了张', '握手机', '摸索', '拥有'];
// His body parts aimed at her imply contact even without a contact verb
// (e.g. "指尖停在你的手背上").
export const TOUCH_BODY_PART = /手掌|掌心|指尖|指腹|手指|拇指|嘴唇|唇|额头|下巴|鼻尖|怀里|胸口|手臂|臂弯/;
const NEGATION_BEFORE = /(没有?|不|别|未)$/;
const RELEASE = /(松开|放开|推开|收回|退开|抽回|抽开|挪开|撤开)/g;

function segments(text) {
  const out = [];
  const re = new RegExp(getEmotionConfig().actionPattern.source, getEmotionConfig().actionPattern.flags);
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.push(m[1]);
  return out;
}

function clean(segment, falseFriends = TOUCH_FALSE_FRIENDS) {
  let s = segment;
  for (const word of falseFriends) s = s.split(word).join('');
  return s;
}

function segmentLevel(segment, { tiers = TOUCH_TIERS, falseFriends = TOUCH_FALSE_FRIENDS, bodyPart = TOUCH_BODY_PART } = {}) {
  const s = clean(segment, falseFriends);
  for (const tier of tiers) {
    for (const word of tier.words) {
      let from = 0;
      let at;
      while ((at = s.indexOf(word, from)) !== -1) {
        if (!NEGATION_BEFORE.test(s.slice(Math.max(0, at - 2), at))) return tier;
        from = at + word.length;
      }
    }
  }
  if (bodyPart.test(s) && s.includes(getEmotionConfig().addressUser)) return tiers.find(t => t.level === 'light') || null;
  return null;
}

// Only an un-negated "let go" counts ("没松开" still holds her).
function releases(segment) {
  for (const m of segment.matchAll(RELEASE)) {
    if (!NEGATION_BEFORE.test(segment.slice(Math.max(0, m.index - 2), m.index))) return true;
  }
  return false;
}

export function readBracketTouch({ reply = '', userMessage = '' } = {}, lists = {}) {
  let best = null;
  let contactSegments = 0;
  const contactIn = text => {
    let found = 0;
    for (const segment of segments(text)) {
      const tier = segmentLevel(segment, lists);
      // A segment that only lets go ("松开手") is not ongoing contact.
      if (!tier || (releases(segment) && tier.value < 0.75)) continue;
      found += 1;
      if (!best || tier.value > best.value) best = tier;
    }
    return found;
  };
  const fromHim = contactIn(reply);
  const fromHer = contactIn(userMessage);
  contactSegments = fromHim + fromHer;
  // Her message comes first, so contact in her 【】 means she started it.
  const initiator = fromHer ? 'her' : fromHim ? 'him' : 'none';
  return {
    parser: LOCAL_TOUCH_PARSER,
    value: best ? best.value : 0,
    level: best ? best.level : 'none',
    segments: contactSegments,
    initiator,
  };
}
