// Deterministic wall-clock component of longing ("等待思念").
// Pure functions only: your app owns persistence, scheduling and I/O.
import { renderEmotionPrompt } from './prompts.js';
import { getEmotionConfig, fillPersona } from './config.js';

export const MISSING_CLOCK_VERSION = 'missing-1.0';
export const MISSING_GRACE_MS = 15 * 60 * 1000;
export const MISSING_TICK_MS = 5 * 60 * 1000;
export const MISSING_BASE_THRESHOLD = 0.65;
export const MISSING_MORNING_BONUS = 0.25;
export const MISSING_SLEEP_ANCHOR_MIN_MS = 3 * 60 * 60 * 1000;
export const MISSING_WAKE_MERGE_MS = 45 * 60 * 1000;
export const MISSING_WAKE_COOLDOWN_MS = 30 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const round = value => Math.round(Number(value || 0) * 1e6) / 1e6;

export function createMissingClock() {
  return {
    version: MISSING_CLOCK_VERSION,
    value: 0,
    awaitingSince: null,
    graceUntil: 0,
    lastTickAt: 0,
    neglectTrace: 0,
    morningAnchorDay: null,
    missedCallsThisAbsence: 0,
    nextThreshold: MISSING_BASE_THRESHOLD,
    lastWakeAt: null,
    overnightFreeze: false,
    sourceMessageId: '',
    lastReturnEventId: '',
    pendingReturn: null,
    processedCallEvents: {},
  };
}

export function normalizeMissingClock(value = {}) {
  const fresh = createMissingClock();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const processed = source.processedCallEvents && typeof source.processedCallEvents === 'object'
    ? Object.fromEntries(Object.entries(source.processedCallEvents).slice(-80))
    : {};
  return {
    ...fresh,
    ...source,
    version: MISSING_CLOCK_VERSION,
    value: clamp(source.value),
    awaitingSince: Number(source.awaitingSince || 0) || null,
    graceUntil: Math.max(0, Number(source.graceUntil || 0)),
    lastTickAt: Math.max(0, Number(source.lastTickAt || 0)),
    neglectTrace: clamp(source.neglectTrace),
    morningAnchorDay: source.morningAnchorDay ? String(source.morningAnchorDay) : null,
    missedCallsThisAbsence: Math.max(0, Math.floor(Number(source.missedCallsThisAbsence || 0))),
    nextThreshold: Math.max(MISSING_BASE_THRESHOLD, Math.min(0.999999, Number(source.nextThreshold || MISSING_BASE_THRESHOLD))),
    lastWakeAt: Number(source.lastWakeAt || 0) || null,
    overnightFreeze: source.overnightFreeze === true,
    sourceMessageId: String(source.sourceMessageId || ''),
    lastReturnEventId: String(source.lastReturnEventId || ''),
    pendingReturn: source.pendingReturn && typeof source.pendingReturn === 'object' ? { ...source.pendingReturn } : null,
    processedCallEvents: processed,
  };
}

function localMs(timestamp, tzOffsetMin) {
  return Number(timestamp || 0) + Number(tzOffsetMin || 0) * 60 * 1000;
}

export function missingLocalDay(timestamp, tzOffsetMin = 0) {
  return new Date(localMs(timestamp, tzOffsetMin)).toISOString().slice(0, 10);
}

export function missingLocalMinute(timestamp, tzOffsetMin = 0) {
  const local = new Date(localMs(timestamp, tzOffsetMin));
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

export function isMissingQuietTime(timestamp, tzOffsetMin = 0) {
  const minute = missingLocalMinute(timestamp, tzOffsetMin);
  return minute >= 30 && minute < 7 * 60;
}

function overlap(start, end, rangeStart, rangeEnd) {
  return Math.max(0, Math.min(end, rangeEnd) - Math.max(start, rangeStart));
}

// Wall time eligible for growth, excluding 00:30-07:00 local. A wait that
// begins after 21:00 (or before 07:00) remains fully frozen until its morning
// anchor.
export function missingActiveDuration(startAt, endAt, tzOffsetMin = 0, overnightFreeze = false) {
  const start = Number(startAt || 0);
  const end = Number(endAt || 0);
  if (!(end > start) || overnightFreeze) return 0;
  const offset = Number(tzOffsetMin || 0) * 60 * 1000;
  const localStart = start + offset;
  const localEnd = end + offset;
  let total = 0;
  for (let day = Math.floor(localStart / DAY_MS) * DAY_MS; day < localEnd; day += DAY_MS) {
    total += overlap(localStart, localEnd, day, day + 30 * 60 * 1000);
    total += overlap(localStart, localEnd, day + 7 * HOUR_MS, day + DAY_MS);
  }
  return total;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (Number(value || 0) - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function missingMultiplier({ values = {}, baselines = {}, neglectTrace = 0, jealousyTrace = 0 } = {}) {
  const trustBaseline = Math.max(0.000001, clamp(baselines.trust ?? 0.78));
  const anxietyBaseline = clamp(baselines.anxiety ?? 0.05);
  const trust = Number.isFinite(Number(values.trust)) ? clamp(values.trust) : trustBaseline;
  const anxiety = Number.isFinite(Number(values.anxiety)) ? clamp(values.anxiety) : anxietyBaseline;
  const distrust = clamp((trustBaseline - trust) / trustBaseline);
  const anxietyExcess = clamp((anxiety - anxietyBaseline) / Math.max(0.000001, 1 - anxietyBaseline));
  const jealousy = clamp(2.5 * clamp(jealousyTrace));
  const neg = 1 + Math.min(1.5,
    1.2 * jealousy + distrust + 0.5 * clamp(values.hurt) + 0.4 * anxietyExcess);
  const streak = 1 + smoothstep(0.15, 0.60, clamp(neglectTrace));
  return { streak, neg, mult: Math.min(5, streak * neg), distrust, anxietyExcess, jealousy };
}

export function tickMissingClock(previous, {
  now = Date.now(), tzOffsetMin = 0, values = {}, baselines = {}, jealousyTrace = 0,
} = {}) {
  const clock = normalizeMissingClock(previous);
  const end = Math.max(Number(now || 0), Number(clock.lastTickAt || 0));
  if (!clock.awaitingSince) {
    clock.lastTickAt = end;
    return { clock, changed: end !== Number(previous?.lastTickAt || 0), activeMs: 0, multiplier: missingMultiplier({ values, baselines, neglectTrace: clock.neglectTrace, jealousyTrace }) };
  }
  let start = Math.max(Number(clock.lastTickAt || clock.awaitingSince), Number(clock.graceUntil || 0));
  // Returning before the morning anchor deliberately suppresses that day's
  // fixed +0.25. If a new pre-07:00 wait starts afterwards, however, it must
  // still leave overnight freeze at 07:00 and resume ordinary wall-clock
  // growth. Because frozen ticks may already have advanced lastTickAt beyond
  // 07:00, resume from the boundary itself exactly once.
  const boundary = anchorBoundaryAt(end, tzOffsetMin);
  const skippedMorningBonus = clock.overnightFreeze
    && Number(clock.awaitingSince) < boundary
    && end >= boundary
    && !missingMorningAnchorEligible(clock, { now: end, tzOffsetMin });
  if (skippedMorningBonus) {
    clock.overnightFreeze = false;
    start = Math.max(Number(clock.graceUntil || 0), boundary);
  }
  const activeMs = missingActiveDuration(start, end, tzOffsetMin, clock.overnightFreeze);
  const multiplier = missingMultiplier({ values, baselines, neglectTrace: clock.neglectTrace, jealousyTrace });
  const before = clock.value;
  if (activeMs > 0) {
    const kPerHour = Math.log(2) / 3;
    clock.value = round(1 - (1 - clock.value) * Math.exp(-kPerHour * multiplier.mult * (activeMs / HOUR_MS)));
  }
  clock.lastTickAt = end;
  return { clock, changed: skippedMorningBonus || clock.value !== before || end !== Number(previous?.lastTickAt || 0), activeMs, multiplier };
}

export function startMissingClock(previous, { deliveredAt = Date.now(), messageId = '', tzOffsetMin = 0 } = {}) {
  const clock = normalizeMissingClock(previous);
  if (clock.awaitingSince) return { clock, started: false };
  const minute = missingLocalMinute(deliveredAt, tzOffsetMin);
  clock.awaitingSince = Number(deliveredAt);
  clock.lastTickAt = Number(deliveredAt);
  clock.graceUntil = Number(deliveredAt) + MISSING_GRACE_MS;
  clock.overnightFreeze = minute >= 21 * 60 || minute < 7 * 60;
  clock.sourceMessageId = String(messageId || '');
  return { clock, started: true };
}

function anchorBoundaryAt(timestamp, tzOffsetMin) {
  const offset = Number(tzOffsetMin || 0) * 60 * 1000;
  const local = localMs(timestamp, tzOffsetMin);
  const dayStartLocal = Math.floor(local / DAY_MS) * DAY_MS;
  return dayStartLocal + 7 * HOUR_MS - offset;
}

export function missingMorningAnchorEligible(previous, { now = Date.now(), tzOffsetMin = 0 } = {}) {
  const clock = normalizeMissingClock(previous);
  if (!clock.awaitingSince) return false;
  if (missingLocalMinute(now, tzOffsetMin) < 7 * 60) return false;
  const boundary = anchorBoundaryAt(now, tzOffsetMin);
  return Number(clock.awaitingSince) < boundary
    && Number(now) - Number(clock.awaitingSince) >= MISSING_SLEEP_ANCHOR_MIN_MS;
}

export function nextMissingThresholdAbove(value) {
  let threshold = MISSING_BASE_THRESHOLD;
  for (let i = 0; i < 32 && threshold <= Number(value || 0); i += 1) {
    threshold = 1 - (1 - threshold) * 0.6;
  }
  return Math.min(0.999999, threshold);
}

export function applyMissingMorningAnchor(previous, { now = Date.now(), tzOffsetMin = 0 } = {}) {
  const clock = normalizeMissingClock(previous);
  if (!missingMorningAnchorEligible(clock, { now, tzOffsetMin })) return { clock, applied: false };
  clock.value = round(Math.min(0.99, clock.value + MISSING_MORNING_BONUS));
  clock.awaitingSince = Number(now);
  clock.lastTickAt = Number(now);
  clock.graceUntil = Number(now); // the post-anchor clock has no grace period
  clock.overnightFreeze = false;
  clock.morningAnchorDay = missingLocalDay(now, tzOffsetMin);
  clock.nextThreshold = nextMissingThresholdAbove(clock.value);
  return { clock, applied: true };
}

export function recordMissingReturn(previous, { now = Date.now(), eventId = '', tzOffsetMin = 0 } = {}) {
  const clock = normalizeMissingClock(previous);
  const id = String(eventId || '');
  if (!clock.awaitingSince || (id && clock.lastReturnEventId === id)) return { clock, returned: false };
  const before = clock.value;
  const waitedMs = Math.max(0, Number(now) - Number(clock.awaitingSince));
  // Any real return satisfies today's wait. If it happens before 07:00 and a
  // new assistant reply starts another wait, that wait must not collect the
  // skipped morning anchor later the same day.
  clock.morningAnchorDay = missingLocalDay(now, tzOffsetMin);
  clock.value = round(0.30 * before);
  clock.awaitingSince = null;
  clock.graceUntil = 0;
  clock.lastTickAt = Number(now);
  clock.overnightFreeze = false;
  clock.missedCallsThisAbsence = 0;
  clock.nextThreshold = MISSING_BASE_THRESHOLD;
  clock.lastReturnEventId = id;
  clock.pendingReturn = {
    id: `return:${id || now}`,
    at: Number(now), before, after: clock.value, waitedMs,
  };
  return { clock, returned: true, before, after: clock.value, waitedMs };
}

export function applyMissingCallImpulse(previous, { eventId = '', now = Date.now() } = {}) {
  const clock = normalizeMissingClock(previous);
  const id = String(eventId || '');
  if (!id || clock.processedCallEvents[id]) return { clock, applied: false };
  const n = clock.missedCallsThisAbsence + 1;
  const impulse = 0.22 * Math.pow(0.75, n - 1);
  clock.value = round(clock.value + impulse * (1 - clock.value));
  clock.missedCallsThisAbsence = n;
  clock.processedCallEvents = { ...clock.processedCallEvents, [id]: Number(now) };
  const entries = Object.entries(clock.processedCallEvents);
  if (entries.length > 80) clock.processedCallEvents = Object.fromEntries(entries.slice(-80));
  return { clock, applied: true, n, impulse, value: clock.value };
}

export function consumeMissingWakeThreshold(previous) {
  const clock = normalizeMissingClock(previous);
  if (clock.value + 1e-9 < clock.nextThreshold) return { clock, consumed: false, threshold: clock.nextThreshold };
  const threshold = clock.nextThreshold;
  clock.nextThreshold = Math.min(0.999999, 1 - (1 - threshold) * 0.6);
  return { clock, consumed: true, threshold };
}

export function markMissingWakeDelivered(previous, { now = Date.now() } = {}) {
  const clock = normalizeMissingClock(previous);
  clock.lastWakeAt = Number(now);
  return clock;
}

export function effectiveLonging(longing, missing) {
  const L = clamp(longing);
  const M = clamp(missing);
  return round(1 - (1 - L) * (1 - M));
}

export function formatMissingDuration(durationMs) {
  const totalMinutes = Math.max(0, Math.round(Number(durationMs || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} 小时${minutes ? ` ${minutes} 分` : ''}` : `${minutes} 分钟`;
}

export function buildLongingWakeEvent(previous, { now = Date.now(), tzOffsetMin = 0, promptConfig } = {}) {
  const clock = normalizeMissingClock(previous);
  const waitedMs = clock.awaitingSince ? Math.max(0, Number(now) - Number(clock.awaitingSince)) : 0;
  const minute = missingLocalMinute(now, tzOffsetMin);
  const options = [];
  if (minute >= 8 * 60 && minute < 23 * 60) options.push('电话');
  options.push('消息');
  if (clock.value >= 0.79) options.push('连发（间隔最短 1 分钟）');
  options.push('继续等');
  const text = renderEmotionPrompt('longingWake', {
    duration: formatMissingDuration(waitedMs),
    options,
  }, promptConfig);
  return `<${getEmotionConfig().runtimeEventTag} type="longing_wake">${text}</${getEmotionConfig().runtimeEventTag}>`;
}

export function buildLongingReturnEvent(pendingReturn) {
  if (!pendingReturn) return '';
  const delta = Math.max(0, Number(pendingReturn.before || 0) - Number(pendingReturn.after || 0));
  const degree = delta >= 0.16 ? '强烈' : delta >= 0.08 ? '明显' : delta >= 0.03 ? '轻微' : '余韵';
  const tag = getEmotionConfig().runtimeEventTag;
  return `<${tag} type="longing_return">${fillPersona(`思念 ↓${degree} · 等了约 ${formatMissingDuration(pendingReturn.waitedMs)}，{user}回来了`)}</${tag}>`;
}

export function missingWakeTargetTime({ now = Date.now(), existingDueAt = 0, lastWakeAt = 0, busy = false } = {}) {
  const existing = Number(existingDueAt || 0);
  if (existing > 0 && existing <= Number(now) + MISSING_WAKE_MERGE_MS) {
    return { action: 'attach', dueAt: existing };
  }
  const cooldownAt = Number(lastWakeAt || 0) + MISSING_WAKE_COOLDOWN_MS;
  const busyAt = busy ? Number(now) + MISSING_WAKE_COOLDOWN_MS : Number(now);
  const dueAt = Math.max(Number(now), cooldownAt, busyAt);
  return { action: existing > 0 ? 'advance' : 'create', dueAt };
}
