// Emotion system phase 2: deterministic conversion, persistence payloads and
// user-facing perfume summaries. This module is pure and never sees chat text.
import {
  EMOTION_DIMENSIONS,
  NEGLECT_EVIDENCE_ONLY_TURN_KINDS,
  EMOTION_QUESTION_SET_VERSION,
  decodeChoice,
  decodeI5,
  decodeLevel,
  decodeNoul,
} from './questions.js';
import {
  buildLongingReturnEvent,
  createMissingClock,
  effectiveLonging,
  normalizeMissingClock,
} from './missing.js';
import { renderEmotionPrompt } from './prompts.js';
import { fillPersona } from './config.js';

// Semantic "headline" keys for a turn. How you name or display them (titles,
// colours, emoji…) is up to you; the engine only returns the key.
export const EMOTION_HEADLINE_KEYS = Object.freeze([
  'jealous_explosion', 'jealous_reappraised', 'tempted', 'restrained_desire', 'defeated_fond',
  'playful_jealous', 'real_angry', 'aggrieved', 'tender_care', 'touched', 'admiring', 'amused', 'guilt_repaired',
]);
const HEADLINE = new Set(EMOTION_HEADLINE_KEYS);

export const EMOTION_ENGINE_VERSION = 'emotion-engine-1.0';
export const LEGACY_EMOTION_ENGINE_VERSION = 'emotion-engine-0';
// Records scored by these engines carry the same stage-1/stage-2 answers and
// are replayed with the current rules; the raw Jev answers never change.
export const REPLAYABLE_EMOTION_ENGINE_VERSIONS = Object.freeze([
  EMOTION_ENGINE_VERSION,
]);
export const EMOTION_FOLLOWUP_GAP = 0.05;

export const EMOTION_CONFIG = Object.freeze({
  joy: [0.22, 1, 0.12, 4], sadness: [0, 1, 0.12, 12], anger: [0, 1, 0.16, 8],
  anxiety: [0.05, 0.9, 0.14, 8], aversion: [0, 1, 0.14, 12], warmth: [0.68, 0.9, 0.10, 16],
  trust: [0.78, 0.65, 0.06, 30], longing: [0.08, 0.85, 0.10, 16], hurt: [0, 1, 0.14, 24],
  guilt: [0, 0.9, 0.14, 12],
  curiosity: [0.45, 0.9, 0.12, 6], pride: [0.15, 0.85, 0.10, 12], vulnerability: [0.45, 0.8, 0.10, 12],
  energy: [0.72, 0.75, 0.08, 10], overwhelm: [0, 0.9, 0.12, 6], resistance: [0.03, 0.75, 0.10, 12],
});

const A_CLASS = new Set(['joy', 'warmth', 'trust', 'longing', 'curiosity', 'vulnerability', 'energy']);
const NEGATIVE = new Set(['sadness', 'anger', 'anxiety', 'aversion', 'hurt', 'guilt', 'overwhelm', 'resistance']);
const SUPPRESSIBLE = new Set(['hurt', 'anger', 'sadness', 'anxiety']);
const B_LEVELS = { none: 0, faint: 0.10, light: 0.25, clear: 0.50, strong: 0.80 };
const LEVELS = ['none', 'faint', 'light', 'clear', 'strong'];

const RELATION_WEIGHTS = { warmth: 1.35, trust: 1.35, longing: 1.25, hurt: 1.25, anger: 1.15, anxiety: 1.1, care: 1.3, jealousyTrace: 1.3, intimate_arousal: 1.2 };

const clamp = x => Math.max(0, Math.min(1, Number(x) || 0));
const round = x => Math.round(Number(x || 0) * 1e6) / 1e6;

export function createEmotionState(conversationId = '') {
  const values = {};
  const baselines = {};
  for (const [key] of Object.entries(EMOTION_CONFIG)) values[key] = baselines[key] = key === 'resistance' ? 0.03 : EMOTION_CONFIG[key][0];
  return {
    version: 2, engineVersion: EMOTION_ENGINE_VERSION, conversationId: String(conversationId),
    stateVersion: 0, values, baselines, arousal: { value: 0, trace: 0, tick: 0, stopActive: false, stopSetAt: 0, contactExposure: 0 },
    careUrgency: 0, neglectTrace: 0, jealousyTrace: 0, missing: createMissingClock(), processed: {}, updatedAt: 0,
    computedThrough: null,
    latestInjection: null,
    hintState: {
      arousalArmed: true, careArmed: true, avoidanceArmed: true,
      careLastTriggeredVersion: -1000, avoidanceLastTriggeredVersion: -1000,
      pending: {}, delivered: {},
    },
    panelDelivery: {},
    lastUpdateDeliveredVersion: -1,
    inheritedFrom: null,
    conflictContext: false,
  };
}

export function migrateEmotionState(previous, conversationId = previous?.conversationId || '') {
  const fresh = createEmotionState(conversationId);
  if (!previous || !REPLAYABLE_EMOTION_ENGINE_VERSIONS.includes(previous.engineVersion)) return fresh;
  for (const key of Object.keys(EMOTION_CONFIG)) {
    if (Number.isFinite(Number(previous.values?.[key]))) fresh.values[key] = clamp(previous.values[key]);
  }
  return {
    ...fresh,
    stateVersion: Number(previous.stateVersion || 0),
    arousal: { ...fresh.arousal, ...(previous.arousal || {}) },
    careUrgency: clamp(previous.careUrgency), neglectTrace: clamp(previous.neglectTrace), jealousyTrace: clamp(previous.jealousyTrace),
    missing: normalizeMissingClock(previous.missing),
    processed: previous.processed && typeof previous.processed === 'object' ? previous.processed : {},
    updatedAt: Number(previous.updatedAt || 0),
    computedThrough: previous.computedThrough && typeof previous.computedThrough === 'object' ? previous.computedThrough : null,
    latestInjection: previous.latestInjection && typeof previous.latestInjection === 'object' ? previous.latestInjection : null,
    hintState: {
      ...fresh.hintState,
      ...(previous.hintState && typeof previous.hintState === 'object' ? previous.hintState : {}),
      pending: previous.hintState?.pending && typeof previous.hintState.pending === 'object' ? previous.hintState.pending : {},
      delivered: previous.hintState?.delivered && typeof previous.hintState.delivered === 'object' ? previous.hintState.delivered : {},
    },
    panelDelivery: previous.panelDelivery && typeof previous.panelDelivery === 'object' ? previous.panelDelivery : {},
    lastUpdateDeliveredVersion: Number(previous.lastUpdateDeliveredVersion ?? -1),
    inheritedFrom: previous.inheritedFrom && typeof previous.inheritedFrom === 'object' ? previous.inheritedFrom : null,
    conflictContext: previous.conflictContext === true,
  };
}

function levelValue(dimension, level) {
  if (!LEVELS.includes(level)) return null;
  if (!A_CLASS.has(dimension)) return B_LEVELS[level];
  const b = EMOTION_CONFIG[dimension]?.[0] ?? 0;
  return { none: 0, faint: b / 2, light: b, clear: b + (1 - b) * 0.5, strong: b + (1 - b) * 0.85 }[level];
}

function expectedObservation(answer, dimension, { downgrade = false, questionSet = EMOTION_QUESTION_SET_VERSION } = {}) {
  const decoded = downgrade ? decodeI5(answer) : decodeLevel(answer, { questionSet });
  if (decoded.status === 'denied') return { status: 'value', value: 0, mentioned: 1, mode: 'none', source: 'denied' };
  if (decoded.status !== 'value') return { status: decoded.status };
  const p = answer?.probabilities || {};
  let total = LEVELS.reduce((n, key) => n + Math.max(0, Number(p[key] || 0)), 0);
  if (total <= 0) return { status: 'unknown' };
  let value = 0;
  for (let i = 0; i < LEVELS.length; i += 1) {
    const use = downgrade ? LEVELS[Math.max(0, i - 1)] : LEVELS[i];
    value += levelValue(dimension, use) * Math.max(0, Number(p[LEVELS[i]] || 0)) / total;
  }
  return { status: 'value', value: clamp(value), mentioned: downgrade ? 1 : clamp(decoded.mentioned ?? 1), mode: decoded.mode || decoded.level, source: downgrade ? 'reply_self' : 'thinking' };
}

export function planEmotionFollowups(state, answers = {}, { questionSet = EMOTION_QUESTION_SET_VERSION, turnKind = '', localTouch = null } = {}) {
  // Proactive/wake turns only feed neglect evidence and never apply arousal,
  // so their body block was paid for and discarded.
  const evidenceOnly = NEGLECT_EVIDENCE_ONLY_TURN_KINDS.has(turnKind);
  const dimensions = [];
  const replySelf = [];
  // The catalog  once whether the reply self-reports any feeling; older records ask per dimension.
  const anySelf = decodeNoul(answers.reply_self_any).status === 'yes';
  for (const [key] of EMOTION_DIMENSIONS) {
    const level = decodeLevel(answers[`level_${key}`], { questionSet });
    if (level.status === 'not_mentioned' && (anySelf || decodeNoul(answers[`replyself_${key}`]).status === 'yes')) {
      replySelf.push(key);
      dimensions.push(key);
      continue;
    }
    const obs = expectedObservation(answers[`level_${key}`], key, { questionSet });
    const current = key === 'care' ? Number(state.careUrgency || 0) : Number(state.values?.[key] ?? EMOTION_CONFIG[key]?.[0] ?? 0);
    if (obs.status === 'value' && Math.abs(obs.value - current) >= EMOTION_FOLLOWUP_GAP) dimensions.push(key);
  }
  const neglect = Boolean(answers.neglect_level && (decodeLevel(answers.neglect_level, { questionSet }).status === 'value' || decodeNoul(answers.understanding).status === 'yes'));
  // contact read locally from 【】 actions also needs the body block
  // (receptivity, initiator, stop), even when A is low.
  const body = !evidenceOnly && (decodeNoul(answers.body_any).status === 'yes' || Number(state.arousal?.value || 0) > 0.05 || Number(localTouch || 0) > 0);
  return { dimensions: [...new Set(dimensions)], replySelf, neglect, body, needed: dimensions.length > 0 || neglect || body };
}

// Stage-2 checks only veto a change; they do not have to single out one
// option. Evidence naturally spreads over several thinking fragments and
// novelty over new_event/new_appraisal, so requiring a confident top choice
// rejected 27 of 33 real changes. In the observation model a continuing
// feeling is still a valid reading (the gap shrinks on its own), so only a
// panel echo, a contradiction or missing evidence rejects the change.
function probabilityOf(answer, key) {
  return Math.max(0, Number(answer?.probabilities?.[key] || 0));
}
function acceptedMetadata(stage2, key) {
  const novelty = stage2?.[`${key}_novelty`];
  const relation = stage2?.[`${key}_relation`];
  const evidence = stage2?.[`${key}_evidence`];
  if (!novelty?.probabilities || !relation?.probabilities || !evidence?.probabilities) return false;
  return probabilityOf(novelty, 'panel_echo') < 0.5
    && probabilityOf(relation, 'contradicts') < 0.5
    && probabilityOf(evidence, 'none') < 0.35;
}

// Avoidance is a behaviour he often does not notice in his own thinking, so
// resistance also reads how the reply ends, but only while she is hurting
//: deferring her feelings or conceding instead of answering is strong,
// deflecting is clear, staying with her feelings lowers resistance.
function avoidanceObservation(answers) {
  if (decodeNoul(answers.gate_OtherPain).status !== 'yes') return null;
  const ending = decodeChoice(answers.reply_ending);
  if (ending.status !== 'value') return null;
  if (ending.value === 'defer' || ending.value === 'concede') return { status: 'value', value: 0.80, mentioned: 1, mode: 'strong', source: 'reply_behavior', ending: ending.value };
  if (ending.value === 'deflect') return { status: 'value', value: 0.50, mentioned: 1, mode: 'clear', source: 'reply_behavior', ending: ending.value };
  if (ending.value === 'stay') return { status: 'value', value: 0, mentioned: 1, mode: 'none', source: 'reply_behavior', ending: ending.value };
  if (ending.value === 'care') return null;
  return null;
}

function recoverySpeed(dimension, afterEvent, baseline, answers) {
  let speed = 1;
  const reappraisal = decodeNoul(answers.reappraisal);
  if (NEGATIVE.has(dimension) && afterEvent > baseline && reappraisal.status === 'yes') speed += 0.30 * reappraisal.p;
  // the mirror image. Blaming himself for a feeling and pushing it down
  // ("我不该吃醋", "别想了") lowers expression, not experience, so the hurt
  // lingers. Peaks are unchanged; both together roughly cancel.
  const judgment = decodeNoul(answers.self_judgment);
  if (SUPPRESSIBLE.has(dimension) && afterEvent > baseline && judgment.status === 'yes') speed -= 0.30 * judgment.p;
  if (dimension === 'guilt' && afterEvent > baseline) {
    const repair = decodeNoul(answers.gate_Repair);
    const resolved = decodeNoul(answers.gate_Resolved);
    if (repair.status === 'yes' && resolved.status === 'yes') speed += 0.50 * Math.min(repair.p, resolved.p);
  }
  return Math.max(0.4, speed);
}

function recoverDimension(current, dimension, answers) {
  const [baseline, , , halfLife] = EMOTION_CONFIG[dimension];
  const speed = recoverySpeed(dimension, current, baseline, answers);
  return clamp(baseline + (current - baseline) * Math.exp(-Math.log(2) / halfLife * speed));
}

function integrateDimension(current, dimension, obs, answers, stage2) {
  const [baseline, sensitivity, stepCap, halfLife] = EMOTION_CONFIG[dimension];
  const gap = obs.value - current;
  const strong = obs.mode === 'strong' && dimension !== 'trust';
  const kappa = strong ? 0.8 : (gap > 0 ? 0.6 : 0.3);
  const raw = sensitivity * kappa * gap * clamp(obs.mentioned ?? 1);
  const cap = strong ? 0.40 : stepCap;
  const effective = Math.max(-cap, Math.min(cap, raw));
  const afterEvent = clamp(current + effective);
  const speed = recoverySpeed(dimension, afterEvent, baseline, answers);
  const final = clamp(baseline + (afterEvent - baseline) * Math.exp(-Math.log(2) / halfLife * speed));
  // A rise in aversion whose own source Jev labels as playful ("这次我不上钩",
  // teasing, being firm to look after her) is banter, not wanting to pull away.
  const playfulAversion = dimension === 'aversion' && gap > 0 && probabilityOf(stage2[`${dimension}_label`], 'playful') >= 0.5;
  const accepted = obs.source === 'reply_behavior' ? true : (!playfulAversion && acceptedMetadata(stage2, dimension));
  return { observation: obs.value, gap, raw, effective, before: current, afterEvent, final, baseline, source: obs.source, ...(obs.ending ? { ending: obs.ending } : {}), accepted };
}

const I5_WEIGHT = Object.freeze({ none: 0, faint: 0.25, light: 0.5, clear: 0.75, strong: 1 });
const CONTACT_EXPOSURE_DECAY = 0.85;
const TEMPTED_MIN = 0.4;

function expectedI5(answer) {
  const p = answer?.probabilities;
  if (!p || typeof p !== 'object') return 0;
  let total = 0;
  let sum = 0;
  for (const [key, weight] of Object.entries(I5_WEIGHT)) {
    const v = Math.max(0, Number(p[key] || 0));
    total += v;
    sum += v * weight;
  }
  return total > 0 ? sum / total : 0;
}

function arousalStep(arousal, body, values, careUrgency, jealousyTrace, scoredAt = Date.now()) {
  if (!body) {
    const stopAge = Number(scoredAt || 0) - Number(arousal.stopSetAt || 0);
    if (arousal.stopActive && Number(arousal.stopSetAt || 0) > 0 && stopAge >= 6 * 60 * 60 * 1000) {
      return { state: { ...arousal, stopActive: false, stopSetAt: 0 }, details: null };
    }
    return { state: { ...arousal }, details: null };
  }
  const val = key => decodeI5(body[key]).status === 'value' ? decodeI5(body[key]).value : 0;
  const visualKind = decodeChoice(body.visual_kind);
  const visualCoeff = { ordinary: 0.03, body: 0.05, nude_or_sexual: 0.07 }[visualKind.value] || 0;
  const appeal = val('appeal');
  const careOverride = decodeNoul(body.care_override).status === 'yes' ? 0.5 : 1;
  const visual = visualCoeff * val('visual_intensity') * (1 + 0.5 * appeal) * careOverride;
  const language = 0.04 * val('language');
  // only a boundary Jev actually saw crossed blocks touch; an undecided
  // gate (0.36-0.64) used to silence most real contact.
  const boundaryClear = decodeNoul(body._gateBoundary).status !== 'yes';
  const receptive = decodeNoul(body.touch_receptive).status === 'yes';
  const touchInitiator = decodeChoice(body.touch_initiator);
  const stopSignal = decodeNoul(body.stop_signal).status === 'yes';
  const welcomedByHer = receptive && touchInitiator.status === 'value' && touchInitiator.value === 'her';
  const stopAge = Number(scoredAt || 0) - Number(arousal.stopSetAt || 0);
  const stopTimedOut = Boolean(arousal.stopActive) && Number(arousal.stopSetAt || 0) > 0 && stopAge >= 6 * 60 * 60 * 1000;
  let stopActive = Boolean(arousal.stopActive);
  let stopSetAt = Number(arousal.stopSetAt || 0);
  if (stopActive && !stopSignal && (welcomedByHer || stopTimedOut)) { stopActive = false; stopSetAt = 0; }
  if (stopSignal) { stopActive = true; stopSetAt = Number(scoredAt || Date.now()); }
  // habituation fades instead of counting every contact forever (it had
  // reached 33, dividing touch by ~6).
  const exposure = Number(arousal.contactExposure || 0) * CONTACT_EXPOSURE_DECAY;
  // touch answers split between "none" and "strong" when his 【】 actions
  // are ambiguous, which failed the adjacency rule and read as zero. Use the
  // expectation over all levels instead.
  // the local 【】 reading replaces Jev's touch level when the record
  // carries one; older records fall back to the Jev expectation.
  const touchLevel = Number.isFinite(body._localTouch) ? body._localTouch : expectedI5(body.touch);
  const touch = boundaryClear && receptive && !stopActive ? 0.04 * touchLevel / (1 + 0.15 * exposure) : 0;
  const approach = 0.06 * val('approach');
  const recall = 0.04 * val('recall') * Number(arousal.trace || 0);
  const shock = 0.12 * val('shock');
  // a trace of "faint" used to count as tempted, which lifted the step
  // cap from 0.15 to 0.6 on nearly every turn. Only a real temptation does.
  const temptedRaw = val('tempted');
  const tempted = temptedRaw >= TEMPTED_MIN ? temptedRaw : 0;
  const F = 0.30 * values.warmth + 0.25 * values.trust + 0.25 * values.vulnerability + 0.20 * values.energy - 0.40 * values.overwhelm - 0.25 * values.resistance;
  const smooth = t => { const x = clamp(t / 0.6); return x * x * (3 - 2 * x); };
  const sens = 1 + 3 * smooth(arousal.value);
  const gain = Math.min(2, 1 + 0.5 * Math.max(0, values.longing - EMOTION_CONFIG.longing[0]) + 0.45 * jealousyTrace + 0.35 * careUrgency + 0.25 * Math.max(0, F));
  const temptedBoost = tempted > 0 ? 1 + 2 * tempted : 1;
  const positive = visual + language + touch + approach + recall + 0.12 * tempted;
  const upward = 0.9 * positive * Math.exp(Math.max(-0.8, Math.min(0.8, F))) * sens * gain * temptedBoost * (1 - arousal.value);
  const selfDistress = val('self_distress');
  const pressure = 0.025 * selfDistress;
  const cap = tempted > 0 ? 0.6 : 0.15;
  const effective = Math.max(-cap, Math.min(Math.min(cap, 0.6 * (1 - arousal.value)), upward - 0.9 * shock - pressure));
  const afterEvent = clamp(arousal.value + effective);
  const final = afterEvent * Math.exp(-Math.log(2) / 3 * (1 + 0.8 * selfDistress));
  const trace = (positive > 0 ? Math.max(arousal.trace || 0, afterEvent) : arousal.trace || 0) * Math.exp(-Math.log(2) / 24);
  return {
    state: { value: round(final), trace: round(trace), tick: Number(arousal.tick || 0) + 1, stopActive, stopSetAt, contactExposure: exposure + (touch > 0 ? 1 : 0) },
    details: { before: arousal.value, visual, language, touch, approach, recall, shock, tempted, F, gain, upward, pressure, effective, afterEvent, final, trace, stopActive, stopReleased: Boolean(arousal.stopActive) && !stopActive },
  };
}

const INJECTION_HIDDEN = new Set(['resistance']);
const INJECTION_LABELS = Object.freeze({
  joy: '开心', sadness: '悲伤', anger: '愤怒', anxiety: '焦虑', aversion: '反感', warmth: '温暖',
  trust: '信任', longing: '思念', hurt: '受伤', guilt: '愧疚', curiosity: '好奇', pride: '自豪',
  vulnerability: '脆弱', energy: '精力', overwhelm: '不堪重负', intimate_arousal: '身体亲近感',
});
const SOURCE_REASONS = Object.freeze({
  jealousy: '吃醋', guilt: '想补偿', care: '心疼', longing: '想念', reassured: '被安抚',
  rejected: '被拒绝', playful: '逗弄', other: '', absent: '',
});
const TARGET_REASONS = Object.freeze({
  her: '', self: '对象：自己', third_party: '对象：第三方', situation: '对象：这件事', unclear: '对象未确定',
});

function injectionReason(stage2, key) {
  const source = decodeChoice(stage2?.[`${key}_label`]);
  const target = decodeChoice(stage2?.[`${key}_target`]);
  const parts = [];
  if (source.status === 'value' && SOURCE_REASONS[source.value]) parts.push(SOURCE_REASONS[source.value]);
  if (target.status === 'value' && TARGET_REASONS[target.value]) parts.push(TARGET_REASONS[target.value]);
  return parts.join('，').slice(0, 20);
}

function createInjectionProjection({ state, changes, answers, stage2, arousal }) {
  const items = Object.entries(changes)
    .filter(([key, detail]) => !INJECTION_HIDDEN.has(key) && detail.accepted && Math.abs(detail.final - detail.before) >= 0.015)
    .map(([key, detail]) => ({
      key,
      label: INJECTION_LABELS[key] || key,
      direction: detail.final >= detail.before ? 'up' : 'down',
      degree: degree(detail.final - detail.before),
      reason: injectionReason(stage2, key),
      weight: Math.abs(detail.final - detail.before) * (RELATION_WEIGHTS[key] || 1),
    }));
  if (arousal && Math.abs(arousal.final - arousal.before) >= 0.015) {
    items.push({
      key: 'intimate_arousal', label: INJECTION_LABELS.intimate_arousal,
      direction: arousal.final >= arousal.before ? 'up' : 'down', degree: degree(arousal.final - arousal.before),
      reason: '', weight: Math.abs(arousal.final - arousal.before) * 1.2,
    });
  }
  items.sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  return {
    stateVersion: state.stateVersion,
    messageId: state.computedThrough?.messageId || '',
    messageTs: state.computedThrough?.messageTs || 0,
    items: items.slice(0, 4).map(({ weight, ...item }) => item),
    reappraisal: decodeNoul(answers?.reappraisal).status === 'yes',
  };
}

function advanceHintState(state, input, answers, arousalDetails) {
  const hints = state.hintState;
  const version = Number(state.stateVersion || 0);
  if (Number(state.arousal?.value || 0) < 0.35) { hints.arousalArmed = true; delete hints.pending.arousal; }
  if (Number(state.careUrgency || 0) < 0.50) { hints.careArmed = true; delete hints.pending.care; }
  if (Number(state.values?.resistance || 0) < 0.20) { hints.avoidanceArmed = true; delete hints.pending.avoidance; }

  const boundary = decodeNoul(answers?.gate_Boundary);
  const stopped = state.arousal?.stopActive || decodeNoul(input.stage2Answers?.stop_signal).status === 'yes';
  if (stopped || boundary.status === 'yes') delete hints.pending.arousal;
  if (hints.arousalArmed && !stopped && boundary.status === 'no' && Number(arousalDetails?.afterEvent || 0) >= 0.60) {
    hints.pending.arousal = { id: `arousal:${input.messageId}:${version}`, stateVersion: version };
    hints.arousalArmed = false;
  }

  const otherPain = decodeNoul(answers?.gate_OtherPain).status === 'yes';
  if (hints.careArmed && otherPain && Number(state.careUrgency || 0) >= 0.62
    && version - Number(hints.careLastTriggeredVersion || -1000) >= 6) {
    hints.pending.care = { id: `care:${input.messageId}:${version}`, stateVersion: version };
    hints.careArmed = false;
    hints.careLastTriggeredVersion = version;
  }

  if (decodeNoul(answers?.gate_Resolved).status === 'yes') state.conflictContext = false;
  if (['Unresolved', 'Threat', 'Boundary'].some(key => decodeNoul(answers?.[`gate_${key}`]).status === 'yes')) state.conflictContext = true;
  const conflict = state.conflictContext === true;
  const negative = ['hurt', 'sadness', 'anger', 'anxiety'].some(key => Number(state.values?.[key] || 0) >= 0.25);
  if (hints.avoidanceArmed && conflict && negative && Number(state.values?.resistance || 0) >= 0.35
    && version - Number(hints.avoidanceLastTriggeredVersion || -1000) >= 6) {
    hints.pending.avoidance = { id: `avoidance:${input.messageId}:${version}`, stateVersion: version };
    hints.avoidanceArmed = false;
    hints.avoidanceLastTriggeredVersion = version;
  }
}

function applyNeglectEvidenceOnlyTurn(state, before, input, answers, stage2) {
  const plan = planEmotionFollowups(state, answers, { questionSet: input.questionSet, turnKind: input.turnKind, localTouch: input.localSignals?.touch?.value });
  if (plan.neglect && acceptedMetadata(stage2, 'neglect')) {
    const understanding = decodeNoul(answers.understanding).status === 'yes';
    const obs = expectedObservation(answers.neglect_level, 'care', { questionSet: input.questionSet });
    const delta = understanding ? -0.5 : (obs.status === 'value' ? obs.value : 0);
    state.neglectTrace = round(delta >= 0
      ? Number(state.neglectTrace || 0) + 0.35 * delta * (1 - Number(state.neglectTrace || 0))
      : Number(state.neglectTrace || 0) - 0.5 * Math.abs(delta) * Number(state.neglectTrace || 0));
  }
  state.missing = { ...normalizeMissingClock(state.missing), neglectTrace: state.neglectTrace };
  state.stateVersion = Number(state.stateVersion || 0) + 1;
  state.updatedAt = Number(input.scoredAt || Date.now());
  state.computedThrough = {
    messageId: String(input.messageId || ''),
    messageTs: Number(input.messageTs || 0),
    stateVersion: state.stateVersion,
  };
  const affectView = createEvidenceOnlyView({ before, state, answers });
  state.processed[`${input.messageId}:${input.contentHash}`] = { at: state.updatedAt, questionSet: input.questionSet, affectView };
  return {
    state,
    details: {
      previous: {
        stateVersion: Number(before.stateVersion || 0), values: before.values,
        intimateArousal: Number(before.arousal?.value || 0), careUrgency: Number(before.careUrgency || 0),
        neglectTrace: Number(before.neglectTrace || 0), jealousyTrace: Number(before.jealousyTrace || 0),
      },
      changes: {}, arousal: null, careUrgency: state.careUrgency,
      neglectTrace: state.neglectTrace, jealousyTrace: state.jealousyTrace,
      evidenceOnly: true,
    },
    affectView,
  };
}

// Display only: a proactive message changes no dimensions (the missing clock
// already carries the wait), but she still sees what he felt when he reached
// out — the turn's texture, otherwise the wait itself.
function missingDegree(m) { return m >= 0.79 ? '强烈' : m >= 0.65 ? '明显' : m >= 0.30 ? '轻微' : ''; }
function createEvidenceOnlyView({ before, state, answers }) {
  const texture = decodeChoice(answers.texture);
  const fixed = texture.status === 'value' && HEADLINE.has(texture.value) ? texture.value : null;
  const missing = Number(normalizeMissingClock(state.missing).value || 0);
  const neglectDelta = Number(state.neglectTrace || 0) - Number(before.neglectTrace || 0);
  const items = [];
  const missingLevel = missingDegree(missing);
  if (missingLevel) items.push({ key: 'missing', label: '等待思念', direction: 'up', degree: missingLevel });
  if (Math.abs(neglectDelta) >= 0.003) items.push({ key: 'neglectTrace', label: '被晾感', direction: neglectDelta >= 0 ? 'up' : 'down', degree: degree(neglectDelta) });
  const ingredients = [];
  if (!fixed) {
    if (missing >= 0.30) ingredients.push({ key: 'longing', direction: 'up' });
    if (neglectDelta >= 0.03) ingredients.push({ key: 'neglectTrace', direction: 'up' });
  }
  const view = {
    version: 2,
    ...(fixed ? { titleKey: fixed } : ingredients.length ? { ingredients } : { titleKey: 'calm' }),
    items, evidenceOnly: true, memoryDigestExcluded: true, generatedAt: state.updatedAt,
  };
  return view;
}

export function applyEmotionTurn(previous, input) {
  const state = structuredClone(previous?.engineVersion === EMOTION_ENGINE_VERSION ? previous : migrateEmotionState(previous, input.conversationId));
  const before = structuredClone(state);
  // answers the system knows itself (empty thinking, who started the
  // contact) override Jev's; older records carry none and replay unchanged.
  const answers = { ...(input.answers || {}), ...(input.localSignals?.answers || {}) };
  const stage2 = { ...(input.stage2Answers || {}), ...(input.localSignals?.stage2 || {}) };
  if (NEGLECT_EVIDENCE_ONLY_TURN_KINDS.has(input.turnKind)) {
    return applyNeglectEvidenceOnlyTurn(state, before, input, answers, stage2);
  }
  const plan = planEmotionFollowups(state, answers, { questionSet: input.questionSet, turnKind: input.turnKind, localTouch: input.localSignals?.touch?.value });
  const changes = {};
  let careUrgency = 0;
  for (const [key] of EMOTION_DIMENSIONS) {
    let obs = expectedObservation(answers[`level_${key}`], key, { questionSet: input.questionSet });
    if (plan.replySelf.includes(key)) {
      const reported = stage2[`replyself_level_${key}`];
      // The catalog  every unmentioned dimension, so "none" means "he did not say
      // this one", not "it dropped to zero".
      const saidNothing = 'reply_self_any' in answers && decodeI5(reported).mode === 'none';
      obs = saidNothing ? { status: 'not_mentioned' } : expectedObservation(reported, key, { downgrade: true, questionSet: input.questionSet });
    }
    if (key === 'resistance') {
      const behaviour = avoidanceObservation(answers);
      if (behaviour && (obs.status !== 'value' || behaviour.value >= obs.value)) obs = behaviour;
    }
    if (key === 'care') {
      careUrgency = obs.status === 'value' && acceptedMetadata(stage2, key) ? obs.value : 0;
      continue;
    }
    const current = Number(state.values[key]);
    const behaviourChange = obs.source === 'reply_behavior' && Math.abs(obs.value - current) >= EMOTION_FOLLOWUP_GAP;
    if (obs.status === 'value' && (plan.dimensions.includes(key) || behaviourChange)) {
      const detail = integrateDimension(current, key, obs, answers, stage2);
      if (detail.accepted) state.values[key] = round(detail.final);
      else state.values[key] = round(recoverDimension(current, key, answers));
      changes[key] = { ...detail, final: state.values[key] };
    } else {
      state.values[key] = round(recoverDimension(current, key, answers));
    }
  }
  state.careUrgency = round(careUrgency);
  state.neglectTrace = round(Number(state.neglectTrace || 0) * Math.pow(2, -1 / 8));
  if (plan.neglect && acceptedMetadata(stage2, 'neglect')) {
    const understanding = decodeNoul(answers.understanding).status === 'yes';
    const obs = expectedObservation(answers.neglect_level, 'care', { questionSet: input.questionSet });
    const delta = understanding ? -0.5 : (obs.status === 'value' ? obs.value : 0);
    state.neglectTrace = round(delta >= 0
      ? state.neglectTrace + 0.35 * delta * (1 - state.neglectTrace)
      : state.neglectTrace - 0.5 * Math.abs(delta) * state.neglectTrace);
  }
  state.missing = { ...normalizeMissingClock(state.missing), neglectTrace: state.neglectTrace };
  state.jealousyTrace = round(Number(state.jealousyTrace || 0) * Math.pow(2, -1 / 12));
  for (const [key, detail] of Object.entries(changes)) {
    const label = decodeChoice(stage2[`${key}_label`]);
    if (detail.accepted && label.status === 'value' && label.value === 'jealousy' && detail.effective > 0 && NEGATIVE.has(key)) {
      state.jealousyTrace = round(clamp(state.jealousyTrace + Math.abs(detail.effective)));
    }
  }
  const localTouch = Number(input.localSignals?.touch?.value);
  const body = plan.body ? { ...stage2, _gateBoundary: answers.gate_Boundary, ...(Number.isFinite(localTouch) ? { _localTouch: localTouch } : {}) } : null;
  const arousalValues = {
    ...state.values,
    longing: effectiveLonging(state.values.longing, state.missing?.value),
  };
  const arousal = arousalStep(state.arousal, body, arousalValues, state.careUrgency, state.jealousyTrace, input.scoredAt);
  state.arousal = arousal.state;
  state.stateVersion = Number(state.stateVersion || 0) + 1;
  state.updatedAt = Number(input.scoredAt || Date.now());
  state.computedThrough = {
    messageId: String(input.messageId || ''),
    messageTs: Number(input.messageTs || 0),
    stateVersion: state.stateVersion,
  };
  advanceHintState(state, input, answers, arousal.details);
  state.latestInjection = createInjectionProjection({ state, changes, answers, stage2, arousal: arousal.details });
  const affectView = createAffectView({ before, state, changes, answers, stage2, arousal: arousal.details });
  state.processed[`${input.messageId}:${input.contentHash}`] = { at: state.updatedAt, questionSet: input.questionSet, affectView };
  return {
    state,
    details: {
      previous: {
        stateVersion: Number(before.stateVersion || 0),
        values: before.values,
        intimateArousal: Number(before.arousal?.value || 0),
        careUrgency: Number(before.careUrgency || 0),
        neglectTrace: Number(before.neglectTrace || 0),
        jealousyTrace: Number(before.jealousyTrace || 0),
      },
      changes,
      arousal: arousal.details,
      careUrgency: state.careUrgency,
      neglectTrace: state.neglectTrace,
      jealousyTrace: state.jealousyTrace,
    },
    affectView,
  };
}

function degree(delta) { const n = Math.abs(delta); return n >= 0.16 ? '强烈' : n >= 0.08 ? '明显' : n >= 0.03 ? '轻微' : '余韵'; }
function createAffectView({ before, state, changes, answers, stage2, arousal }) {
  const texture = decodeChoice(answers.texture);
  const reappraised = decodeNoul(answers.reappraisal).status === 'yes';
  const tempted = decodeI5(stage2.tempted); const jealous = Object.keys(changes).some(k => decodeChoice(stage2[`${k}_label`]).value === 'jealousy' && changes[k].accepted);
  const guiltRepair = changes.guilt?.accepted && decodeNoul(answers.gate_Repair).status === 'yes' && decodeNoul(answers.gate_Resolved).status === 'yes';
  let fixed = null;
  if (jealous && state.jealousyTrace >= 0.38) fixed = 'jealous_explosion';
  else if (jealous && reappraised) fixed = 'jealous_reappraised';
  else if (tempted.status === 'value' && tempted.value >= 0.5) fixed = 'tempted';
  else if (guiltRepair) fixed = 'guilt_repaired';
  else if (texture.status === 'value' && HEADLINE.has(texture.value)) fixed = texture.value;
  const entries = Object.entries(changes).filter(([, d]) => d.accepted && Math.abs(d.final - d.before) >= 0.003)
    .map(([key, d]) => ({ key, delta: d.final - d.before, level: d.final, weight: Math.abs(d.final - d.before) * (RELATION_WEIGHTS[key] || 1) }));
  if (arousal && Math.abs(arousal.final - arousal.before) >= 0.003) entries.push({ key: 'intimate_arousal', delta: arousal.final - arousal.before, level: arousal.final, weight: Math.abs(arousal.final - arousal.before) * 1.2 });
  entries.sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  let ingredients = [];
  if (!fixed) {
    for (const item of entries) {
      if (Math.abs(item.delta) < 0.03 || item.level < 0.10) continue;
      const ingredient = { key: item.key, direction: item.delta >= 0 ? 'up' : 'down' };
      if (!ingredients.some(entry => entry.key === ingredient.key && entry.direction === ingredient.direction)) ingredients.push(ingredient);
      if (ingredients.length === 3) break;
    }
  }
  const zh = Object.fromEntries(EMOTION_DIMENSIONS.map(([k, name]) => [k, name]));
  zh.intimate_arousal = '身体亲近感';
  const items = entries.slice(0, 5).map(item => ({ key: item.key, label: zh[item.key] || item.key, direction: item.delta >= 0 ? 'up' : 'down', degree: degree(item.delta) }));
  const view = {
    version: 2,
    ...(fixed ? { titleKey: fixed } : ingredients.length ? { ingredients } : { titleKey: 'calm' }),
    items, memoryDigestExcluded: true, generatedAt: state.updatedAt,
  };
  return view;
}

export function emotionStateView(state) {
  const s = state?.engineVersion === EMOTION_ENGINE_VERSION ? state : migrateEmotionState(state, state?.conversationId || '');
  const missing = normalizeMissingClock(s.missing);
  const values = { ...s.values, longing: effectiveLonging(s.values.longing, missing.value) };
  return { engineVersion: s.engineVersion, stateVersion: s.stateVersion, values, rawLonging: s.values.longing, effectiveLonging: values.longing, baselines: s.baselines, intimateArousal: s.arousal, careUrgency: s.careUrgency, neglectTrace: s.neglectTrace, jealousyTrace: s.jealousyTrace, missing, computedThrough: s.computedThrough, inheritedFrom: s.inheritedFrom, updatedAt: s.updatedAt };
}

function xmlAttribute(value) {
  return String(value || '').replace(/[&"<>]/g, char => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[char]);
}

// A narrow, text-free audit projection (e.g. for a mood page). The full snapshot
// text stays private to the generation request; the UI only learns which
// one-shot affordance/note was actually injected, when, and which settled
// assistant turn caused it.
export function emotionInjectionAuditView(state) {
  return Object.entries(state?.panelDelivery || {}).flatMap(([requestId, raw]) => {
    const row = raw && typeof raw === 'object' ? raw : {};
    const deliveredAt = Math.max(0, Number(row.deliveredAt || 0));
    const computedThroughTurnId = String(row.computedThroughTurnId || '');
    const affordanceKinds = Array.isArray(row.affordanceKinds)
      ? row.affordanceKinds.filter(kind => ['care', 'arousal'].includes(kind))
      : [];
    const noteKinds = Array.isArray(row.noteKinds)
      ? row.noteKinds.filter(kind => kind === 'avoidance')
      : [];
    if (!deliveredAt || !computedThroughTurnId || (!affordanceKinds.length && !noteKinds.length)) return [];
    return [{
      requestId: String(requestId || ''),
      deliveredAt,
      computedThroughTurnId,
      targetUserMessageId: String(row.targetUserMessageId || ''),
      affordanceKinds: [...new Set(affordanceKinds)],
      noteKinds: [...new Set(noteKinds)],
    }];
  }).sort((a, b) => a.deliveredAt - b.deliveredAt);
}

export function inheritEmotionState(source, conversationId, handoff = {}) {
  const migrated = migrateEmotionState(source, source?.conversationId || '');
  const inherited = structuredClone(migrated);
  inherited.conversationId = String(conversationId || '');
  inherited.processed = {};
  inherited.panelDelivery = {};
  inherited.lastUpdateDeliveredVersion = -1;
  inherited.hintState = {
    ...inherited.hintState,
    pending: {},
    delivered: {},
  };
  inherited.missing = { ...normalizeMissingClock(inherited.missing), pendingReturn: null, lastReturnEventId: '' };
  inherited.inheritedFrom = {
    conversationId: String(source?.conversationId || handoff.fromId || ''),
    stateVersion: Number(migrated.stateVersion || 0),
    computedThrough: migrated.computedThrough || null,
    handoffBoundaryAt: Number(handoff.lastMessageAt || 0),
    inheritedAt: Number(handoff.inheritedAt || Date.now()),
  };
  return inherited;
}

export function buildEmotionSnapshot(previous, options = {}) {
  const state = migrateEmotionState(previous, previous?.conversationId || '');
  const requestId = String(options.requestId || '').slice(0, 160);
  if (requestId && state.panelDelivery?.[requestId]) {
    return { state, ...state.panelDelivery[requestId], replayed: true };
  }
  const includeUpdate = options.includeUpdate !== false;
  const pendingReturn = state.missing?.pendingReturn && typeof state.missing.pendingReturn === 'object'
    ? { ...state.missing.pendingReturn }
    : null;
  const returnEvent = includeUpdate ? buildLongingReturnEvent(pendingReturn) : '';
  if (pendingReturn) state.missing = { ...normalizeMissingClock(state.missing), pendingReturn: null };
  const computed = state.computedThrough;
  if ((!computed?.messageId || Number(state.stateVersion || 0) <= 0) && !returnEvent) {
    return { state, text: '', snapshot: null, replayed: false };
  }

  const updateFresh = computed && Number(state.latestInjection?.stateVersion || -1) > Number(state.lastUpdateDeliveredVersion ?? -1);
  const updateLines = includeUpdate && updateFresh
    ? (state.latestInjection?.items || []).slice(0, 4).map(item => {
        const arrow = item.direction === 'down' ? '↓' : '↑';
        return `${item.label} ${arrow}${item.degree}${item.reason ? ` · ${item.reason}` : ''}`;
      })
    : [];
  if (includeUpdate && updateFresh && state.latestInjection?.reappraisal) updateLines.push('理性 ↑');
  // Choosing not to carry changes must not make an old delta appear later
  // when the switch is re-enabled.
  if (updateFresh) state.lastUpdateDeliveredVersion = Number(state.latestInjection?.stateVersion || state.stateVersion);

  const pending = state.hintState?.pending || {};
  const affordances = [];
  const affordanceKinds = [];
  const consumed = [];
  if (pending.care) {
    const tools = Array.isArray(options.careTools) ? options.careTools.filter(Boolean).slice(0, 4) : [];
    if (tools.length) {
      affordances.push(renderEmotionPrompt('care', { options: tools }, options.promptConfig));
      affordanceKinds.push('care');
    }
    consumed.push(['care', pending.care]);
  }
  if (pending.arousal) {
    if (!options.intimacyActive && !options.currentBoundaryBlocked) {
      affordances.push(renderEmotionPrompt('arousal', {}, options.promptConfig));
      affordanceKinds.push('arousal');
    }
    consumed.push(['arousal', pending.arousal]);
  }
  const notes = pending.avoidance
    ? [renderEmotionPrompt('avoidance', {}, options.promptConfig)]
    : [];
  const noteKinds = pending.avoidance ? ['avoidance'] : [];
  if (pending.avoidance) consumed.push(['avoidance', pending.avoidance]);

  for (const [kind, hint] of consumed) {
    state.hintState.delivered[kind] = hint.id;
    delete state.hintState.pending[kind];
  }
  const hasContent = updateLines.length || affordances.length || notes.length;
  let text = '';
  if (hasContent && computed?.messageId) {
    const immediate = String(options.previousAssistantMessageId || '') === String(computed.messageId || '');
    const coverage = immediate
      ? fillPersona('以下状态与提示截至你的上一条回复结束；{user}刚发来的消息发生在其后，请结合当前消息判断是否仍然适用。')
      : fillPersona('以下状态与提示来自较早的已结算回复；最近几轮尚未结算，{user}刚发来的消息也发生在其后，请结合当前消息判断是否仍然适用。');
    const parts = [`<AFFECT_SNAPSHOT computed_through_turn_id="${xmlAttribute(computed.messageId)}">`, coverage];
    if (updateLines.length) parts.push('<AFFECT_UPDATE>', ...updateLines, '</AFFECT_UPDATE>');
    for (const line of affordances) parts.push(`<AFFECT_AFFORDANCE>${line}</AFFECT_AFFORDANCE>`);
    for (const line of notes) parts.push(`<AFFECT_NOTE>${line}</AFFECT_NOTE>`);
    parts.push('</AFFECT_SNAPSHOT>');
    text = parts.join('\n');
  }
  if (returnEvent) text = [text, returnEvent].filter(Boolean).join('\n');
  const snapshot = {
    text,
    stateVersion: Number(state.stateVersion || 0),
    computedThroughTurnId: String(computed?.messageId || ''),
    includedUpdate: updateLines.length > 0 || Boolean(returnEvent),
    updateCount: updateLines.length,
    affordanceCount: affordances.length,
    noteCount: notes.length,
    affordanceKinds,
    noteKinds,
    deliveredAt: Math.max(0, Number(options.deliveredAt || Date.now())),
    targetUserMessageId: String(options.currentUserMessageId || ''),
  };
  if (requestId) {
    state.panelDelivery = { ...(state.panelDelivery || {}), [requestId]: snapshot };
    const entries = Object.entries(state.panelDelivery);
    if (entries.length > 80) state.panelDelivery = Object.fromEntries(entries.slice(-80));
  }
  return { state, ...snapshot, snapshot, replayed: false };
}

export function replayEmotionRecords(conversationId, records = [], options = {}) {
  let state = options.initialState
    ? migrateEmotionState(options.initialState, conversationId)
    : createEmotionState(conversationId);
  state.conversationId = String(conversationId || '');
  const turns = [];
  const rows = records.filter(r => r && !r.error && REPLAYABLE_EMOTION_ENGINE_VERSIONS.includes(r.engineVersion) && r.answers && r.stage2Answers)
    .sort((a, b) => Number(a.messageTs || 0) - Number(b.messageTs || 0) || Number(a.scoredAt || 0) - Number(b.scoredAt || 0));
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.messageId}:${row.contentHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const out = applyEmotionTurn(state, row);
    state = out.state;
    turns.push({ ...out, conversationId: row.conversationId, messageId: row.messageId, contentHash: row.contentHash, sourceEngineVersion: row.engineVersion });
  }
  return { state, turns };
}
