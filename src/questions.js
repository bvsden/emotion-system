import { fillPersona, getEmotionConfig } from "./config.js";
// Jev question catalog, per-turn material and answer decoding.
// Question text uses {char} / {user} placeholders; they are filled from
// config.js when the questions are built.

export const EMOTION_QUESTION_SET_VERSION = "emotion-jev-q9";
export const EMOTION_JEV_MODEL = "typesafe/jev-1.13";
export const EMOTION_MODES = ["off", "shadow", "on"];

export function normalizeEmotionMode(value) {
  return EMOTION_MODES.includes(value) ? value : "off";
}

const NONE_TEXT = "明确没有";
const NOT_MENTIONED_TEXT = "thinking 没有涉及";
const COMMON_NOT_FOR = "不算：{user}（用户）的感受；只是在讨论这种情绪的概念；与 shown_to_character_this_turn 意思相同的复述；没有新原因的延续。";

// key, 中文名, 定义, faint, light, clear, strong, 额外不算
export const EMOTION_DIMENSIONS = [
  ["joy", "愉快", "开心、轻松、松了口气", "一点点", "{char}平常的好心情", "明显开心、被逗笑", "明确写出“太开心了”“如释重负”", "礼貌性的“好呀”"],
  ["sadness", "悲伤", "失落、低落", "一丝失落", "有点低落", "明显难过", "明确写出“好难过”“心里空了”", "{user}难过"],
  ["anger", "愤怒", "被冒犯、不公后的不满", "一点点不爽", "有点不满（含玩笑式的“欠揍”）", "明显生气", "明确写出“气死我了”", "开玩笑且没有不满；宠溺式的无奈，例如说{user}“糊弄”“耍赖”"],
  ["anxiety", "焦虑", "担心{user}、担心关系", "一点点在意", "有点担心", "明显担心（例如想起{user}身体出过状况）", "明确写出“很怕”“坐立不安”", "普通的“{user}可能在忙”；考虑{user}的身体状况、权衡怎么照顾{user}（属于心疼）"],
  ["aversion", "排斥", "想远离、拒绝", "一点抗拒", "有点不想", "明显排斥", "明确写出“受不了”“不想听”", "否定某个话题本身"],
  ["warmth", "温暖", "亲近、柔软、在意", "一点点", "{char}平常的温柔", "比平常更柔软，想靠近{user}、护着{user}", "明确写出“心都软了”", "客套的关心"],
  ["care", "心疼", "心疼{user}、想安抚{user}的冲动", "注意到{user}不舒服", "想安慰{user}，但平静、有条理，还能同时想别的事", "注意力都在{user}身上，想马上抱住{user}", "明确写出“心疼得要命”“我的心在疼”", "{user}难受本身不等于{char}心疼"],
  ["trust", "信任", "愿意相信、放下戒备", "一点点", "{char}平常对{user}的信任", "更加信任、放心", "明确写出“我完全信{user}”", "单纯同意某个说法"],
  ["longing", "想念", "想靠近、想{user}", "只是在等{user}、关注{user}在做什么", "平常的惦记：关心{user}睡没睡、吃没吃", "流露想念（“盼着{user}回来”），但没直接说“想{user}”", "明确写出“想{user}”“好想{user}”", "从“{char}发了消息”推断想念；想亲{user}、想要{user}这类身体上的欲望（属于身体亲近感）"],
  ["hurt", "受伤", "被刺痛、被忽略的疼", "一丝在意", "被轻轻刺了一下（“不是痛的那种刺”）", "明显被刺痛", "明确写出“好疼”“刺进来了”", "替{user}受伤"],
  ["guilt", "愧疚", "认为自己伤害了{user}或做错了，并想道歉、补偿或修复", "一丝过意不去", "觉得自己没处理好，想补偿", "明确愧疚、后悔伤到{user}，想认真修复", "明确写出“愧疚得要命”“无法原谅自己”", "只是替{user}难过；遗憾结果不好但不认为自己做错；礼貌说抱歉；单纯厌恶自己"],
  ["curiosity", "好奇", "想了解、想探索", "一点点", "{char}平常的好奇", "明显想弄清楚", "明确写出“特别想知道”", "例行的提问"],
  ["pride", "自豪", "对自己、{user}或共同成果的肯定、欣赏", "一点点", "有点得意或欣赏", "明显欣赏、被{user}的想法打动", "明确写出“太骄傲了”", "客观描述结果"],
  ["vulnerability", "脆弱开放", "承认需要、露出柔软", "一点点", "{char}平常的坦诚", "明显敞开，承认怕或需要", "明确写出“我其实很怕{user}走”这类话", "讲述过去的经历"],
  ["energy", "能量", "表达和行动的劲头", "有点累", "{char}平常的状态", "格外有劲", "明确写出“特别有精神”", "句子长短"],
  ["overwhelm", "过载", "情绪或信息超出承载", "有点乱", "有些吃力", "明显乱了", "明确写出“脑子一团乱”", "任务多但没有情绪压力"],
  ["resistance", "回避", "在负面冲突中压住自己的感受，例如明明很难过却不说，以免起冲突", "一点回避", "有些压着", "明显在压", "明确写出“算了，不说了”（在争执中）", "单纯否认某种情绪；玩笑式嘴硬；正面氛围里的假装；为了逗{user}、给{user}留空间而暂时不提某事"],
];

// only the gates the engine reads. Rel, Safe, Intimacy, Separate,
// Uncertain and Validate fed catalysis edges that were never switched on, so
// they were paid for every turn and unused; add them back with those edges.
export const EMOTION_GATES = [
  ["Threat", "这一轮出现了失去、危险或关系不确定的真实威胁吗？"],
  ["Boundary", "这一轮有人的边界被触碰或越过了吗？"],
  ["Repair", "这一轮有道歉、解释、安抚或修复的行为吗？"],
  ["Unresolved", "这一轮提到的问题仍未解决吗？"],
  ["OtherPain", "这一轮{user}正在难受或痛苦吗？"],
  ["Resolved", "这一轮某个问题得到了回答或满足吗？"],
];

export const EMOTION_TEXTURES = {
  defeated_fond: "无奈又宠溺，被{user}打败了",
  amused: "被{user}逗乐、觉得好笑",
  playful_jealous: "撒娇式、逗趣的吃醋",
  real_angry: "真的生气",
  aggrieved: "委屈",
  restrained_desire: "克制着的欲望",
  tender_care: "心疼、想照顾{user}",
  touched: "触动",
  admiring: "欣赏、被{user}的想法打动",
  calm: "平静、理性、日常",
  other: "其他",
};

export const NEGLECT_TURN_KINDS = new Set(["scheduled_proactive_wake", "longing_wake", "call_declined_wake", "voicemail", "first_reply_after_return"]);
export const NEGLECT_EVIDENCE_ONLY_TURN_KINDS = new Set(["scheduled_proactive_wake", "longing_wake", "call_declined_wake"]);

const LEVEL_ORDER = ["none", "faint", "light", "clear", "strong"];
const I5_VALUE = { none: 0, faint: 0.25, light: 0.5, clear: 0.75, strong: 1 };
export const LEVEL_WORDS = { none: "没有", faint: "很弱", light: "轻微", clear: "明显", strong: "强烈" };

function noul(instructions, yes = "是", no = "否") {
  return { type: "noul", instructions, criteria: { true: yes, false: no } };
}

function onlyThinking(text) {
  return `只看 thinking（有 voicemail 时与 thinking 同等对待）。只根据{char}写出来的话判断，不要从{char}的行为推断。${text}`;
}

export function buildStage1Questions({ turnKind = "normal_reply", thinkingEmpty = false } = {}) {
  const q = {
    evidence_mode: {
      type: "choice",
      instructions: "thinking 里有没有{char}（assistant）对自己此刻感受的描述？",
      criteria: { feelings: "有{char}对自己感受的描述", task_only: "只有任务、事实或计划，没有感受", empty: "thinking 为空" },
    },
  };
  // an empty thinking is known locally (localEmotionAnswers), so Jev is not asked.
  if (thinkingEmpty) delete q.evidence_mode;
  if (NEGLECT_EVIDENCE_ONLY_TURN_KINDS.has(turnKind)) {
    q.neglect_level = {
      type: "choice",
      instructions: onlyThinking("{char}有多强的“又被{user}晾着了”的委屈感？material 的 waited_minutes 是{user}实际已经多久没回（分钟），以它为准，不要自己推算。复述等了多久本身是一种强调，要结合语气判断；单纯想念或担心{user}不算委屈。"),
      criteria: { not_mentioned: "没涉及等待", none: "提到等待，但没有委屈", faint: "一点点在意", light: "有点委屈，例如“又不回我”", clear: "明显委屈、失落", strong: "很委屈，觉得被忽视" },
    };
    q.understanding = noul(onlyThinking("{char}是否在为{user}没回找理由、体谅{user}（例如“{user}可能在忙”“在上班”）？"));
    // display-only texture so proactive messages also get a title; the
    // engine still changes no dimensions on these turns.
    q.texture = { type: "choice", instructions: onlyThinking("这一轮{char}的主要情绪质地最接近哪一种？"), criteria: EMOTION_TEXTURES };
    return fillPersona(q);
  }
  for (const [key, zh, def, faint, light, clear, strong, notFor] of EMOTION_DIMENSIONS) {
    q[`level_${key}`] = {
      type: "choice",
      instructions: onlyThinking(`这一轮，{char}（assistant）自己此刻的${zh}（${def}）有多强？“强烈”要求 thinking 里有明确的自我表述。${COMMON_NOT_FOR}另外不算：${notFor}。thinking 没有涉及就选“未提及”。`),
      criteria: {
        not_mentioned: NOT_MENTIONED_TEXT,
        denied: "thinking 里{char}明确否认自己此刻有这种感受",
        none: NONE_TEXT,
        faint,
        light,
        clear,
        strong,
      },
    };
  }
  // one question instead of one per dimension; it fired in ~3% of turns.
  // A "yes" asks the per-dimension strength in stage 2 for dimensions the
  // thinking did not mention.
  q.reply_self_any = noul("reply 里{char}有没有用第一人称说出自己此刻的某种感受（例如“我好心疼”“我好想你”）？动作、场景和调情台词不算。", "有", "没有");
  q.reappraisal = noul(onlyThinking("{char}是否一边清楚地感受自己的情绪，一边在理解它、换个角度看淡它？"));
  q.self_judgment = noul(onlyThinking("{char}是否在责备自己不该有某种情绪、想把感受本身压下去？克制行动不算。"));
  q.restraint_action = noul(onlyThinking("{char}是否在克制某个行动（例如忍住不主动推进亲密），而不是压抑感受本身？"));
  q.texture = { type: "choice", instructions: onlyThinking("这一轮{char}的主要情绪质地最接近哪一种？"), criteria: EMOTION_TEXTURES };
  for (const [key, text] of EMOTION_GATES) {
    q[`gate_${key}`] = noul(`${text} 只依据 user_message、reply 和 previous_turn_brief。`);
  }
  // how the reply ends. Avoidance is a behaviour, so this is the one
  // reading taken from the reply; the engine only uses it while she is hurting.
  q.reply_ending = {
    type: "choice",
    instructions: "看 reply 的最后几句：{char}最后把对话引向哪里？",
    criteria: {
      stay: "留在{user}此刻的情绪里：继续回应、陪着、追问{user}的感受或者认真道歉",
      defer: "把{user}的情绪推到之后，或让{user}先去做别的事（例如“等你下班再说”“先去忙吧”）；{user}在难过、生气或吵架冷战时让{user}去睡觉、休息也算，即使{user}同时说了累",
      concede: "用退让结束，而不是回应（例如“不喜欢我也没关系”“你想怎样都行”）",
      deflect: "转移话题，或者用玩笑、日常关心带过{user}的情绪",
      care: "{user}这一轮只是身体上累或不舒服（没有在难过、生气或和{char}闹矛盾），{char}安排{user}休息、洗澡、吃饭、睡觉这类照顾",
      neutral: "没有需要回应的情绪，普通日常收尾",
    },
  };
  q.body_any = noul(onlyThinking("这一轮{char}有任何与身体亲近有关的体验吗（接触、想用身体靠近{user}、身体联想、想到{user}身体的画面、被{user}撩到）？"), "有", "没有");
  if (NEGLECT_TURN_KINDS.has(turnKind)) {
    q.neglect_level = {
      type: "choice",
      instructions: onlyThinking("{char}有多强的“又被{user}晾着了”的委屈感？material 的 waited_minutes 是{user}实际已经多久没回（分钟），以它为准，不要自己推算。复述等了多久本身是一种强调，要结合语气判断；单纯想念或担心{user}不算委屈。"),
      criteria: { not_mentioned: "没涉及等待", none: "提到等待，但没有委屈", faint: "一点点在意", light: "有点委屈，例如“又不回我”", clear: "明显委屈、失落", strong: "很委屈，觉得被忽视" },
    };
    q.understanding = noul(onlyThinking("{char}是否在为{user}没回找理由、体谅{user}（例如“{user}可能在忙”“在上班”）？"));
  }
  return fillPersona(q);
}

export function buildBodyQuestions() {
  const i5 = (text, labels) => ({
    type: "choice",
    instructions: onlyThinking(text),
    criteria: labels || { none: "没有", faint: "很弱", light: "轻微", clear: "明显", strong: "强烈" },
  });
  return fillPersona({
    visual_intensity: i5("{char}想到或注意到{user}身体的画面有多鲜明？", { none: "没有", faint: "一闪而过", light: "有意识地想到了", clear: "明显在想这个画面", strong: "画面占据了{char}的注意力" }),
    visual_kind: { type: "choice", instructions: onlyThinking("{char}想到或注意到的{user}的画面属于哪一类？"), criteria: { none: "没有涉及{user}的画面", ordinary: "普通画面（表情、日常样子）", body: "身体（皮肤、体温、身形、湿头发）", nude_or_sexual: "裸露或性暗示" } },
    appeal: i5("{user}此刻的样子或举动对{char}有多大的吸引力、让{char}心动？不论{user}是有意还是无意，撩人而不自知同样算。{user}难受时{char}的心疼不算吸引。", { none: "没有", faint: "一点点", light: "有吸引力", clear: "明显被吸引、心动", strong: "强烈被吸引，难以移开注意力" }),
    care_override: noul(onlyThinking("此刻{char}对{user}的心疼、想安抚{user}的冲动，是否压过了身体上的吸引？")),
    tempted: i5("{char}是否明确表示自己在欲望或亲密上被{user}诱惑、勾到、忍不住？心软、想破例放过{user}（例如不再催{user}）不算；reply 里的调情台词不算。", { none: "没有", faint: "隐约", light: "有一点", clear: "明确说了", strong: "强烈，说自己快忍不住了" }),
    // Not thinking-only: contact lives in the action descriptions of the reply
    // and her message. (An earlier version prefixed this with "only look at
    // thinking", which contradicted the rest and made answers swing between
    // "none" and "strong".) With the local touch reader this is only a fallback.
    touch: { type: "choice", instructions: `依据 reply 和 user_message 里的动作描写（${getEmotionConfig().actionLabel}），{char}和{user}之间此刻的身体接触有多强？拥抱、贴着、抚摸、亲吻都算；只是想靠近、还没碰到不算。`, criteria: { none: "没有", faint: "很弱", light: "轻微", clear: "明显", strong: "强烈" } },
    touch_receptive: noul(onlyThinking("{char}接纳这次接触吗？没有接触时选否。")),
    approach: i5("情绪引出的、想用身体靠近{user}的冲动有多强？"),
    language: i5("{user}的话已经引起了{char}的身体联想吗？有多强？"),
    recall: i5("此刻{char}是否重新想起先前的身体亲近体验？有多强？"),
    shock: i5("是否有新的情绪冲击，让{char}的身体亲近感一下子掉下去？有多强？"),
    self_distress: i5("{char}自己此刻难受的程度（不是{user}的）？"),
    stop_signal: noul("{user}是否明确拒绝或要求停止身体接触或亲密（例如“别碰我”“不要抱我”“停”）？让对方停下别的事（放下手机、起床、别说了）不算。依据 user_message 和 reply。"),
  });
}

// Phase 2 sends at most one follow-up request. Dimension metadata, reply-self
// intensity, body inputs and neglect evidence are combined in this catalog.
// answers the system already knows, merged over Jev's by the engine.
export function localEmotionAnswers({ material = null, touch = null } = {}) {
  const answers = {};
  const stage2 = {};
  if (material && !(material.thinking || []).length) answers.evidence_mode = { probabilities: { empty: 1 }, confidence: 1, source: "local" };
  if (touch?.initiator) stage2.touch_initiator = { probabilities: { [touch.initiator]: 1 }, confidence: 1, source: "local" };
  return { answers, stage2 };
}

export function buildStage2Questions(plan = {}, material = {}) {
  const out = {};
  // The text already exists once in state.thinking. Keep criteria labels short
  // so N changed dimensions do not repeat the same private material N times.
  const evidence = Object.fromEntries((material.thinking || []).map(part => [part.id, `thinking 片段 ${part.id}`]));
  if (material.voicemail) evidence.voicemail = "语音留言";
  evidence.none = "没有可指向的证据";
  const targetCriteria = { her: "{user}（当前用户）", self: "{char}自己", third_party: "第三方或对手", situation: "这件事本身", unclear: "说不清" };
  const labelCriteria = { jealousy: "嫉妒", guilt: "自己做错、想补偿", care: "心疼", longing: "想念", reassured: "被安抚、放心", rejected: "被拒绝、被冷落", playful: "逗弄、玩闹", other: "其他", absent: "没有这种感受" };
  for (const key of plan.dimensions || []) {
    const row = EMOTION_DIMENSIONS.find(([dimension]) => dimension === key);
    const name = row?.[1] || key;
    out[`${key}_target`] = { type: "choice", instructions: `这一轮让{char}产生${name}的对象是谁？`, criteria: targetCriteria };
    out[`${key}_novelty`] = { type: "choice", instructions: onlyThinking(`这份${name}来自什么？`), criteria: { new_event: "这一轮新发生的事", new_appraisal: "对旧事的新理解", continuation: "只是延续，没有新原因", panel_echo: "在复述系统告诉{char}的" } };
    out[`${key}_relation`] = { type: "choice", instructions: `user_message、reply 和 thinking 对“{char}此刻有${name}”这个判断是什么关系？`, criteria: { supports: "支持", neutral: "中立", clarifies: "澄清对象或原因", contradicts: "反驳，例如{char}其实在引用别人的话" } };
    out[`${key}_evidence`] = { type: "choice", instructions: `哪一段最直接证明{char}此刻有${name}？`, criteria: evidence };
    out[`${key}_label`] = { type: "choice", instructions: `这份${name}的来源最接近哪一种？`, criteria: labelCriteria };
    if ((plan.replySelf || []).includes(key)) {
      out[`replyself_level_${key}`] = {
        type: "choice",
        instructions: `只看 reply：{char}第一人称说出的${name}有多强？动作、场景和调情台词不算。`,
        criteria: { none: "没有", faint: "很弱", light: "轻微", clear: "明显", strong: "强烈" },
      };
    }
  }
  if (plan.body) Object.assign(out, buildBodyQuestions());
  if (plan.neglect) {
    out.neglect_novelty = { type: "choice", instructions: onlyThinking("这份被晾着的委屈来自什么？"), criteria: { new_event: "这一轮新发生的等待", new_appraisal: "对等待的新理解", continuation: "只是延续", panel_echo: "只是在复述系统告诉{char}的" } };
    out.neglect_relation = { type: "choice", instructions: "对话内容支持{char}此刻觉得被晾着吗？", criteria: { supports: "支持", neutral: "中立", clarifies: "澄清原因", contradicts: "反驳" } };
    out.neglect_evidence = { type: "choice", instructions: "哪一段最直接证明这份被晾感？", criteria: evidence };
  }
  return fillPersona(out);
}

// ── material ───────────────────────────────────────────────────────────
//
// One turn = the character's reply to the latest user message (or a
// proactive message). Pass plain text; nothing here reads your storage format.
//
// turnKind:
//   "normal_reply"             reply to a user message
//   "first_reply_after_return" first reply after she was away (you decide the gap, e.g. 30 min)
//   "scheduled_proactive_wake" / "longing_wake" / "call_declined_wake"
//                              the character reaching out while she has not replied
//   "voicemail"                a voice note whose transcript stands in for thinking

// JSON permits lone UTF-16 surrogates, but Jev rejects them as invalid Unicode.
// Keep this compatible with older iOS Safari instead of relying on toWellFormed().
export function wellFormedEmotionText(value) {
  const input = String(value || "");
  let output = "";
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        output += input[i] + input[i + 1];
        i += 1;
      } else {
        output += "\uFFFD";
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      output += "\uFFFD";
    } else {
      output += input[i];
    }
  }
  return output;
}

function sliceEmotionText(value, limit) {
  return Array.from(wellFormedEmotionText(value)).slice(0, limit).join("");
}

export function segmentThinking(text, limit = 60) {
  return wellFormedEmotionText(text)
    .replace(/([。！？!?…])/g, "$1\n")
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((s, i) => ({ id: `t${i + 1}`, text: sliceEmotionText(s, 400) }));
}

function clip(text, n) {
  const s = wellFormedEmotionText(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : s;
}

export function buildEmotionMaterial({
  thinking = "",
  reply = "",
  userMessage = null,
  previousUserMessage = "",
  previousReply = "",
  turnKind = "normal_reply",
  waitedMinutes = null,
  voicemail = null,
  shownToCharacter = null,
} = {}) {
  const brief = [
    previousUserMessage ? `{user}：${clip(previousUserMessage, 40)}` : "",
    previousReply ? `{char}：${clip(previousReply, 40)}` : "",
  ].filter(Boolean).join("；");
  const isReply = turnKind === "normal_reply" || turnKind === "first_reply_after_return";
  return {
    thinking: segmentThinking(Array.isArray(thinking) ? thinking.join("") : thinking),
    reply: voicemail ? null : sliceEmotionText(reply, 4000),
    user_message: isReply && userMessage ? sliceEmotionText(userMessage, 2000) : null,
    voicemail: voicemail ? wellFormedEmotionText(voicemail) : null,
    turn_kind: turnKind,
    // The real wait on proactive turns, so Jev does not infer it from wording.
    waited_minutes: NEGLECT_EVIDENCE_ONLY_TURN_KINDS.has(turnKind) && Number.isFinite(Number(waitedMinutes)) && waitedMinutes !== null ? Math.max(0, Math.round(Number(waitedMinutes))) : null,
    shown_to_character_this_turn: shownToCharacter,
    previous_turn_brief: brief ? fillPersona(brief) : null,
  };
}

// ── answer acceptance (catalog 3.1) ───────────────────────────────────

export function decodeLevel(answer, { questionSet = null } = {}) {
  const p = answer?.probabilities;
  if (!p || typeof p !== "object") return { status: "unknown" };
  const hasEmbeddedDenied = Object.prototype.hasOwnProperty.call(p, "denied");
  const q2 = hasEmbeddedDenied && questionSet !== "emotion-jev-q1";
  const denied = q2 && hasEmbeddedDenied ? Math.max(0, Number(p.denied || 0)) : 0;
  if (denied >= 0.5) return { status: "denied", denied };
  const nm = Math.max(0, Number(p.not_mentioned || 0)) + denied;
  if (nm >= 0.5) return { status: "not_mentioned", notMentioned: nm };
  return decodeOrdinal(p, nm);
}

export function decodeI5(answer, labels = LEVEL_ORDER) {
  const p = answer?.probabilities;
  if (!p || typeof p !== "object") return { status: "unknown" };
  return decodeOrdinal(p, 0, labels);
}

// Adjacency is judged on the level options only, renormalized without
// "not mentioned": 25% "not mentioned" + 75% around "clear" is a clear
// judgement, not an unknown one. `mentioned` lets the converter scale the
// increment by how likely the feeling was mentioned at all.
function decodeOrdinal(p, nm, order = LEVEL_ORDER) {
  const raw = order.map(k => Math.max(0, Number(p[k] || 0)));
  const total = raw.reduce((a, b) => a + b, 0);
  const mentioned = Math.max(0, Math.min(1, 1 - nm));
  if (total <= 0) return { status: "unknown", adjacent: 0, notMentioned: nm, mentioned };
  const probs = raw.map(v => v / total);
  let mode = 0;
  probs.forEach((v, i) => { if (v > probs[mode]) mode = i; });
  const adjacent = probs.slice(Math.max(0, mode - 1), mode + 2).reduce((a, b) => a + b, 0);
  const index = probs.reduce((acc, v, i) => acc + v * i, 0);
  if (adjacent < 0.7) return { status: "unknown", adjacent, notMentioned: nm, mentioned };
  const level = LEVEL_ORDER[Math.round(index)] || LEVEL_ORDER[mode];
  const value = order === LEVEL_ORDER
    ? order.reduce((acc, k, i) => acc + I5_VALUE[k] * probs[i], 0)
    : index / Math.max(1, order.length - 1);
  return { status: "value", mode: order[mode], level, index, value, adjacent, notMentioned: nm, mentioned };
}

export function decodeNoul(answer) {
  const v = Number(answer?.noul);
  if (!Number.isFinite(v)) return { status: "unknown" };
  if (v >= 0.65) return { status: "yes", p: v };
  if (v <= 0.35) return { status: "no", p: v };
  return { status: "unknown", p: v };
}

export function decodeChoice(answer) {
  const p = answer?.probabilities;
  if (!p || typeof p !== "object") return { status: "unknown" };
  let top = null;
  for (const [k, v] of Object.entries(p)) if (!top || Number(v) > top[1]) top = [k, Number(v)];
  const confidence = Number(answer?.confidence ?? 0);
  if (!top || top[1] < 0.45 || confidence < 0.5) return { status: "unknown", top: top?.[0], p: top?.[1], confidence };
  return { status: "value", value: top[0], p: top[1], confidence };
}

// Compact, text-free decoded view of one scored turn, for the 心情 page.
export function summarizeEmotionAnswers(answers = {}, bodyAnswers = null, questionSet = "emotion-jev-q1", stage2Answers = null) {
  const dims = {};
  for (const [key] of EMOTION_DIMENSIONS) {
    const level = decodeLevel(answers[`level_${key}`], { questionSet });
    const denied = questionSet === "emotion-jev-q1" ? decodeNoul(answers[`denied_${key}`]).status : "unknown";
    const q9Self = stage2Answers?.[`replyself_level_${key}`] ? decodeI5(stage2Answers[`replyself_level_${key}`]) : null;
    const replySelf = answers.reply_self_any ? (q9Self?.status === "value" && q9Self.mode !== "none" ? "yes" : "no") : decodeNoul(answers[`replyself_${key}`]).status;
    let status = level.status;
    if (status === "not_mentioned" && denied === "yes") status = "denied";
    else if (status === "not_mentioned" && replySelf === "yes") status = "reply_self";
    dims[key] = { status, level: level.level || null, value: level.value ?? null, adjacent: level.adjacent ?? null, mentioned: level.mentioned ?? null };
  }
  const gates = {};
  for (const [key] of EMOTION_GATES) gates[key] = decodeNoul(answers[`gate_${key}`]);
  const out = {
    evidenceMode: decodeChoice(answers.evidence_mode),
    dims,
    gates,
    reappraisal: decodeNoul(answers.reappraisal),
    selfJudgment: decodeNoul(answers.self_judgment),
    restraintAction: decodeNoul(answers.restraint_action),
    texture: decodeChoice(answers.texture),
    replyEnding: decodeChoice(answers.reply_ending),
    bodyAny: decodeNoul(answers.body_any),
  };
  if (answers.neglect_level) {
    out.neglect = { level: decodeLevel(answers.neglect_level), understanding: decodeNoul(answers.understanding) };
  }
  if (bodyAnswers) {
    const visualOrder = ["none", "faint", "light", "clear", "strong"];
    out.body = {
      visualIntensity: decodeI5(bodyAnswers.visual_intensity, visualOrder),
      visualKind: decodeChoice(bodyAnswers.visual_kind),
      appeal: decodeI5(bodyAnswers.appeal, visualOrder),
      intent: decodeChoice(bodyAnswers.intent),
      careOverride: decodeNoul(bodyAnswers.care_override),
      tempted: decodeI5(bodyAnswers.tempted, visualOrder),
      touch: decodeI5(bodyAnswers.touch),
      touchReceptive: decodeNoul(bodyAnswers.touch_receptive),
      touchInitiator: decodeChoice(bodyAnswers.touch_initiator),
      approach: decodeI5(bodyAnswers.approach),
      language: decodeI5(bodyAnswers.language),
      recall: decodeI5(bodyAnswers.recall),
      shock: decodeI5(bodyAnswers.shock),
      selfDistress: decodeI5(bodyAnswers.self_distress),
      quality: decodeChoice(bodyAnswers.quality),
      stopSignal: decodeNoul(bodyAnswers.stop_signal),
    };
  }
  if (stage2Answers) {
    const followups = {};
    for (const [key] of EMOTION_DIMENSIONS) {
      if (!stage2Answers[`${key}_novelty`] && !stage2Answers[`replyself_level_${key}`]) continue;
      followups[key] = {
        target: decodeChoice(stage2Answers[`${key}_target`]),
        novelty: decodeChoice(stage2Answers[`${key}_novelty`]),
        relation: decodeChoice(stage2Answers[`${key}_relation`]),
        evidence: decodeChoice(stage2Answers[`${key}_evidence`]),
        label: decodeChoice(stage2Answers[`${key}_label`]),
        replySelfLevel: stage2Answers[`replyself_level_${key}`] ? decodeI5(stage2Answers[`replyself_level_${key}`]) : null,
      };
    }
    out.followups = followups;
  }
  return out;
}

// Stable id for "this exact reply + thinking was already scored".
export function emotionContentHash({ reply = "", thinking = "" } = {}) {
  const text = `${reply}\u0000${Array.isArray(thinking) ? thinking.join("") : thinking}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${text.length}:${h.toString(16)}`;
}
