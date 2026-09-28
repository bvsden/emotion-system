// One scored turn, end to end. This is the only module that talks to the
// network; everything it calls is pure.
import {
  EMOTION_JEV_MODEL,
  EMOTION_QUESTION_SET_VERSION,
  buildEmotionMaterial,
  buildStage1Questions,
  buildStage2Questions,
  emotionContentHash,
  localEmotionAnswers,
} from './questions.js';
import { EMOTION_ENGINE_VERSION, applyEmotionTurn, planEmotionFollowups } from './engine.js';
import { readBracketTouch } from './touch.js';

export const JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

// Retries on 429/5xx (0s, 2s, 10s); other errors throw at once.
export async function callJevDecisions({ apiKey, material, questions, model = EMOTION_JEV_MODEL, url = JEV_DECISIONS_URL, timeoutMs = 30_000 }) {
  let lastError = null;
  for (const wait of [0, 2000, 10000]) {
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state: material, questions }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.answers && typeof data.answers === 'object') return data;
      const error = new Error(String(data?.error?.message || `jev HTTP ${response.status}`).slice(0, 200));
      error.status = response.status;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (err) {
      if (err?.status && err.status !== 429 && err.status < 500) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('jev failed');
}

/**
 * Score one turn and advance the state.
 *
 * @param {object} args
 * @param {object} args.state      current state from createEmotionState() or the last result
 * @param {object} args.turn       { conversationId, messageId, messageTs, thinking, reply,
 *                                   userMessage, previousUserMessage, previousReply,
 *                                   turnKind, waitedMinutes, intimacy? }
 *                                 intimacy (optional): if your app runs a staged intimate scene,
 *                                   pass { stageIndex, stageCount, climaxIndex?, startedAt? } for
 *                                   replies written inside it; arousal then follows the stages.
 * @param {string} [args.apiKey]   OpenRouter key (not needed when `ask` is given)
 * @param {Function} [args.ask]    optional replacement for the Jev call: (material, questions) => { answers, usage }
 * @returns {{ state, record, affectView }} save `record` (no chat text inside) and `state`.
 */
export async function scoreTurn({ state, turn, apiKey, ask }) {
  const material = buildEmotionMaterial(turn);
  const touch = readBracketTouch({ reply: material.reply || '', userMessage: material.user_message || '' });
  const localSignals = { touch, ...localEmotionAnswers({ material, touch }) };
  if (turn.intimacy && typeof turn.intimacy === 'object') {
    const { stageIndex, stageCount, climaxIndex, startedAt } = turn.intimacy;
    localSignals.intimacy = { stageIndex, stageCount, ...(climaxIndex != null ? { climaxIndex } : {}), startedAt: Number(startedAt || 0) };
  }
  const call = ask || ((m, questions) => callJevDecisions({ apiKey, material: m, questions }));

  const stage1 = await call(material, buildStage1Questions({ turnKind: turn.turnKind || 'normal_reply', thinkingEmpty: !material.thinking.length }));
  const followupPlan = planEmotionFollowups(state, { ...stage1.answers, ...localSignals.answers }, {
    questionSet: EMOTION_QUESTION_SET_VERSION, turnKind: turn.turnKind || 'normal_reply', localTouch: touch.value, localIntimacy: localSignals.intimacy || null,
  });
  const stage2 = followupPlan.needed ? await call(material, buildStage2Questions(followupPlan, material)) : null;

  const record = {
    questionSet: EMOTION_QUESTION_SET_VERSION,
    engineVersion: EMOTION_ENGINE_VERSION,
    conversationId: String(turn.conversationId || ''),
    messageId: String(turn.messageId || ''),
    messageTs: Number(turn.messageTs || Date.now()),
    turnKind: turn.turnKind || 'normal_reply',
    contentHash: emotionContentHash({ reply: turn.reply || '', thinking: turn.thinking || '' }),
    scoredAt: Date.now(),
    usage: [stage1?.usage, stage2?.usage].filter(Boolean),
    answers: stage1.answers,
    stage2Answers: stage2?.answers || {},
    followupPlan,
    localSignals,
  };
  const result = applyEmotionTurn(state, record);
  record.engine = result.details;
  record.affectView = result.affectView;
  return { state: result.state, record, affectView: result.affectView };
}
