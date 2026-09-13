// =========================================================
// utils.js — shared helper functions.
// Pure formatting/date/storage helpers with no dependency on
// any particular feature module. `prefs` is imported from
// state.js purely as a read (used inside function bodies only,
// never at this module's top level), and the toast-on-storage-
// failure hook is provided via registerToastHandler() instead
// of importing ui.js directly, so there's no real import cycle
// to reason about at load time.
// =========================================================
import { prefs } from './state.js';

/* =========================================================
   SAFE STORAGE — localStorage can throw (Safari private mode,
   quota exceeded, disabled storage) and can contain corrupted
   / hand-edited JSON. Every read and write in the app routes
   through these two helpers so a bad value or a blocked write
   degrades gracefully (falls back / warns) instead of throwing
   and breaking the whole page.
   ========================================================= */
export function safeJSONParse(raw, fallback){
  if(raw === null || raw === undefined) return fallback;
  try{ return JSON.parse(raw); }
  catch(err){ console.warn('Timetable: corrupted data ignored for a storage key', err); return fallback; }
}
export function safeGetItem(key){
  try{ return localStorage.getItem(key); }
  catch(err){ console.warn('Timetable: localStorage unavailable', err); return null; }
}
let storageWriteWarningShown = false;
let toastHandler = null;
// ui.js calls this once (after showToast is defined) so low-level storage
// code can surface a warning without importing ui.js directly.
export function registerToastHandler(fn){ toastHandler = fn; }
export function safeSetItem(key, value){
  try{ localStorage.setItem(key, value); return true; }
  catch(err){
    console.warn('Timetable: could not persist to localStorage', err);
    if(!storageWriteWarningShown && typeof toastHandler === 'function'){
      storageWriteWarningShown = true;
      toastHandler('⚠ Could not save — storage may be full or unavailable. Changes may be lost on reload.');
    }
    return false;
  }
}

/* =========================================================
   CATEGORIES
   ========================================================= */
export const CATEGORY_META = {
  'Work':       { icon:'💼', bg:'--cat-work-bg',      ink:'--cat-work-ink',      solid:'--cat-work-solid' },
  'Study':      { icon:'📚', bg:'--cat-study-bg',     ink:'--cat-study-ink',     solid:'--cat-study-solid' },
  'Exercise':   { icon:'🏃', bg:'--cat-exercise-bg',  ink:'--cat-exercise-ink',  solid:'--cat-exercise-solid' },
  'Shopping':   { icon:'🛍️', bg:'--cat-shopping-bg',  ink:'--cat-shopping-ink',  solid:'--cat-shopping-solid' },
  'Free time':  { icon:'✨', bg:'--cat-free-bg',      ink:'--cat-free-ink',      solid:'--cat-free-solid' },
  'Other':      { icon:'•',  bg:'--cat-other-bg',     ink:'--cat-other-ink',     solid:'--cat-other-solid' },
};
export function catMeta(cat){ return CATEGORY_META[cat] || CATEGORY_META['Other']; }

/* =========================================================
   DATE / TIME HELPERS
   ========================================================= */
export function uid(){ return Math.random().toString(36).slice(2,10); }
export function pad(n){ return n.toString().padStart(2,'0'); }
export function fmtDate(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
export function addDays(d,n){ const c=new Date(d); c.setDate(c.getDate()+n); return c; }
export function toMinutes(hhmm){ const [h,m]=hhmm.split(':').map(Number); return h*60+m; }
export function toHHMM(mins){ mins=((mins%1440)+1440)%1440; return `${pad(Math.floor(mins/60))}:${pad(mins%60)}`; }
export function fmt12(hhmm){
  const [h,m]=hhmm.split(':').map(Number);
  if(prefs && prefs.clockFormat === '24'){
    return `${pad(h)}:${pad(m)}`;
  }
  const period = h>=12?'PM':'AM';
  let h12 = h%12; if(h12===0) h12=12;
  return `${h12}:${pad(m)} ${period}`;
}
export function formatDuration(mins){
  const h = Math.floor(mins/60), m = mins%60;
  if(h===0) return `${m}m`;
  if(m===0) return `${h}h`;
  return `${h}h ${m}m`;
}
export const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

export function weekStartOffset(){
  return (prefs && prefs.weekStart === 'monday') ? 1 : 0;
}
export function startOfWeekFor(date){
  const offset = weekStartOffset();
  let diff = date.getDay() - offset;
  if(diff < 0) diff += 7;
  return addDays(date, -diff);
}
export function weekdayDisplayOrder(){
  const offset = weekStartOffset();
  return [0,1,2,3,4,5,6].map(i => (offset+i) % 7);
}

export function nextDateForWeekday(targetDow){
  const today = new Date();
  const todayDow = today.getDay();
  let diff = targetDow - todayDow;
  if(diff < 0) diff += 7;
  return fmtDate(addDays(today, diff));
}

export function niceDate(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  return d.toLocaleDateString(undefined,{weekday:'long', month:'short', day:'numeric'});
}
export function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
