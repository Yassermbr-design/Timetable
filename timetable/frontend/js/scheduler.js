// =========================================================
// scheduler.js — deterministic scheduling engine.
// Conflict detection, free-slot finding, slot scoring, and
// schedule-health analysis. Nothing in this file is AI/LLM —
// it's plain, predictable date-math and heuristic scoring, and
// nothing here changed from the original engine.
// =========================================================
import { toMinutes, toHHMM, fmtDate, addDays, fmt12, formatDuration } from './utils.js';
import { prefs } from './state.js';
import { eventsForDate } from './recurrence.js';

/* Events whose duration pushes them past midnight (e.g. 23:00 for 120min)
   spill into the next calendar day. eventsForDate() only indexes an event
   under its own start date, so a same-day-only conflict check would miss
   an early-morning event that a spillover actually overlaps. This returns
   that spillover, reframed as if it started at 00:00 on `date`. */
export function spilloverFromPreviousDay(date){
  const prevDate = fmtDate(addDays(new Date(date+'T00:00:00'), -1));
  return eventsForDate(prevDate)
    .filter(e => toMinutes(e.start) + e.duration > 1440)
    .map(e => ({ ...e, start: '00:00', duration: (toMinutes(e.start) + e.duration) - 1440 }));
}

export function findConflicts(date, start, duration, excludeId){
  const startMin = toMinutes(start), endMin = startMin + duration;
  const candidates = eventsForDate(date).concat(spilloverFromPreviousDay(date));
  return candidates.filter(e=>{
    if(excludeId && (e.id===excludeId || e._anchorId===excludeId)) return false;
    const s = toMinutes(e.start), en = s + e.duration;
    return startMin < en && endMin > s;
  });
}

export function findAlternativeSlots(date, duration, excludeId, maxResults){
  const dayEvents = eventsForDate(date)
    .filter(e=> !excludeId || (e.id!==excludeId && e._anchorId!==excludeId))
    .map(e=>({start:toMinutes(e.start), end:toMinutes(e.start)+e.duration}))
    .sort((a,b)=>a.start-b.start);
  const dayStart = toMinutes(prefs.sleepEnd);
  const dayEnd = toMinutes(prefs.sleepStart) > dayStart ? toMinutes(prefs.sleepStart) : 1440;
  const slots = [];
  let cursor = dayStart;
  for(const ev of dayEvents){
    if(ev.start - cursor >= duration) slots.push(cursor);
    cursor = Math.max(cursor, ev.end);
  }
  if(dayEnd - cursor >= duration) slots.push(cursor);
  return slots.slice(0, maxResults).map(s=>({start:toHHMM(s), end:toHHMM(s+duration)}));
}

/* =========================================================
   SLOT SCORING — instead of taking the first slot that fits,
   candidate slots are scored on preference alignment (work
   hours for Work, preferred window for Exercise) and on
   spacing (a slot that leaves an awkward 5–25 minute sliver
   next to another event scores worse than one that either
   uses the whole gap or leaves a genuinely useful buffer).
   The highest-scoring candidate wins.
   ========================================================= */
export function scoreSlot(date, startMin, duration, category){
  let score = 100;
  const endMin = startMin + duration;

  if(category === 'Exercise'){
    const prefStart = toMinutes(prefs.exStart), prefEnd = toMinutes(prefs.exEnd);
    const center = (prefStart + prefEnd) / 2;
    const dist = Math.abs(((startMin+endMin)/2) - center);
    score -= dist / 12;
  } else if(category === 'Work'){
    const workStart = toMinutes(prefs.workStart), workEnd = toMinutes(prefs.workEnd);
    score += (startMin >= workStart && endMin <= workEnd) ? 20 : -15;
  }

  const dayEvents = eventsForDate(date)
    .map(e=>({start:toMinutes(e.start), end:toMinutes(e.start)+e.duration}))
    .sort((a,b)=>a.start-b.start);
  let prevEnd = toMinutes(prefs.sleepEnd);
  let nextStart = toMinutes(prefs.sleepStart) > prevEnd ? toMinutes(prefs.sleepStart) : 1440;
  dayEvents.forEach(ev=>{
    if(ev.end <= startMin && ev.end > prevEnd) prevEnd = ev.end;
    if(ev.start >= endMin && ev.start < nextStart) nextStart = ev.start;
  });
  [startMin - prevEnd, nextStart - endMin].forEach(buf=>{
    if(buf <= 0) score += 5;              // flush against a boundary uses the gap cleanly
    else if(buf < 30) score -= (30 - buf) / 2; // small awkward leftover sliver
    else score += 3;                      // healthy breathing room
  });

  return score;
}

export function candidatesFromGaps(gapsList, duration){
  const candidates = [];
  gapsList.forEach(g=>{
    const gapLen = g.end - g.start;
    if(gapLen < duration) return;
    candidates.push(g.start);
    if(gapLen > duration) candidates.push(g.end - duration);
    const mid = Math.round((g.start + (gapLen-duration)/2) / 15) * 15;
    if(mid > g.start && mid < g.end - duration) candidates.push(mid);
  });
  return [...new Set(candidates)];
}

export function pickBestCandidate(date, candidates, duration, category){
  if(candidates.length === 0) return null;
  let best = candidates[0], bestScore = -Infinity;
  candidates.forEach(c=>{
    const s = scoreSlot(date, c, duration, category);
    if(s > bestScore){ bestScore = s; best = c; }
  });
  return best;
}

export function findFreeSlot(date, durationNeeded, windowStart, windowEnd, category){
  const dayEvents = eventsForDate(date).map(e=>({
    start: toMinutes(e.start), end: toMinutes(e.start)+e.duration
  })).sort((a,b)=>a.start-b.start);

  const gaps = [];
  let cursor = windowStart;
  dayEvents.forEach(ev=>{
    if(ev.start > cursor) gaps.push({start:cursor, end:Math.min(ev.start, windowEnd)});
    cursor = Math.max(cursor, ev.end);
  });
  if(windowEnd > cursor) gaps.push({start:cursor, end:windowEnd});

  const candidates = candidatesFromGaps(gaps, durationNeeded);
  return pickBestCandidate(date, candidates, durationNeeded, category);
}

export function findMovableEventInWindow(date, windowStart, windowEnd){
  return eventsForDate(date).find(e=>{
    const s = toMinutes(e.start), en = s+e.duration;
    const overlaps = s < windowEnd && en > windowStart;
    return overlaps && e.flex === 'flexible' && prefs.flexible[e.category] !== false;
  }) || null;
}

export function findFreeSlotAnywhereInDay(date, durationNeeded, excludeId, category){
  const dayEvents = eventsForDate(date).filter(e=>e.id!==excludeId).map(e=>({
    start: toMinutes(e.start), end: toMinutes(e.start)+e.duration
  })).sort((a,b)=>a.start-b.start);

  const dayStart = toMinutes(prefs.sleepEnd);
  const dayEnd = toMinutes(prefs.sleepStart) > dayStart ? toMinutes(prefs.sleepStart) : 1440;

  const gaps = [];
  let cursor = dayStart;
  dayEvents.forEach(ev=>{
    if(ev.start > cursor) gaps.push({start:cursor, end:ev.start});
    cursor = Math.max(cursor, ev.end);
  });
  if(dayEnd > cursor) gaps.push({start:cursor, end:dayEnd});

  const candidates = candidatesFromGaps(gaps, durationNeeded);
  return pickBestCandidate(date, candidates, durationNeeded, category);
}

export function findFreeGaps(date){
  const dayEvents = eventsForDate(date)
    .map(e=>({start:toMinutes(e.start), end:toMinutes(e.start)+e.duration}))
    .sort((a,b)=>a.start-b.start);
  const dayStart = toMinutes(prefs.sleepEnd);
  const dayEnd = toMinutes(prefs.sleepStart) > dayStart ? toMinutes(prefs.sleepStart) : 1440;
  const gaps = [];
  let cursor = dayStart;
  dayEvents.forEach(ev=>{
    if(ev.start > cursor) gaps.push({start:cursor, end:ev.start});
    cursor = Math.max(cursor, ev.end);
  });
  if(dayEnd > cursor) gaps.push({start:cursor, end:dayEnd});
  return gaps.filter(g=>g.end-g.start >= 15).map(g=>({start:toHHMM(g.start), end:toHHMM(g.end)}));
}

export function overlapsSleepWindow(startMin, endMin){
  const sleepS = toMinutes(prefs.sleepStart), sleepE = toMinutes(prefs.sleepEnd);
  const inSleep = (m)=> (sleepS > sleepE) ? (m >= sleepS || m < sleepE) : (m >= sleepS && m < sleepE);
  for(let m = startMin; m < endMin; m += 15){
    if(inSleep(((m % 1440) + 1440) % 1440)) return true;
  }
  return false;
}

export function analyzeScheduleHealth(date){
  const list = eventsForDate(date).filter(e=>!e.done);
  const sorted = list.slice().sort((a,b)=>toMinutes(a.start)-toMinutes(b.start));
  const totalMin = list.reduce((s,e)=>s+e.duration,0);
  const workMin = list.filter(e=>e.category==='Work').reduce((s,e)=>s+e.duration,0);
  const freeMin = findFreeGaps(date).reduce((s,g)=>s+(toMinutes(g.end)-toMinutes(g.start)),0);
  const issues = [];

  if(totalMin >= 540 && freeMin < 60){
    issues.push(`Overloaded — ${formatDuration(totalMin)} scheduled with only ${formatDuration(freeMin)} free.`);
  } else if(list.length > 0 && freeMin < 60){
    issues.push(`Very little breathing room — just ${formatDuration(freeMin)} free.`);
  }

  let streak = 1, flaggedStreak = false;
  for(let i=1;i<sorted.length && !flaggedStreak;i++){
    const prevEnd = toMinutes(sorted[i-1].start) + sorted[i-1].duration;
    const gap = toMinutes(sorted[i].start) - prevEnd;
    streak = (gap >= 0 && gap < 10) ? streak+1 : 1;
    if(streak === 3){
      issues.push(`3 back-to-back events with barely a break, around ${fmt12(sorted[i].start)}.`);
      flaggedStreak = true;
    }
  }

  if(workMin >= 480){
    issues.push(`Heavy work day — ${formatDuration(workMin)} of Work scheduled.`);
  }

  sorted.forEach(e=>{
    if(overlapsSleepWindow(toMinutes(e.start), toMinutes(e.start)+e.duration)){
      issues.push(`"${e.title}" overlaps your sleep window.`);
    }
  });

  for(let i=0;i<sorted.length;i++){
    for(let j=i+1;j<sorted.length;j++){
      if(toMinutes(sorted[j].start) < toMinutes(sorted[i].start)+sorted[i].duration){
        issues.push(`"${sorted[i].title}" and "${sorted[j].title}" overlap.`);
      }
    }
  }

  return { issues, totalMin, freeMin, sorted };
}

/* =========================================================
   SMART RESCHEDULING FOR MISSED EVENTS
   A "missed" event is one whose time has passed (today,
   already ended) or an earlier day, and that isn't marked
   done. Looks back up to 7 days — a bounded, cheap window.
   ========================================================= */
export function findMissedEvents(){
  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();
  const todayStr = fmtDate(now);
  const missed = [];
  eventsForDate(todayStr).forEach(e=>{
    if(!e.done && toMinutes(e.start)+e.duration <= nowMin) missed.push(e);
  });
  for(let i=1;i<=7;i++){
    eventsForDate(fmtDate(addDays(now,-i))).forEach(e=>{ if(!e.done) missed.push(e); });
  }
  return missed;
}

export function distributeDeadlineTask(title, deadlineDate, totalMinutes, subParts, category){
  const todayStr = fmtDate(new Date());
  if(deadlineDate < todayStr) return { sessions: [], daysAvailable: [] };

  const daysAvailable = [];
  let cursor = new Date(todayStr+'T00:00:00');
  const deadline = new Date(deadlineDate+'T00:00:00');
  while(cursor <= deadline){ daysAvailable.push(fmtDate(cursor)); cursor = addDays(cursor,1); }
  if(daysAvailable.length === 0) return { sessions: [], daysAvailable: [] };

  let sessionCount = (subParts && subParts.length)
    ? subParts.length
    : Math.max(1, Math.min(daysAvailable.length, Math.round(totalMinutes / 90)));
  sessionCount = Math.min(sessionCount, daysAvailable.length);

  const base = Math.max(15, Math.floor((totalMinutes / sessionCount) / 15) * 15);
  const durations = new Array(sessionCount).fill(base);
  durations[durations.length-1] += (totalMinutes - durations.reduce((a,b)=>a+b,0));

  const usedDays = new Set();
  const finalDays = [];
  for(let i=0;i<sessionCount;i++){
    let idx = sessionCount===1 ? daysAvailable.length-1 : Math.round(i*(daysAvailable.length-1)/(sessionCount-1));
    while(usedDays.has(daysAvailable[idx]) && idx < daysAvailable.length-1) idx++;
    usedDays.add(daysAvailable[idx]);
    finalDays.push(daysAvailable[idx]);
  }

  const dayStart = toMinutes(prefs.sleepEnd);
  const dayEnd = toMinutes(prefs.sleepStart) > dayStart ? toMinutes(prefs.sleepStart) : 1440;

  const sessions = [];
  for(let i=0;i<sessionCount;i++){
    const date = finalDays[i];
    const duration = durations[i];
    const slotStart = findFreeSlot(date, duration, dayStart, dayEnd, category);
    const label = (subParts && subParts[i]) ? subParts[i] : `${title} (part ${i+1} of ${sessionCount})`;
    sessions.push({ date, duration, start: slotStart, label });
  }
  return { sessions, daysAvailable };
}
