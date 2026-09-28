// Self-check. Pure: reads saved records, per-conversation states and the
// scoring cursor (numbers and ids only, never chat text) and lists the kinds
// of anomalies we once found by hand: a stop flag stuck on, contact that
// never reached arousal, arousal jumping without a real temptation, a calm
// texture contradicting its own detail rows, Jev failures.

export const EMOTION_HEALTH_VERSION = 'health-v1';
const HOUR = 60 * 60 * 1000;
const CALM_TITLES = new Set(['defeated_fond', 'amused', 'tender_care', 'touched', 'admiring']);
const HARSH_ITEMS = new Set(['anger', 'hurt', 'aversion']);

function issue(id, severity, title, detail, extra = {}) {
  return { id, severity, title, detail, ...extra };
}

function fmtHours(ms) {
  const h = ms / HOUR;
  return h >= 24 ? `${Math.round(h / 24)} 天` : `${Math.max(1, Math.round(h))} 小时`;
}

export function checkEmotionHealth({ records = [], states = [], cursor = {}, now = Date.now(), windowHours = 72 } = {}) {
  const since = now - windowHours * HOUR;
  const rows = records
    .filter(r => Number(r.scoredAt || 0) >= since)
    .sort((a, b) => Number(a.messageTs || 0) - Number(b.messageTs || 0));
  const ok = rows.filter(r => !r.error && r.engine);
  const issues = [];

  // 1. A stop flag that outlived its six-hour release.
  for (const s of states) {
    const a = s?.arousal || {};
    const age = now - Number(a.stopSetAt || 0);
    if (a.stopActive && (!a.stopSetAt || age > 7 * HOUR)) {
      issues.push(issue(`stop-stuck:${s.conversationId}`, 'warn', '停止标记卡住了',
        `身体接触的停止标记已持续${a.stopSetAt ? fmtHours(age) : '很久'}，触碰不会计入身体亲近感。`,
        { conversationId: s.conversationId }));
    }
  }

  // 2. Contact read from 【】 but no touch reached arousal, several turns in a row.
  const byConv = new Map();
  for (const r of ok) { if (!byConv.has(r.conversationId)) byConv.set(r.conversationId, []); byConv.get(r.conversationId).push(r); }
  for (const [conversationId, list] of byConv) {
    let streak = 0, worst = 0, lastAt = 0;
    for (const r of list) {
      const local = Number(r.localSignals?.touch?.value || 0);
      // Scene turns drive A from the scene, so touch is not an input there.
      if (local <= 0 || r.engine?.arousal?.flow) continue;
      const counted = Number(r.engine?.arousal?.touch || 0) > 0;
      streak = counted ? 0 : streak + 1;
      if (streak > worst) { worst = streak; lastAt = Number(r.messageTs || 0); }
    }
    if (worst >= 5) {
      issues.push(issue(`touch-blocked:${conversationId}`, 'warn', '有接触却没计入',
        `连续 ${worst} 轮【】里有接触，身体亲近感的触碰输入都是 0（可能被停止标记、边界门或“不接纳”挡住）。`,
        { conversationId, lastAt }));
    }
  }

  // 3. Arousal jumping in one turn without a real temptation.
  const jumps = ok.filter(r => {
    const a = r.engine?.arousal;
    return a && !a.flow && Number(a.final || 0) - Number(a.before || 0) >= 0.25 && !(Number(a.tempted || 0) > 0);
  });
  if (jumps.length) {
    issues.push(issue('arousal-jump', jumps.length >= 3 ? 'warn' : 'info', '身体亲近感单轮暴涨',
      `${jumps.length} 轮在没有明确被诱惑时一轮上涨 ≥ 0.25。`,
      { count: jumps.length, lastAt: Number(jumps.at(-1).messageTs || 0) }));
  }

  // 4. Calm/tender texture whose detail rows show clear anger or hurt.
  const conflicts = ok.filter(r => {
    const v = r.affectView;
    return v && CALM_TITLES.has(v.titleKey) && (v.items || []).some(item =>
      HARSH_ITEMS.has(item.key) && item.direction === 'up' && (item.degree === '明显' || item.degree === '强烈'));
  });
  if (conflicts.length) {
    issues.push(issue('title-conflict', conflicts.length >= 3 ? 'warn' : 'info', '质地和明细矛盾',
      `${conflicts.length} 轮质地是温柔／宠溺／逗乐，明细却有明显的愤怒、受伤或排斥上升。`,
      { count: conflicts.length, lastAt: Number(conflicts.at(-1).messageTs || 0) }));
  }

  // 5. Jev failures in the last day, and turns that gave up after retries.
  // Only a failure that is still happening needs her attention; a burst that
  // already recovered is shown on the card but not pushed.
  const dayErrors = rows.filter(r => r.error && Number(r.scoredAt || 0) >= now - 24 * HOUR);
  const latest = [...rows].sort((a, b) => Number(a.scoredAt || 0) - Number(b.scoredAt || 0)).at(-1);
  const stillFailing = Boolean(latest?.error);
  if (dayErrors.length >= 3 || (stillFailing && dayErrors.length)) {
    issues.push(issue('jev-errors', stillFailing ? 'warn' : 'info', stillFailing ? 'Jev 分析正在失败' : 'Jev 曾短暂失败',
      `过去 24 小时有 ${dayErrors.length} 次分析失败（最近：${String(dayErrors.at(-1).error?.message || '').slice(0, 60)}）${stillFailing ? '，最近一次仍是失败。' : '，之后已恢复。'}`,
      { count: dayErrors.length, lastAt: Number(dayErrors.at(-1).scoredAt || 0) }));
  }
  const gaveUp = Object.values(cursor?.scored || {}).filter(e => e?.status === 'error' && Number(e.attempts || 0) >= 3 && Number(e.at || 0) >= since);
  if (gaveUp.length) {
    issues.push(issue('unscored', 'info', '有回复没能分析',
      `${gaveUp.length} 条回复重试 3 次仍失败，已跳过，这些回复不会有心情标题。`,
      { count: gaveUp.length }));
  }

  // 6. Local touch reader and Jev disagreeing a lot (parser word lists may need work).
  const compared = ok.filter(r => r.localSignals?.touch && r.stage2Answers?.touch?.probabilities);
  if (compared.length >= 20) {
    const W = { none: 0, faint: 0.25, light: 0.5, clear: 0.75, strong: 1 };
    const far = compared.filter(r => {
      const p = r.stage2Answers.touch.probabilities;
      let t = 0, s = 0;
      for (const [k, w] of Object.entries(W)) { t += Number(p[k] || 0); s += Number(p[k] || 0) * w; }
      return Math.abs(Number(r.localSignals.touch.value || 0) - (t ? s / t : 0)) > 0.5;
    });
    const share = far.length / compared.length;
    if (share >= 0.35) {
      issues.push(issue('touch-disagree', 'info', '本地触碰与 Jev 分歧较多',
        `${compared.length} 轮里有 ${far.length} 轮差距超过半档（${Math.round(share * 100)}%），可能需要补【】词表。`,
        { count: far.length }));
    }
  }

  const order = { warn: 0, info: 1 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    version: EMOTION_HEALTH_VERSION,
    checkedAt: now,
    windowHours,
    scored: ok.length,
    errors: rows.filter(r => r.error).length,
    issues,
  };
}

// Stable identity for "already told her about this" — changes when the issue
// recurs later or grows.
export function emotionHealthFingerprint(item) {
  return `${item.id}:${item.lastAt || 0}:${item.count || 0}`;
}
