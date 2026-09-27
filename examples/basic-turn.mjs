// Minimal end-to-end example.
//
//   node examples/basic-turn.mjs                  offline, canned Jev answers
//   OPENROUTER_API_KEY=sk-... node examples/basic-turn.mjs   real Jev call
//
// The example turn is invented. Replace it with a real turn from your app.
import { configureEmotionSystem, createEmotionState, renderEmotionPrompt, scoreTurn } from '../src/index.js';

// ⚠ Adapt to your setup: names or pronouns, and how actions are written.
configureEmotionSystem({
  character: '他',
  user: '她',
  userName: '她',
  addressUser: '你',
  actionPattern: /【([^】]{1,200})】/g,
  actionLabel: '【】',
});

const turn = {
  conversationId: 'demo',
  messageId: 'm1',
  messageTs: Date.now(),
  turnKind: 'normal_reply',
  userMessage: '今天加班到好晚……好累',
  thinking: '她加班到这么晚，声音都哑了。心疼。想让她先吃点东西再睡。',
  reply: '辛苦了。【把你拉过来抱住】先吃点热的，吃完就睡，好不好？',
};

// Offline stand-in for Jev: returns a plausible distribution for every question.
function cannedAnswers(questions) {
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      answers[key] = { noul: ['gate_OtherPain', 'body_any', 'touch_receptive'].includes(key) ? 0.9 : 0.05 };
    } else {
      const options = Object.keys(q.criteria);
      const pick = key === 'level_care' ? 'clear' : key === 'level_warmth' ? 'clear' : key === 'texture' ? 'tender_care'
        : key === 'reply_ending' ? 'care' : key.endsWith('_target') ? 'her' : key.endsWith('_novelty') ? 'new_event'
        : key.endsWith('_relation') ? 'supports' : key.endsWith('_evidence') ? 't2' : key.endsWith('_label') ? 'care'
        : options.includes('not_mentioned') ? 'not_mentioned' : options[0];
      answers[key] = { probabilities: { [pick]: 0.9, [options.find(o => o !== pick)]: 0.1 }, confidence: 0.9 };
    }
  }
  return { answers, usage: { input_tokens: 0, cost: 0 } };
}

const apiKey = process.env.OPENROUTER_API_KEY;
const ask = apiKey ? undefined : (material, questions) => cannedAnswers(questions);

let state = createEmotionState('demo');
const result = await scoreTurn({ state, turn, apiKey, ask });
state = result.state;

console.log(apiKey ? '— live Jev —' : '— offline (canned answers) —');
console.log('headline:', result.affectView.titleKey || result.affectView.ingredients);
console.log('rows:', result.affectView.items.map(i => `${i.label} ${i.direction === 'up' ? '↑' : '↓'}${i.degree}`).join('  '));
console.log('touch (local):', result.record.localSignals.touch);
console.log('care urgency:', state.careUrgency.toFixed(2));
console.log('care prompt example:', renderEmotionPrompt('care', { options: ['电话', '写信'] }));
console.log('record keys (no chat text):', Object.keys(result.record).join(', '));
