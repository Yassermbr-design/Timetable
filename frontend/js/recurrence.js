// =========================================================
// recurrence.js — recurring events and per-occurrence overrides.
// A recurring event is stored once (the "anchor", at its first
// date) with a `recurrence` rule. Occurrences on other matching
// dates are computed on the fly in eventsForDate() — never
// written to storage — so nothing is duplicated on reload.
// Per-occurrence state (done / deleted-just-this-one) lives in
// a small overrides map keyed by "anchorId::date". This module
// also owns eventsForDate(), the single function every other
// module uses to ask "what's on this date" (plain events +
// resolved recurring occurrences, overrides applied).
// =========================================================
import { safeJSONParse, safeGetItem, safeSetItem, toMinutes } from './utils.js';
import {
  events, saveEvents,
  eventsByDateIndex, recurringAnchorsCache, setEventsByDateIndex, setRecurringAnchorsCache,
  removeEventById
} from './state.js';
import { renderAll } from './calendar.js';
import { showUndoToast } from './ui.js';

const RECUR_OVERRIDES_KEY = 'timetable_recur_overrides_v1';
export { RECUR_OVERRIDES_KEY };
function loadRecurOverrides(){
  return safeJSONParse(safeGetItem(RECUR_OVERRIDES_KEY), {}) || {};
}
function saveRecurOverrides(o){ safeSetItem(RECUR_OVERRIDES_KEY, JSON.stringify(o)); }
export let recurOverrides = loadRecurOverrides();
// Used only by import.js when restoring a full JSON backup.
export function setRecurOverridesAll(o){ recurOverrides = o; saveRecurOverrides(recurOverrides); }

export function setRecurOverride(occurrenceId, patch){
  recurOverrides[occurrenceId] = {...(recurOverrides[occurrenceId]||{}), ...patch};
  saveRecurOverrides(recurOverrides);
}
export function clearRecurOverride(occurrenceId){
  delete recurOverrides[occurrenceId];
  saveRecurOverrides(recurOverrides);
}

export function recurrenceMatchesDate(event, dateStr){
  if(!event.recurrence || event.recurrence.type==='none') return false;
  if(dateStr < event.date) return false;
  const d = new Date(dateStr+'T00:00:00');
  const anchor = new Date(event.date+'T00:00:00');
  const dow = d.getDay();
  switch(event.recurrence.type){
    case 'daily': return true;
    case 'weekdays': return dow>=1 && dow<=5;
    case 'weekly': {
      const days = (event.recurrence.days && event.recurrence.days.length) ? event.recurrence.days : [anchor.getDay()];
      return days.includes(dow);
    }
    case 'monthly': return d.getDate() === anchor.getDate();
    default: return false;
  }
}

/* Resolve an occurrence id (composite "anchorId::date" for
   recurring occurrences, or a plain id for normal events)
   back into a full event-shaped object. */
export function resolveOccurrence(id){
  if(id.includes('::')){
    const anchorId = id.slice(0, id.indexOf('::'));
    const dateStr = id.slice(id.indexOf('::')+2);
    const anchor = events.find(e=>e.id===anchorId);
    if(!anchor) return null;
    const ov = recurOverrides[id] || {};
    return {...anchor, id, _anchorId:anchorId, date:dateStr, done:!!ov.done, isRecurring:true};
  }
  return events.find(e=>e.id===id) || null;
}

export function toggleEventDone(id){
  if(id.includes('::')){
    const cur = recurOverrides[id] && recurOverrides[id].done;
    setRecurOverride(id, {done: !cur});
  } else {
    const item = events.find(e=>e.id===id);
    if(item){ item.done = !item.done; saveEvents(events); }
  }
  renderAll();
}

/* Deletes a single occurrence. For a recurring event this
   only skips that one date (with Undo restoring it) — the
   series and every other date are untouched. */
export function deleteEventOccurrence(id){
  if(id.includes('::')){
    setRecurOverride(id, {skipped:true});
    renderAll();
    showUndoToast('Occurrence removed', ()=>{ clearRecurOverride(id); renderAll(); });
  } else {
    const removed = events.find(e=>e.id===id);
    if(!removed) return;
    removeEventById(id);
    saveEvents(events);
    renderAll();
    showUndoToast('Event deleted', ()=>{ events.push(removed); saveEvents(events); renderAll(); });
  }
}

/* =========================================================
   SCHEDULING ENGINE — deterministic, not the AI.
   ========================================================= */
function ensureEventsIndex(){
  if(eventsByDateIndex) return;
  const index = new Map();
  const anchors = [];
  events.forEach(e=>{
    if(e.recurrence && e.recurrence.type !== 'none'){
      anchors.push(e);
    } else {
      if(!index.has(e.date)) index.set(e.date, []);
      index.get(e.date).push(e);
    }
  });
  setEventsByDateIndex(index);
  setRecurringAnchorsCache(anchors);
}

export function eventsForDate(date){
  ensureEventsIndex();
  const result = (eventsByDateIndex.get(date) || []).slice();
  recurringAnchorsCache.forEach(e=>{
    const isAnchorDate = e.date === date;
    if(!isAnchorDate && !recurrenceMatchesDate(e, date)) return;
    const key = e.id + '::' + date;
    const ov = recurOverrides[key] || {};
    if(ov.skipped) return;
    result.push({ ...e, id:key, _anchorId:e.id, date, done:!!ov.done, isRecurring:true });
  });
  return result.sort((a,b)=>toMinutes(a.start)-toMinutes(b.start));
}
