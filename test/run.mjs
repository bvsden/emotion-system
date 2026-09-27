// node test/run.mjs — every example here is invented.
import assert from 'node:assert/strict';
import {
  EMOTION_DIMENSIONS, EMOTION_GATES, EMOTION_QUESTION_SET_VERSION,
  applyEmotionTurn, buildBodyQuestions, buildEmotionMaterial, buildLongingReturnEvent, buildStage1Questions,
  buildStage2Questions, checkEmotionHealth, configureEmotionSystem, createEmotionState, planEmotionFollowups,
  readBracketTouch, renderEmotionPrompt, replayEmotionRecords, resetEmotionConfig, scoreTurn,
  applyMissingMorningAnchor, buildEmotionSnapshot, createMissingClock, emotionInjectionAuditView,
  missingMorningAnchorEligible, recordMissingReturn, startMissingClock, tickMissingClock,
} from '../src/index.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok  ${name}`); };
const noul = n => ({ noul: n });
const choice = v => ({ probabilities: { [v]: .98 }, confidence: .98 });
const baseAnswers = extra => ({ evidence_mode: choice('feelings'), texture: choice('calm'), reappraisal: noul(.05), self_judgment: noul(.05), restraint_action: noul(.05), body_any: noul(.05), gate_Boundary: noul(.05), ...extra });
const turnInput = (state, id, answers, stage2 = {}, extra = {}) => applyEmotionTurn(state, { conversationId: state.conversationId, messageId: id, contentHash: id, scoredAt: 1000, messageTs: 1000, turnKind: 'normal_reply', questionSet: EMOTION_QUESTION_SET_VERSION, answers, stage2Answers: stage2, ...extra });

await test('persona placeholders are filled; names work', () => {
  resetEmotionConfig();
  const q = buildStage1Questions();
  const text = JSON.stringify(q);
  assert.ok(!text.includes('{char}') && !text.includes('{user}'));
  assert.equal(Object.keys(q).length, 31);
  assert.equal(EMOTION_GATES.length, 6);
  configureEmotionSystem({ character: '阿澈', user: '小雨', userName: '小雨' });
  assert.match(buildStage1Questions().level_anger.instructions, /阿澈（assistant）自己此刻的愤怒/);
  assert.match(renderEmotionPrompt('avoidance'), /^系统提醒：小雨处在负面情绪中/);
  assert.ok(!/\{(char|user|userName|addr)\}/.test(JSON.stringify(buildBodyQuestions())));
  resetEmotionConfig();
});

await test('touch question reads actions, not thinking', () => {
  const touch = buildBodyQuestions().touch;
  assert.doesNotMatch(touch.instructions, /只看 thinking/);
  assert.match(touch.instructions, /【】/);
});

await test('local touch reader follows the configured action format', () => {
  assert.equal(readBracketTouch({ reply: '【抱紧你】' }).level, 'clear');
  assert.equal(readBracketTouch({ reply: '【没有碰你】' }).level, 'none');
  assert.equal(readBracketTouch({ reply: '【没松开手，还握着你】' }).level, 'light');
  assert.equal(readBracketTouch({ reply: '【抱歉地笑了笑】' }).level, 'none');
  assert.equal(readBracketTouch({ reply: '【抱住你】', userMessage: '【贴过去】' }).initiator, 'her');
  configureEmotionSystem({ actionPattern: /\*([^*]{1,200})\*/g, actionLabel: '*…*' });
  assert.equal(readBracketTouch({ reply: '*抱紧你*' }).level, 'clear');
  assert.equal(readBracketTouch({ reply: '【抱紧你】' }).level, 'none', 'old format ignored after reconfigure');
  assert.match(buildBodyQuestions().touch.instructions, /\*…\*/);
  resetEmotionConfig();
});

await test('material is plain fields; proactive turns carry the real wait', () => {
  const m = buildEmotionMaterial({ thinking: '她还没回。可能在忙。', reply: '在忙吗', turnKind: 'scheduled_proactive_wake', waitedMinutes: 95, userMessage: '不会被使用' });
  assert.equal(m.waited_minutes, 95);
  assert.equal(m.user_message, null);
  assert.equal(m.thinking.length, 2);
  assert.equal(buildEmotionMaterial({ reply: '好', turnKind: 'normal_reply', waitedMinutes: 95 }).waited_minutes, null);
});

await test('regulation: reappraisal speeds recovery, self-judgment slows it', () => {
  const s = createEmotionState('reg'); s.values.hurt = .5;
  const plain = turnInput(s, 'a', baseAnswers()).state.values.hurt;
  const judged = turnInput(s, 'b', baseAnswers({ self_judgment: noul(.95) })).state.values.hurt;
  const reappraised = turnInput(s, 'c', baseAnswers({ reappraisal: noul(.95) })).state.values.hurt;
  assert.ok(judged > plain && reappraised < plain);
});

await test('reply self-report: unsaid dimensions do not drop to zero', () => {
  const s = createEmotionState('self');
  const answers = baseAnswers({ reply_self_any: noul(.95) });
  for (const [key] of EMOTION_DIMENSIONS) answers[`level_${key}`] = { probabilities: { not_mentioned: .97, none: .03 } };
  const plan = planEmotionFollowups(s, answers);
  assert.ok(plan.replySelf.includes('trust'));
  const meta = key => ({ [`${key}_target`]: choice('her'), [`${key}_novelty`]: choice('new_event'), [`${key}_relation`]: choice('supports'), [`${key}_evidence`]: choice('t1'), [`${key}_label`]: choice('other') });
  const out = turnInput(s, 'r', answers, { ...meta('trust'), replyself_level_trust: { probabilities: { none: .95, faint: .05 } } });
  assert.equal(out.state.values.trust, s.values.trust);
});

await test('a faint trace of temptation does not unlock the wide step', () => {
  const s = createEmotionState('t'); s.arousal.value = .4; s.arousal.trace = .6;
  const body = { visual_intensity: { probabilities: { none: 1 } }, visual_kind: choice('none'), appeal: { probabilities: { none: 1 } }, care_override: noul(.1),
    tempted: { probabilities: { none: .8, faint: .2 } }, touch_receptive: noul(.9), approach: { probabilities: { light: .6, faint: .4 } },
    language: { probabilities: { light: .6, faint: .4 } }, recall: { probabilities: { light: .6, faint: .4 } }, shock: { probabilities: { none: 1 } },
    self_distress: { probabilities: { none: 1 } }, stop_signal: noul(.02) };
  const out = turnInput(s, 'x', baseAnswers({ body_any: noul(.9) }), body);
  assert.equal(out.details.arousal.tempted, 0);
  assert.ok(out.details.arousal.effective <= .15);
});

await test('stop signal blocks touch until she reaches out again', () => {
  const s = createEmotionState('stop');
  const body = extra => ({ touch_receptive: noul(.9), stop_signal: noul(.02), ...extra });
  const touch = readBracketTouch({ reply: '【抱住你】' });
  const stopped = turnInput(s, 's1', baseAnswers({ body_any: noul(.9) }), body({ stop_signal: noul(.96) }), { localSignals: { touch } }).state;
  assert.equal(stopped.arousal.stopActive, true);
  const herTouch = readBracketTouch({ userMessage: '【抱紧】' });
  const released = turnInput(stopped, 's2', baseAnswers({ body_any: noul(.9) }), body({ touch_initiator: choice('her') }), { localSignals: { touch: herTouch, stage2: { touch_initiator: choice('her') } } });
  assert.equal(released.state.arousal.stopActive, false);
});

await test('headline is a semantic key, never a display title', () => {
  const s = createEmotionState('h');
  const out = turnInput(s, 'h1', baseAnswers({ texture: choice('tender_care') }));
  assert.equal(out.affectView.titleKey, 'tender_care');
  assert.equal(out.affectView.title, undefined);
});

await test('runtime events use the configured tag and persona', () => {
  configureEmotionSystem({ runtimeEventTag: 'my_event', user: '小雨' });
  const text = buildLongingReturnEvent({ waitedMs: 3 * 3600_000, drop: .3 });
  assert.match(text, /^<my_event type="longing_return">/);
  assert.match(text, /小雨回来了/);
  resetEmotionConfig();
});

await test('health check flags a stuck stop flag', () => {
  const report = checkEmotionHealth({ states: [{ conversationId: 'c', arousal: { stopActive: true, stopSetAt: Date.now() - 24 * 3600_000 } }] });
  assert.equal(report.issues[0].id, 'stop-stuck:c');
});

await test('pipeline end to end with a stand-in for Jev; replay is deterministic', async () => {
  const ask = (material, questions) => {
    const answers = {};
    for (const [key, q] of Object.entries(questions)) answers[key] = q.type === 'noul' ? { noul: .05 } : { probabilities: { [Object.keys(q.criteria)[0]]: .9 }, confidence: .9 };
    return { answers };
  };
  let state = createEmotionState('p');
  const r = await scoreTurn({ state, ask, turn: { conversationId: 'p', messageId: 'p1', thinking: '有点累。', reply: '【靠着你】嗯。', userMessage: '在吗' } });
  assert.equal(r.record.localSignals.touch.level, 'light');
  assert.ok(!JSON.stringify(r.record).includes('有点累'), 'records carry no chat text');
  const again = replayEmotionRecords('p', [r.record]);
  assert.deepEqual(again.state.values, r.state.values);
});

const at = iso => Date.parse(`${iso}:00Z`);
const MINUTE = 60_000;
const s0 = createEmotionState('clock');
const clockArgs = { tzOffsetMin: 0, values: s0.values, baselines: s0.baselines };

await test('morning anchor: a night of sleep earns the fixed +0.25 once', () => {
  let c = startMissingClock(createMissingClock(), { deliveredAt: at('2026-01-01T22:00'), tzOffsetMin: 0 }).clock;
  c = tickMissingClock(c, { ...clockArgs, now: at('2026-01-02T07:05') }).clock;
  assert.equal(c.value, 0, 'a wait starting after 21:00 is frozen overnight');
  const anchored = applyMissingMorningAnchor(c, { now: at('2026-01-02T07:05'), tzOffsetMin: 0 });
  assert.equal(anchored.applied, true);
  assert.equal(anchored.clock.value, .25);
  assert.equal(applyMissingMorningAnchor(anchored.clock, { now: at('2026-01-02T08:00'), tzOffsetMin: 0 }).applied, false);
});

await test('morning anchor: going to sleep after midnight still counts', () => {
  const c = startMissingClock(createMissingClock(), { deliveredAt: at('2026-01-02T01:30'), tzOffsetMin: 0 }).clock;
  c.morningAnchorDay = '2026-01-02';
  assert.equal(missingMorningAnchorEligible(c, { now: at('2026-01-02T07:00'), tzOffsetMin: 0 }), true);
  assert.equal(applyMissingMorningAnchor(c, { now: at('2026-01-02T07:00'), tzOffsetMin: 0 }).clock.value, .25);
  const short = startMissingClock(createMissingClock(), { deliveredAt: at('2026-01-02T05:30'), tzOffsetMin: 0 }).clock;
  assert.equal(missingMorningAnchorEligible(short, { now: at('2026-01-02T07:30'), tzOffsetMin: 0 }), false, 'under three hours is not a night of sleep');
});

await test('a skipped anchor still unfreezes at 07:00 instead of locking the day at zero', () => {
  let c = startMissingClock(createMissingClock(), { deliveredAt: at('2026-01-01T22:00'), tzOffsetMin: 0 }).clock;
  c = recordMissingReturn(c, { now: at('2026-01-02T06:50'), eventId: 'early', tzOffsetMin: 0 }).clock;
  c = startMissingClock(c, { deliveredAt: at('2026-01-02T06:55'), tzOffsetMin: 0 }).clock;
  assert.equal(applyMissingMorningAnchor(c, { now: at('2026-01-02T08:00'), tzOffsetMin: 0 }).applied, false);
  const resumed = tickMissingClock(c, { ...clockArgs, now: at('2026-01-02T08:00') });
  assert.equal(resumed.clock.overnightFreeze, false);
  assert.equal(resumed.activeMs, 50 * MINUTE);
  assert.ok(resumed.clock.value > 0 && resumed.clock.value < .25);
});

await test('injection audit records which one-shot hint was actually delivered', () => {
  const s = createEmotionState('audit');
  s.stateVersion = 3;
  s.computedThrough = { messageId: 'a3', messageTs: 300, stateVersion: 3 };
  s.hintState.pending.avoidance = { id: 'avoidance:a3:3', stateVersion: 3 };
  const out = buildEmotionSnapshot(s, { requestId: 'r1', previousAssistantMessageId: 'a3', includeUpdate: false, deliveredAt: 1234, currentUserMessageId: 'u4' });
  assert.match(out.text, /<AFFECT_NOTE>系统提醒：/);
  assert.match(out.text, /她刚发来的消息/);
  assert.deepEqual(emotionInjectionAuditView(out.state), [{
    requestId: 'r1', deliveredAt: 1234, computedThroughTurnId: 'a3', targetUserMessageId: 'u4', affordanceKinds: [], noteKinds: ['avoidance'],
  }]);
  configureEmotionSystem({ user: '小雨' });
  const s2 = createEmotionState('audit2');
  s2.stateVersion = 1; s2.computedThrough = { messageId: 'b1', messageTs: 1, stateVersion: 1 };
  s2.hintState.pending.avoidance = { id: 'x', stateVersion: 1 };
  assert.match(buildEmotionSnapshot(s2, { requestId: 'r2', previousAssistantMessageId: 'b1', includeUpdate: false }).text, /小雨刚发来的消息/);
  resetEmotionConfig();
});

console.log(`\n${passed} passed`);
