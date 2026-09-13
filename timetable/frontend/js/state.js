// =========================================================
// state.js — application state and persistence.
// Owns the core data arrays (events, prefs, specialDays) and
// their localStorage read/write. Other modules import the
// live array/object bindings directly for reads and in-place
// mutation (push/splice), and use the exported setter
// functions below for the handful of places that need to
// replace the whole array/object (ES module bindings can be
// read live across modules but can't be reassigned from
// outside the module that declared them).
// =========================================================
import { safeJSONParse, safeGetItem, safeSetItem, uid, fmtDate, addDays } from './utils.js';

const STORE_KEY = 'timetable_events_v2';
const PREFS_KEY = 'timetable_prefs_v1';
const SPECIAL_KEY = 'timetable_special_days_v1';
export { STORE_KEY, PREFS_KEY, SPECIAL_KEY };

/* Date index over the events array — turns the common case
   (non-recurring events on a given date) from an O(N) scan
   into an O(1) lookup. Recurring anchors are typically a small
   subset, so they're kept in a short separate list and checked
   individually. Invalidated whenever saveEvents() runs.
   Declared here (before loadEvents/saveEvents are ever called)
   because saveEvents() calls invalidateEventsIndex() — on a
   brand-new install saveEvents() runs immediately (to persist
   the seeded demo events), so these must already be initialized
   at that point, not merely later in the file. This index is
   consumed by recurrence.js's eventsForDate(), which owns the
   read/write access to it via the exported functions below. */
export let eventsByDateIndex = null;
export let recurringAnchorsCache = null;
export function invalidateEventsIndex(){ eventsByDateIndex = null; recurringAnchorsCache = null; }
export function setEventsByDateIndex(v){ eventsByDateIndex = v; }
export function setRecurringAnchorsCache(v){ recurringAnchorsCache = v; }

function seedDemoEvents(){
  const today = fmtDate(new Date());
  const tomorrow = fmtDate(addDays(new Date(),1));
  return [
    {id: uid(), title:'Team standup', date: today, start:'09:30', duration:15, category:'Work', flex:'fixed', done:true},
    {id: uid(), title:'Deep work block', date: today, start:'10:00', duration:120, category:'Work', flex:'fixed', done:false},
    {id: uid(), title:'Study — algorithms', date: today, start:'16:00', duration:60, category:'Study', flex:'flexible', done:false, subtasks:[
      {id:uid(), label:'Sorting algorithms', detail:'16:00–16:20'},
      {id:uid(), label:'Graph theory', detail:'16:20–16:45'},
      {id:uid(), label:'Review flashcards', detail:'16:45–17:00'},
    ]},
    {id: uid(), title:'Grocery run', date: tomorrow, start:'18:00', duration:40, category:'Shopping', flex:'flexible', done:false},
  ];
}

function loadEvents(){
  const raw = safeGetItem(STORE_KEY);
  const parsed = raw ? safeJSONParse(raw, null) : null;
  if(Array.isArray(parsed)) return parsed;
  const seeded = seedDemoEvents();
  saveEvents(seeded);
  return seeded;
}
export function saveEvents(list){ safeSetItem(STORE_KEY, JSON.stringify(list)); invalidateEventsIndex(); }

function defaultPrefs(){
  return {
    sleepStart:'23:00', sleepEnd:'07:00',
    workStart:'09:00', workEnd:'18:00',
    exStart:'07:00', exEnd:'09:00',
    clockFormat:'12',
    weekStart:'sunday',
    flexible:{ Study:true, Exercise:true, Shopping:true, 'Free time':true, Work:false, Other:true }
  };
}
export function loadPrefs(){
  const def = defaultPrefs();
  const raw = safeGetItem(PREFS_KEY);
  const stored = raw ? safeJSONParse(raw, null) : null;
  if(!stored || typeof stored !== 'object'){
    savePrefs(def);
    return def;
  }
  // Merge onto defaults so older/partial saved prefs (missing a field added
  // in a later version of the app) never leave a field silently undefined.
  const merged = {...def, ...stored, flexible:{...def.flexible, ...(stored.flexible||{})}};
  return merged;
}
export function savePrefs(p){ safeSetItem(PREFS_KEY, JSON.stringify(p)); }

export let events = loadEvents();
export let prefs = loadPrefs();

// ---- setters for the handful of call sites (across other modules)
// that need to replace the whole `events` array/object rather than
// mutate it in place. Behavior matches the original inline reassignments
// exactly; callers still call saveEvents()/savePrefs() themselves right
// after, just as the original code did.
export function setEvents(list){ events = list; }
export function addEvents(list){ events = events.concat(list); }
export function removeEventById(id){ events = events.filter(e=>e.id!==id); }
export function removeEventsByIds(ids){ events = events.filter(e=>!ids.includes(e.id)); }
export function setPrefs(p){ prefs = p; }

function loadSpecialDays(){
  const val = safeJSONParse(safeGetItem(SPECIAL_KEY), []);
  return Array.isArray(val) ? val : [];
}
export function saveSpecialDays(list){ safeSetItem(SPECIAL_KEY, JSON.stringify(list)); }
export let specialDays = loadSpecialDays();
export function setSpecialDays(list){ specialDays = list; }
export function removeSpecialDayById(id){ specialDays = specialDays.filter(s=>s.id!==id); }

export function specialDayFor(dateStr){
  const [y,m,d] = dateStr.split('-');
  return specialDays.find(s=>{
    if(s.recurring){
      const [,sm,sd] = s.date.split('-');
      return sm===m && sd===d;
    }
    return s.date === dateStr;
  }) || null;
}
