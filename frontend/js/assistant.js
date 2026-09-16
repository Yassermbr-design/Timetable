// =========================================================
// assistant.js — natural-language command parsing and the
// propose → confirm → apply workflow. This is NOT an LLM: it's
// pattern matching (parseCommand/classifyIntent) that hands off
// to the deterministic scheduler (scheduler.js) for the actual
// "when" decision, then renders a proposal the user must
// explicitly confirm before anything is written to storage.
// =========================================================
import {
  fmtDate, addDays, toMinutes, toHHMM, WEEKDAYS, nextDateForWeekday, startOfWeekFor,
  catMeta, escapeHtml, fmt12, formatDuration, niceDate, uid
} from './utils.js';
import { events, prefs, saveEvents, removeEventById, removeEventsByIds } from './state.js';
import { eventsForDate, deleteEventOccurrence, setRecurOverride, clearRecurOverride } from './recurrence.js';
import {
  findFreeSlot, findMovableEventInWindow, findFreeSlotAnywhereInDay, findFreeGaps,
  findConflicts, analyzeScheduleHealth, findMissedEvents, distributeDeadlineTask
} from './scheduler.js';
import { renderAll, getWeekCursor } from './calendar.js';
import { showUndoToast, openModal, closeModal } from './ui.js';

const TIME_OF_DAY = {
  morning:   {start:'06:00', end:'12:00'},
  afternoon: {start:'12:00', end:'17:00'},
  evening:   {start:'17:00', end:'21:00'},
  night:     {start:'21:00', end:'23:59'},
};

function parseCommand(text){
  const raw = text.trim().toLowerCase();

  let duration = 30;
  const durMatch = raw.match(/for\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/);
  if(durMatch){
    const n = parseInt(durMatch[1],10);
    duration = /hour|hr/.test(durMatch[2]) ? n*60 : n;
  }

  let date = fmtDate(new Date());
  if(/\btomorrow\b/.test(raw)){
    date = fmtDate(addDays(new Date(),1));
  } else {
    const dow = WEEKDAYS.findIndex(d=>raw.includes(d.toLowerCase()));
    if(dow !== -1) date = nextDateForWeekday(dow);
  }

  let window = null;
  let timeKey = null;
  let usedLearnedWindow = false;
  const explicitTime = raw.match(/\b(\d{1,2}):?(\d{2})?\s*(am|pm)?\b/);
  for(const key of Object.keys(TIME_OF_DAY)){
    if(raw.includes(key)){ window = TIME_OF_DAY[key]; timeKey = key; break; }
  }
  if(!window && explicitTime && explicitTime[3]){
    let h = parseInt(explicitTime[1],10);
    const m = explicitTime[2]?parseInt(explicitTime[2],10):0;
    if(explicitTime[3]==='pm' && h!==12) h+=12;
    if(explicitTime[3]==='am' && h===12) h=0;
    const startM = h*60+m;
    window = {start: toHHMM(startM), end: toHHMM(startM+180)};
  }

  let activity = raw
    .replace(/\bfor\s+\d+\s*(minutes?|mins?|hours?|hrs?)\b/,'')
    .replace(/\btomorrow\b/,'')
    .replace(new RegExp(WEEKDAYS.join('|'),'ig'),'')
    .replace(/\b(morning|afternoon|evening|night)\b/,'')
    .replace(/\b(i want to|i'd like to|i need to|please|can you|schedule|add|plan)\b/g,'')
    .replace(/\s+/g,' ')
    .trim();
  if(!activity) activity = 'New activity';
  activity = activity.charAt(0).toUpperCase()+activity.slice(1);

  if(!window){
    const learned = learnPreferredWindow(guessCategory(activity));
    if(learned){
      window = TIME_OF_DAY[learned];
      timeKey = learned;
      usedLearnedWindow = true;
    } else {
      window = TIME_OF_DAY.morning;
      timeKey = 'morning';
    }
  }

  return { activity, date, duration, windowStart: window.start, windowEnd: window.end, timeKey, usedLearnedWindow };
}

/* =========================================================
   INTENT CLASSIFICATION + QUERY/DELETE/MOVE HANDLING
   The parser now distinguishes Create / Move / Delete /
   Query / Optimize instead of only ever creating events.
   ========================================================= */
function classifyIntent(text){
  const t = text.trim().toLowerCase();
  if(/^(delete|remove|cancel)\b/.test(t)) return 'delete';
  if(/^move\b/.test(t)) return 'move';
  if(/what'?s next|whats next|what is next|what should i do now|what should i be doing/.test(t)) return 'query-next';
  if(/what'?s free|whats free|free tomorrow|free today|free this|when am i free|when am i available/.test(t)) return 'query-free';
  if(/evening look like|what'?s my evening|whats my evening|my evening look/.test(t)) return 'query-evening';
  if(/too much (scheduled|going on)|overloaded|too busy|too many things/.test(t)) return 'health-check';
  if(/reschedule.*(missed|skipped)|missed.*(task|session|event)/.test(t)) return 'reschedule-missed';
  if(/plan my week/.test(t)) return 'plan-week';
  if(/plan my (day|today|evening)/.test(t)) return 'plan-day';
  if(/^(i )?don'?t want|^stop scheduling|^never schedule/.test(t)) return 'preference-statement';
  return 'create';
}

function extractDateHint(raw){
  const t = raw.toLowerCase();
  if(/\btomorrow\b/.test(t)) return { date: fmtDate(addDays(new Date(),1)), match:'tomorrow' };
  if(/\btoday\b/.test(t)) return { date: fmtDate(new Date()), match:'today' };
  const dow = WEEKDAYS.findIndex(d=>t.includes(d.toLowerCase()));
  if(dow!==-1) return { date: nextDateForWeekday(dow), match: WEEKDAYS[dow].toLowerCase() };
  return null;
}

function findEventByQuery(raw, dateHint){
  let phrase = raw.toLowerCase();
  ['delete','remove','cancel','move','my','the','session','event','a','an','to','on','tomorrow','today']
    .concat(dateHint ? [dateHint.match] : [])
    .forEach(w=>{ phrase = phrase.replace(new RegExp('\\b'+w+'\\b','gi'),' '); });
  phrase = phrase.replace(/\s+/g,' ').trim();
  const words = phrase.split(' ').filter(w=>w.length>2);

  let pool = [];
  if(dateHint){
    pool = eventsForDate(dateHint.date);
  } else {
    for(let i=0;i<14;i++) pool = pool.concat(eventsForDate(fmtDate(addDays(new Date(),i))));
  }
  let best = null, bestScore = 0;
  pool.forEach(e=>{
    const titleLower = e.title.toLowerCase();
    let score = 0;
    words.forEach(w=>{ if(titleLower.includes(w)) score++; });
    if(score > bestScore){ bestScore = score; best = e; }
  });
  return bestScore > 0 ? best : null;
}

function handleDeleteIntent(text){
  const dateHint = extractDateHint(text);
  const match = findEventByQuery(text, dateHint);
  if(!match){
    renderProposal({ reason:`Couldn't find an event matching "${text}"${dateHint?` on ${niceDate(dateHint.date)}`:''}. Try being more specific, or delete it directly from Today or Week.`, items:[], dismissOnly:true });
    return;
  }
  pendingProposal = { type:'delete', targetId: match.id };
  renderProposal({
    reason: `Delete this event? You can undo it right after.`,
    items: [{ title: match.title, category: match.category, from: match.start, to: toHHMM(toMinutes(match.start)+match.duration) }],
    confirmLabel: 'Delete event',
    hideTryAnother: true
  });
}

function handleMoveIntent(text){
  const parts = text.split(/\bto\b/i);
  const beforeTo = parts[0] || text;
  const afterTo = parts.length > 1 ? parts.slice(1).join(' to ') : '';
  const match = findEventByQuery(beforeTo, null);
  if(!match){
    renderProposal({ reason:`Couldn't find an event matching "${beforeTo.trim()}". Try being more specific.`, items:[], dismissOnly:true });
    return;
  }
  const dateHint = extractDateHint(afterTo) || extractDateHint(text);
  const targetDate = dateHint ? dateHint.date : match.date;

  const timeMatch = afterTo.match(/\b(\d{1,2}):?(\d{2})?\s*(am|pm)\b/i);
  let targetStart;
  if(timeMatch){
    let h = parseInt(timeMatch[1],10);
    const m = timeMatch[2] ? parseInt(timeMatch[2],10) : 0;
    const mer = timeMatch[3].toLowerCase();
    if(mer==='pm' && h!==12) h += 12;
    if(mer==='am' && h===12) h = 0;
    targetStart = toHHMM(h*60+m);
  } else {
    let windowKey = null;
    for(const key of Object.keys(TIME_OF_DAY)){ if(afterTo.toLowerCase().includes(key)){ windowKey = key; break; } }
    const win = TIME_OF_DAY[windowKey || 'morning'];
    const free = findFreeSlot(targetDate, match.duration, toMinutes(win.start), toMinutes(win.end), match.category);
    targetStart = free !== null ? toHHMM(free) : match.start;
  }

  const conflicts = findConflicts(targetDate, targetStart, match.duration, match.id.includes('::') ? match._anchorId : match.id);
  pendingProposal = {
    type:'move-existing',
    targetId: match.id,
    isRecurring: match.id.includes('::'),
    snapshot: { title: match.title, category: match.category, duration: match.duration, flex: match.flex, subtasks: match.subtasks||[] },
    oldDate: match.date, oldStart: match.start,
    newDate: targetDate, newStart: targetStart
  };
  renderProposal({
    reason: conflicts.length
      ? `Heads up — this overlaps with ${conflicts.map(c=>c.title).join(', ')}. You can still apply it.`
      : `Moving to ${niceDate(targetDate)} at ${fmt12(targetStart)}, no conflicts.`,
    items: [
      { title: `${match.title} — current`, category: match.category, from: match.start, to: toHHMM(toMinutes(match.start)+match.duration) },
      { title: `${match.title} — new time`, category: match.category, from: targetStart, to: toHHMM(toMinutes(targetStart)+match.duration), moved:true },
    ],
    confirmLabel: 'Move event',
    hideTryAnother: true
  });
}

function handleQueryNext(){
  const today = fmtDate(new Date());
  const list = eventsForDate(today);
  const nowMin = new Date().getHours()*60 + new Date().getMinutes();
  const sorted = list.slice().sort((a,b)=>toMinutes(a.start)-toMinutes(b.start));
  const current = sorted.find(e=>{ const s=toMinutes(e.start); return !e.done && nowMin>=s && nowMin<s+e.duration; });
  const next = sorted.find(e=>{ const s=toMinutes(e.start); return !e.done && s >= (current ? toMinutes(current.start)+current.duration : nowMin); });
  let reason;
  if(current && next) reason = `Right now: ${current.title}, until ${fmt12(toHHMM(toMinutes(current.start)+current.duration))}. Next up: ${next.title} at ${fmt12(next.start)}.`;
  else if(current) reason = `Right now: ${current.title}, until ${fmt12(toHHMM(toMinutes(current.start)+current.duration))}. Nothing else planned after that.`;
  else if(next) reason = `Nothing right now. Next up: ${next.title} at ${fmt12(next.start)}.`;
  else reason = `Nothing scheduled for the rest of today.`;
  renderProposal({ reason, items:[], dismissOnly:true });
}

function handleQueryFree(text){
  const dateHint = extractDateHint(text) || { date: fmtDate(new Date()) };
  const gaps = findFreeGaps(dateHint.date);
  const reason = gaps.length
    ? `Free on ${niceDate(dateHint.date)}: ` + gaps.map(g=>`${fmt12(g.start)}–${fmt12(g.end)}`).join(', ')
    : `No real gaps on ${niceDate(dateHint.date)} — it's fully booked.`;
  renderProposal({ reason, items:[], dismissOnly:true });
}

function handleQueryEvening(){
  const today = fmtDate(new Date());
  const eveningStart = toMinutes('17:00'), eveningEnd = toMinutes('21:00');
  const list = eventsForDate(today).filter(e=>{
    const s = toMinutes(e.start);
    return s < eveningEnd && s + e.duration > eveningStart;
  }).sort((a,b)=>toMinutes(a.start)-toMinutes(b.start));
  const reason = list.length
    ? `Your evening: ` + list.map(e=>`${catMeta(e.category).icon} ${e.title} at ${fmt12(e.start)}`).join(', ')
    : `Your evening is open — nothing scheduled 5–9 PM.`;
  renderProposal({ reason, items:[], dismissOnly:true });
}

/* =========================================================
   SCHEDULE HEALTH — deterministic checks for overload, back-
   to-back marathons, sleep-window conflicts, and heavy work
   days. Informational by default; offers one fix when a
   flexible event can relieve the top issue.
   ========================================================= */
function proposeHealthFix(date, health){
  const candidate = health.sorted.find(e=> !e.done && e.flex==='flexible' && prefs.flexible[e.category]!==false);
  if(candidate){
    const excludeId = candidate.id.includes('::') ? candidate._anchorId : candidate.id;
    const tomorrow = fmtDate(addDays(new Date(date+'T00:00:00'), 1));
    const altStart = findFreeSlotAnywhereInDay(tomorrow, candidate.duration, null, candidate.category);
    if(altStart !== null){
      pendingProposal = {
        type:'move-existing', targetId:candidate.id, isRecurring: candidate.id.includes('::'),
        snapshot:{ title:candidate.title, category:candidate.category, duration:candidate.duration, flex:candidate.flex, subtasks:candidate.subtasks||[] },
        oldDate:candidate.date, oldStart:candidate.start, newDate:tomorrow, newStart:toHHMM(altStart)
      };
      renderProposal({
        reason: `⚠ ${health.issues[0]}\nI recommend moving "${candidate.title}" to ${niceDate(tomorrow)} to lighten the day.`,
        items:[
          { title:`${candidate.title} — current`, category:candidate.category, from:candidate.start, to:toHHMM(toMinutes(candidate.start)+candidate.duration) },
          { title:`${candidate.title} — new time`, category:candidate.category, from:toHHMM(altStart), to:toHHMM(altStart+candidate.duration), moved:true },
        ],
        confirmLabel:'Apply suggestion', hideTryAnother:true
      });
      return true;
    }
  }
  return false;
}

function runOptimizeSchedule(dateOverride){
  const date = dateOverride || fmtDate(new Date());
  const health = analyzeScheduleHealth(date);
  if(health.issues.length === 0){
    renderProposal({ reason:`${niceDate(date)} looks healthy — well-paced, no overload, no conflicts.`, items:[], dismissOnly:true });
    return;
  }
  if(proposeHealthFix(date, health)) return;
  renderProposal({
    reason: `Found ${health.issues.length} thing${health.issues.length>1?'s':''} worth knowing about ${niceDate(date)}:\n` + health.issues.map(i=>'⚠ '+i).join('\n'),
    items: [], dismissOnly:true
  });
}

function handleHealthCheckIntent(text){
  const dateHint = extractDateHint(text) || { date: fmtDate(new Date()) };
  runOptimizeSchedule(dateHint.date);
}

/* =========================================================
   SMART RESCHEDULING FOR MISSED EVENTS
   ========================================================= */
let missedRescheduleState = null;
function proposeMissedReschedule(target, altIndex){
  const now = new Date();
  const todayStr = fmtDate(now);
  const tomorrowStr = fmtDate(addDays(now,1));
  const nowMin = now.getHours()*60 + now.getMinutes();
  const sleepStartMin = toMinutes(prefs.sleepStart);
  const todayWindowEnd = sleepStartMin > nowMin ? sleepStartMin : 1440;

  const alts = [];
  const a1 = findFreeSlot(todayStr, target.duration, nowMin, todayWindowEnd, target.category);
  if(a1 !== null) alts.push({ date: todayStr, start: toHHMM(a1) });
  const a2 = findFreeSlot(tomorrowStr, target.duration, toMinutes(prefs.sleepEnd), toMinutes(prefs.sleepStart), target.category);
  if(a2 !== null) alts.push({ date: tomorrowStr, start: toHHMM(a2) });

  if(alts.length === 0){
    renderProposal({ reason:`Missed "${target.title}" — but I couldn't find a free slot today or tomorrow. Try picking a time yourself.`, items:[], dismissOnly:true });
    return;
  }
  const idx = ((altIndex||0) % alts.length + alts.length) % alts.length;
  const chosen = alts[idx];
  missedRescheduleState = { target, alts, idx };
  pendingTryAnotherHandler = ()=> proposeMissedReschedule(missedRescheduleState.target, missedRescheduleState.idx+1);

  pendingProposal = {
    type:'move-existing', targetId: target.id, isRecurring: target.id.includes('::'),
    snapshot: { title:target.title, category:target.category, duration:target.duration, flex:target.flex, subtasks:target.subtasks||[] },
    oldDate: target.date, oldStart: target.start, newDate: chosen.date, newStart: chosen.start
  };
  renderProposal({
    reason: `You missed "${target.title}" (was ${niceDate(target.date)} ${fmt12(target.start)}).` + (alts.length>1 ? ' Use "Choose another time" to see the other open slot.' : ''),
    items: [{ title: target.title, category: target.category, from: chosen.start, to: toHHMM(toMinutes(chosen.start)+target.duration), moved:true }],
    confirmLabel: 'Reschedule',
    hideTryAnother: alts.length <= 1
  });
}

function rescheduleMissedTasks(){
  const missed = findMissedEvents();
  if(missed.length === 0){
    renderProposal({ reason:`Nothing missed — you're all caught up.`, items:[], dismissOnly:true });
    return;
  }
  proposeMissedReschedule(missed[0], 0);
}

/* =========================================================
   DEADLINE TASKS — split a chunk of estimated effort into
   several sessions spread across the days leading up to a
   deadline. If the user supplies their own sub-parts, those
   are distributed one per session (their content, not
   invented); otherwise sessions get plain "part N of M"
   labels — never fabricated subject-matter content.
   ========================================================= */
export function openDeadlineTaskProposal(title, deadlineDate, totalMinutes, subParts, category){
  const { sessions, daysAvailable } = distributeDeadlineTask(title, deadlineDate, totalMinutes, subParts, category);
  if(daysAvailable.length === 0){
    renderProposal({ reason:`That deadline (${deadlineDate}) is already in the past — pick a date from today onward.`, items:[], dismissOnly:true });
    return;
  }
  const placed = sessions.filter(s=>s.start!==null);
  const unplaced = sessions.filter(s=>s.start===null);
  if(placed.length === 0){
    renderProposal({ reason:`I couldn't find any free slots before ${niceDate(deadlineDate)} for "${title}". Try a longer window or a lighter schedule.`, items:[], dismissOnly:true });
    return;
  }

  const taskId = uid();
  pendingProposal = {
    type:'deadline-task-apply', taskId, category, flex:'flexible',
    sessions: placed.map(s=>({ title:s.label, date:s.date, start:toHHMM(s.start), duration:s.duration }))
  };
  let reason = `Split ${formatDuration(totalMinutes)} of "${title}" into ${placed.length} session${placed.length>1?'s':''} before ${niceDate(deadlineDate)}, fit around your existing schedule.`;
  if(unplaced.length){
    reason += `\n⚠ Couldn't fit ${unplaced.length} session${unplaced.length>1?'s':''} — the days were too full.`;
  }
  renderProposal({
    reason,
    items: placed.map(s=>({ title:s.label, category, from:toHHMM(s.start), to:toHHMM(s.start+s.duration) })),
    confirmLabel: 'Add to schedule',
    hideTryAnother: true
  });
}

export function planMyDay(){
  const today = fmtDate(new Date());
  const list = eventsForDate(today).filter(e=>!e.done);
  const sorted = list.slice().sort((a,b)=>toMinutes(a.start)-toMinutes(b.start));
  const moves = [];
  const consumed = new Set();
  for(let i=0;i<sorted.length;i++){
    for(let j=i+1;j<sorted.length;j++){
      const a = sorted[i], b = sorted[j];
      const aEnd = toMinutes(a.start)+a.duration, bStart = toMinutes(b.start);
      if(bStart >= aEnd) continue;
      const flexible = b.flex==='flexible' ? b : (a.flex==='flexible' ? a : null);
      if(flexible && !consumed.has(flexible.id)){
        const altStart = findFreeSlotAnywhereInDay(today, flexible.duration, flexible.id.includes('::') ? flexible._anchorId : flexible.id, flexible.category);
        if(altStart !== null){
          moves.push({ id:flexible.id, isRecurring: flexible.id.includes('::'), title:flexible.title, category:flexible.category, duration:flexible.duration, flex:flexible.flex, subtasks:flexible.subtasks||[], oldStart:flexible.start, newStart:toHHMM(altStart) });
          consumed.add(flexible.id);
        }
      }
    }
  }
  if(moves.length === 0){
    const gaps = findFreeGaps(today).sort((a,b)=>(toMinutes(b.end)-toMinutes(b.start))-(toMinutes(a.end)-toMinutes(a.start)));
    const biggest = gaps[0];
    renderProposal({
      reason: biggest ? `No conflicts today. Your biggest open block is ${fmt12(biggest.start)}–${fmt12(biggest.end)}.` : `No conflicts today, and the day's fully booked.`,
      items: [], dismissOnly:true
    });
    return;
  }
  pendingProposal = { type:'plan-day-apply', date:today, moves };
  renderProposal({
    reason: `Found ${moves.length} conflict${moves.length>1?'s':''} today. Moving the flexible event${moves.length>1?'s':''} clears them without touching anything fixed.`,
    items: moves.map(m=>({ title:m.title, category:m.category, from:m.newStart, to:toHHMM(toMinutes(m.newStart)+m.duration), moved:true })),
    confirmLabel: 'Apply plan',
    hideTryAnother: true
  });
}

export function planMyWeek(){
  const startOfWeek = startOfWeekFor(getWeekCursor());
  const days = [];
  for(let i=0;i<7;i++) days.push(fmtDate(addDays(startOfWeek,i)));

  const moves = [];
  const consumed = new Set();

  // 1. Resolve same-day conflicts across every day in the week (fixed events never move)
  days.forEach(date=>{
    const sorted = eventsForDate(date).filter(e=>!e.done).sort((a,b)=>toMinutes(a.start)-toMinutes(b.start));
    for(let i=0;i<sorted.length;i++){
      for(let j=i+1;j<sorted.length;j++){
        const a = sorted[i], b = sorted[j];
        const aEnd = toMinutes(a.start)+a.duration, bStart = toMinutes(b.start);
        if(bStart >= aEnd) continue;
        const flexible = b.flex==='flexible' ? b : (a.flex==='flexible' ? a : null);
        if(flexible && !consumed.has(flexible.id)){
          const excludeId = flexible.id.includes('::') ? flexible._anchorId : flexible.id;
          const altStart = findFreeSlotAnywhereInDay(date, flexible.duration, excludeId, flexible.category);
          if(altStart !== null){
            moves.push({ id:flexible.id, isRecurring:flexible.id.includes('::'), title:flexible.title, category:flexible.category, duration:flexible.duration, flex:flexible.flex, subtasks:flexible.subtasks||[], oldDate:date, oldStart:flexible.start, newDate:date, newStart:toHHMM(altStart), reason:'conflict' });
            consumed.add(flexible.id);
          }
        }
      }
    }
  });

  // 2. If the week isn't dominated by conflict-fixes, look for one clearly overloaded day
  //    and offer to move a flexible event from it to the lightest day.
  if(moves.length < 2){
    const loadByDay = days.map(date=>({
      date,
      list: eventsForDate(date).filter(e=>!e.done),
      total: eventsForDate(date).filter(e=>!e.done).reduce((sum,e)=>sum+e.duration,0)
    }));
    const busiest = loadByDay.slice().sort((a,b)=>b.total-a.total)[0];
    const lightest = loadByDay.slice().sort((a,b)=>a.total-b.total)[0];
    if(busiest && lightest && busiest.date !== lightest.date && (busiest.total - lightest.total) >= 120){
      const candidate = busiest.list.find(e=> e.flex==='flexible' && prefs.flexible[e.category]!==false && !consumed.has(e.id));
      if(candidate){
        const excludeId = candidate.id.includes('::') ? candidate._anchorId : candidate.id;
        const altStart = findFreeSlotAnywhereInDay(lightest.date, candidate.duration, excludeId, candidate.category);
        if(altStart !== null){
          moves.push({ id:candidate.id, isRecurring:candidate.id.includes('::'), title:candidate.title, category:candidate.category, duration:candidate.duration, flex:candidate.flex, subtasks:candidate.subtasks||[], oldDate:busiest.date, oldStart:candidate.start, newDate:lightest.date, newStart:toHHMM(altStart), reason:'balance' });
          consumed.add(candidate.id);
        }
      }
    }
  }

  if(moves.length === 0){
    renderProposal({ reason:`This week looks well balanced — no conflicts, and no day is significantly overloaded.`, items:[], dismissOnly:true });
    return;
  }

  const conflictCount = moves.filter(m=>m.reason==='conflict').length;
  const balanceCount = moves.filter(m=>m.reason==='balance').length;
  let reasonParts = [];
  if(conflictCount) reasonParts.push(`${conflictCount} conflict fix${conflictCount>1?'es':''}`);
  if(balanceCount) reasonParts.push(`${balanceCount} to even out an overloaded day`);

  pendingProposal = { type:'plan-week-apply', moves };
  renderProposal({
    reason: `Found ${reasonParts.join(' and ')} this week — fixed events stay untouched.`,
    items: moves.map(m=>({
      title: `${m.title} (${WEEKDAYS[new Date(m.newDate+'T00:00:00').getDay()].slice(0,3)})`,
      category: m.category, from: m.newStart, to: toHHMM(toMinutes(m.newStart)+m.duration), moved:true
    })),
    confirmLabel: 'Apply plan',
    hideTryAnother: true
  });
}

let pendingProposal = null;
let lastParsedCommand = null;
let pendingTryAnotherHandler = null; // overrides the default "Choose another time" behavior for proposals that aren't the create-flow

/* =========================================================
   ASSISTANT CHAT HISTORY — session-only log of exchanges,
   so the user can scroll back through what they asked and
   what the assistant did about it.
   ========================================================= */
let assistantHistory = [];
export function logAssistantTurn(role, text){
  assistantHistory.push({ role, text, time: new Date() });
  if(assistantHistory.length > 60) assistantHistory.shift();
}
function renderAssistantHistory(){
  const wrap = document.getElementById('historyModalBody');
  if(assistantHistory.length === 0){
    wrap.innerHTML = `<div class="subtask-empty">No assistant activity yet this session — try asking for something below.</div>`;
    return;
  }
  wrap.innerHTML = assistantHistory.map(turn=>{
    const timeLabel = turn.time.toLocaleTimeString(undefined, {hour:'numeric', minute:'2-digit'});
    return `<div class="history-turn history-${turn.role}">
      <div class="history-role">${turn.role === 'user' ? 'You' : '✨ Assistant'} <span class="history-time">${timeLabel}</span></div>
      <div class="history-text">${escapeHtml(turn.text)}</div>
    </div>`;
  }).join('');
  wrap.scrollTop = wrap.scrollHeight;
}

let lastWindowKeyIndex = 0;
const TIME_OF_DAY_ORDER = ['morning','afternoon','evening','night'];

function handleCommand(text){
  if(!text.trim()) return;
  logAssistantTurn('user', text);
  pendingTryAnotherHandler = null;
  const intent = classifyIntent(text);
  if(intent === 'delete'){ handleDeleteIntent(text); return; }
  if(intent === 'move'){ handleMoveIntent(text); return; }
  if(intent === 'query-next'){ handleQueryNext(); return; }
  if(intent === 'query-free'){ handleQueryFree(text); return; }
  if(intent === 'query-evening'){ handleQueryEvening(); return; }
  if(intent === 'health-check'){ handleHealthCheckIntent(text); return; }
  if(intent === 'reschedule-missed'){ rescheduleMissedTasks(); return; }
  if(intent === 'plan-day'){ planMyDay(); return; }
  if(intent === 'plan-week'){ planMyWeek(); return; }
  if(intent === 'preference-statement'){
    renderProposal({
      reason: `I can't change scheduling rules from a description like that yet — but you can set this precisely in Preferences (sleep hours, work hours, exercise window, and which categories I'm allowed to move).`,
      items: [], dismissOnly:true
    });
    return;
  }
  const parsed = parseCommand(text);
  if(!parsed.activity || parsed.activity === 'New activity'){
    renderProposal({
      reason: `I'm not sure what to schedule — could you name the activity? For example: "Study tomorrow evening for 2 hours".`,
      items: [], dismissOnly:true
    });
    return;
  }
  lastParsedCommand = parsed;
  lastWindowKeyIndex = TIME_OF_DAY_ORDER.indexOf(parsed.timeKey) !== -1 ? TIME_OF_DAY_ORDER.indexOf(parsed.timeKey) : 0;
  proposeForWindow(parsed, parsed.windowStart, parsed.windowEnd);
}

function tryAnotherTime(){
  if(!lastParsedCommand) return;
  lastWindowKeyIndex = (lastWindowKeyIndex + 1) % TIME_OF_DAY_ORDER.length;
  const key = TIME_OF_DAY_ORDER[lastWindowKeyIndex];
  const window = TIME_OF_DAY[key];
  proposeForWindow(lastParsedCommand, window.start, window.end);
}

function proposeForWindow(parsed, windowStart, windowEnd){
  const ws = toMinutes(windowStart);
  const we = toMinutes(windowEnd);

  const activityCategory = guessCategory(parsed.activity);
  const freeSlot = findFreeSlot(parsed.date, parsed.duration, ws, we, activityCategory);

  if(freeSlot !== null){
    pendingProposal = {
      type:'add',
      event:{ id:uid(), title:parsed.activity, date:parsed.date, start:toHHMM(freeSlot), duration:parsed.duration, category:guessCategory(parsed.activity), flex:'flexible', done:false }
    };
    const checks = [`✓ You're free at ${fmt12(toHHMM(freeSlot))}`, `✓ Fits within ${fmt12(windowStart)}–${fmt12(windowEnd)}`, `✓ No conflicts with existing events`];
    if(parsed.usedLearnedWindow){
      checks.push(`💡 You usually schedule ${activityCategory} in the ${parsed.timeKey} — I used that since you didn't say a time`);
    }
    renderProposal({
      reason: `I chose ${fmt12(toHHMM(freeSlot))} on ${niceDate(parsed.date)} because:\n` + checks.join('\n'),
      items: [{ title: parsed.activity, category: guessCategory(parsed.activity), from: toHHMM(freeSlot), to: toHHMM(freeSlot+parsed.duration) }]
    });
    return;
  }

  const movable = findMovableEventInWindow(parsed.date, ws, we);
  if(movable){
    const altSlot = findFreeSlotAnywhereInDay(parsed.date, movable.duration, movable.id, movable.category);
    if(altSlot !== null){
      pendingProposal = {
        type:'move-and-add',
        moveId: movable.id,
        newStartForMoved: toHHMM(altSlot),
        event:{ id:uid(), title:parsed.activity, date:parsed.date, start: movable.start, duration:parsed.duration, category:guessCategory(parsed.activity), flex:'flexible', done:false }
      };
      renderProposal({
        reason: `No open slot for ${parsed.activity} — but "${movable.title}" is flexible, so it moves to make room, avoiding any conflicts.`,
        items: [
          { title: movable.title, category: movable.category, from: toHHMM(altSlot), to: toHHMM(altSlot+movable.duration), moved:true },
          { title: parsed.activity, category: guessCategory(parsed.activity), from: movable.start, to: toHHMM(toMinutes(movable.start)+parsed.duration) },
        ]
      });
      return;
    }
  }

  renderProposal({
    reason: `No free time and nothing movable for ${parsed.activity} on ${niceDate(parsed.date)} between ${fmt12(windowStart)} and ${fmt12(windowEnd)}. Try another window, or add it manually and mark something as flexible.`,
    items: [],
    dismissOnly: true
  });
}

function guessCategory(text){
  const t = text.toLowerCase();
  if(/run|gym|workout|exercise|yoga|swim/.test(t)) return 'Exercise';
  if(/study|read|homework|revise/.test(t)) return 'Study';
  if(/shop|groc|errand|buy/.test(t)) return 'Shopping';
  if(/meeting|call|standup|work/.test(t)) return 'Work';
  return 'Free time';
}

/* =========================================================
   LEARNED PREFERENCES — a light, honest form of personalization:
   when there's no explicit time-of-day in a request, check
   whether the user has a clear historical pattern for that
   category (from completed, non-recurring events only, so the
   signal reflects real behavior) before falling back to a
   generic default. Requires a real majority, not a guess.
   ========================================================= */
function learnPreferredWindow(category){
  const doneEvents = events.filter(e=> e.category===category && e.done && !(e.recurrence && e.recurrence.type!=='none'));
  if(doneEvents.length < 3) return null;
  const counts = {morning:0, afternoon:0, evening:0, night:0};
  doneEvents.forEach(e=>{
    const m = toMinutes(e.start);
    if(m < toMinutes('12:00')) counts.morning++;
    else if(m < toMinutes('17:00')) counts.afternoon++;
    else if(m < toMinutes('21:00')) counts.evening++;
    else counts.night++;
  });
  const top = Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
  return (counts[top] / doneEvents.length >= 0.5) ? top : null;
}

/* =========================================================
   PROPOSAL RENDERING + APPLYING
   ========================================================= */
function renderProposal(plan){
  logAssistantTurn('assistant', plan.reason);
  const wrap = document.getElementById('proposalWrap');
  wrap.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'proposal';
  card.setAttribute('role','region');
  card.setAttribute('aria-label','Suggested plan');
  const itemsHtml = plan.items.map(it=>{
    const meta = catMeta(it.category);
    return `<div class="plan-item" style="--cat-bg:var(${meta.bg});--cat-ink:var(${meta.ink});--cat-solid:var(${meta.solid});">
      <span class="pi-title">${meta.icon} ${escapeHtml(it.title)}${it.moved?' <span class="pi-moved">moved</span>':''}</span>
      <span class="pi-time">${fmt12(it.from)} <span class="pi-arrow">→</span> ${fmt12(it.to)}</span>
    </div>`;
  }).join('');
  card.innerHTML = `
    <div class="eyebrow">${plan.items.length ? 'Suggested plan' : 'No match found'}</div>
    ${itemsHtml}
    <div class="plan-reason"><strong>Reason:</strong> ${escapeHtml(plan.reason)}</div>
    <div class="actions">
      ${plan.dismissOnly ? '' : `<button class="primary" id="confirmProposal">${escapeHtml(plan.confirmLabel || 'Apply changes')}</button>`}
      ${(plan.dismissOnly || plan.hideTryAnother) ? '' : '<button class="ghost" id="tryAnotherTimeBtn">Choose another time</button>'}
      <button class="ghost" id="rejectProposal">Cancel</button>
    </div>
  `;
  wrap.appendChild(card);
  if(!plan.dismissOnly){
    document.getElementById('confirmProposal').onclick = confirmProposal;
    const tryBtn = document.getElementById('tryAnotherTimeBtn');
    if(tryBtn) tryBtn.onclick = ()=> (pendingTryAnotherHandler || tryAnotherTime)();
  }
  document.getElementById('rejectProposal').onclick = ()=>{ wrap.innerHTML=''; pendingProposal=null; };
}

function confirmProposal(){
  if(!pendingProposal) return;
  const p = pendingProposal;

  if(p.type==='delete'){
    document.getElementById('proposalWrap').innerHTML = '';
    pendingProposal = null;
    deleteEventOccurrence(p.targetId); // manages its own undo toast
    return;
  }

  if(p.type==='move-existing'){
    let undoLocal;
    if(p.isRecurring){
      setRecurOverride(p.targetId, {skipped:true});
      const newEv = { id:uid(), title:p.snapshot.title, date:p.newDate, start:p.newStart, duration:p.snapshot.duration, category:p.snapshot.category, flex:p.snapshot.flex, done:false, subtasks:p.snapshot.subtasks };
      events.push(newEv);
      undoLocal = ()=>{
        clearRecurOverride(p.targetId);
        removeEventById(newEv.id);
        saveEvents(events);
        renderAll();
      };
    } else {
      const ev = events.find(e=>e.id===p.targetId);
      if(ev){ ev.date = p.newDate; ev.start = p.newStart; }
      undoLocal = ()=>{
        const e2 = events.find(e=>e.id===p.targetId);
        if(e2){ e2.date = p.oldDate; e2.start = p.oldStart; }
        saveEvents(events);
        renderAll();
      };
    }
    saveEvents(events);
    document.getElementById('proposalWrap').innerHTML = '';
    pendingProposal = null;
    showUndoToast('Event moved', undoLocal);
    renderAll();
    return;
  }

  if(p.type==='deadline-task-apply'){
    const newIds = p.sessions.map(s=>{
      const ev = { id:uid(), title:s.title, date:s.date, start:s.start, duration:s.duration, category:p.category, flex:p.flex, done:false, subtasks:[], taskId:p.taskId };
      events.push(ev);
      return ev.id;
    });
    saveEvents(events);
    document.getElementById('proposalWrap').innerHTML = '';
    pendingProposal = null;
    showUndoToast(`Added ${newIds.length} session${newIds.length>1?'s':''}`, ()=>{
      removeEventsByIds(newIds);
      saveEvents(events);
      renderAll();
    });
    renderAll();
    return;
  }

  if(p.type==='plan-day-apply'){
    const undoData = [];
    p.moves.forEach(m=>{
      if(m.isRecurring){
        setRecurOverride(m.id, {skipped:true});
        const newEv = { id:uid(), title:m.title, date:p.date, start:m.newStart, duration:m.duration, category:m.category, flex:m.flex||'flexible', done:false, subtasks:m.subtasks||[] };
        events.push(newEv);
        undoData.push({recurring:true, occId:m.id, newId:newEv.id});
      } else {
        const ev = events.find(e=>e.id===m.id);
        if(ev){ undoData.push({recurring:false, id:ev.id, oldStart:ev.start}); ev.start = m.newStart; }
      }
    });
    saveEvents(events);
    document.getElementById('proposalWrap').innerHTML = '';
    pendingProposal = null;
    showUndoToast(`Plan applied — ${p.moves.length} event${p.moves.length>1?'s':''} moved`, ()=>{
      undoData.forEach(u=>{
        if(u.recurring){ clearRecurOverride(u.occId); removeEventById(u.newId); }
        else { const ev = events.find(e=>e.id===u.id); if(ev) ev.start = u.oldStart; }
      });
      saveEvents(events);
      renderAll();
    });
    renderAll();
    return;
  }

  if(p.type==='plan-week-apply'){
    const undoData = [];
    p.moves.forEach(m=>{
      if(m.isRecurring){
        setRecurOverride(m.id, {skipped:true});
        const newEv = { id:uid(), title:m.title, date:m.newDate, start:m.newStart, duration:m.duration, category:m.category, flex:m.flex||'flexible', done:false, subtasks:m.subtasks||[] };
        events.push(newEv);
        undoData.push({recurring:true, occId:m.id, newId:newEv.id});
      } else {
        const ev = events.find(e=>e.id===m.id);
        if(ev){ undoData.push({recurring:false, id:ev.id, oldDate:ev.date, oldStart:ev.start}); ev.date = m.newDate; ev.start = m.newStart; }
      }
    });
    saveEvents(events);
    document.getElementById('proposalWrap').innerHTML = '';
    pendingProposal = null;
    showUndoToast(`Week plan applied — ${p.moves.length} event${p.moves.length>1?'s':''} moved`, ()=>{
      undoData.forEach(u=>{
        if(u.recurring){ clearRecurOverride(u.occId); removeEventById(u.newId); }
        else { const ev = events.find(e=>e.id===u.id); if(ev){ ev.date = u.oldDate; ev.start = u.oldStart; } }
      });
      saveEvents(events);
      renderAll();
    });
    renderAll();
    return;
  }

  let undoFn;
  if(p.type==='add'){
    const addedEvent = p.event;
    events.push(addedEvent);
    undoFn = ()=>{ removeEventById(addedEvent.id); saveEvents(events); renderAll(); };
  } else if(p.type==='move-and-add'){
    const moved = events.find(e=>e.id===p.moveId);
    const originalStart = moved ? moved.start : null;
    if(moved) moved.start = p.newStartForMoved;
    const addedEvent = p.event;
    events.push(addedEvent);
    undoFn = ()=>{
      const m = events.find(e=>e.id===p.moveId);
      if(m && originalStart) m.start = originalStart;
      removeEventById(addedEvent.id);
      saveEvents(events);
      renderAll();
    };
  }
  saveEvents(events);
  document.getElementById('proposalWrap').innerHTML = '';
  pendingProposal = null;
  showUndoToast('Schedule updated', undoFn);
  renderAll();
}

/* =========================================================
   COMMAND BAR WIRING
   ========================================================= */
document.getElementById('commandSend').onclick = ()=>{
  const input = document.getElementById('commandInput');
  handleCommand(input.value);
  input.value = '';
};
document.getElementById('commandInput').addEventListener('keydown', e=>{
  if(e.key==='Enter'){
    handleCommand(e.target.value);
    e.target.value = '';
  }
});

document.getElementById('planDayBtn').onclick = planMyDay;

/* Assistant history modal */
const historyModalBackdrop = document.getElementById('historyModalBackdrop');
document.getElementById('historyOpenBtn').onclick = ()=>{
  renderAssistantHistory();
  openModal(historyModalBackdrop);
};
document.getElementById('closeHistoryModal').onclick = ()=> closeModal(historyModalBackdrop);

document.getElementById('planWeekBtn').onclick = planMyWeek;
