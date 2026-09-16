// =========================================================
// app.js — composition root. Imports every feature module (so
// their top-level DOM wiring runs), owns the top-level nav-tab
// switching between views, and runs the one-time startup
// sequence (initial render + the app's periodic refreshes).
//
// Import order matters only in that every module needs to be
// evaluated before this file's own bootstrap calls run at the
// bottom — which is exactly what happens: ES modules fully
// evaluate the whole import graph before continuing past the
// last import statement, regardless of the order listed below.
// =========================================================
import { fmtDate } from './utils.js';
import './state.js';
import './recurrence.js';
import './scheduler.js';
import { renderAll, renderMonth, renderYear, renderGreeting } from './calendar.js';
import { eventsForDate } from './recurrence.js';
import { renderNowNext } from './calendar.js';
import { checkReminders } from './notifications.js';
import './export.js';
import './import.js';
import { renderPrefsForm, tickClock } from './ui.js';
import './assistant.js';

/* =========================================================
   NAV / TABS
   ========================================================= */
document.querySelectorAll('nav.tabs button').forEach(btn=>{
  btn.onclick = ()=>{
    document.querySelectorAll('nav.tabs button').forEach(b=>{ b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected','true');
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('view-'+btn.dataset.view).classList.add('active');
    if(btn.dataset.view==='prefs') renderPrefsForm();
    if(btn.dataset.view==='month') renderMonth();
    if(btn.dataset.view==='year') renderYear();
  };
});

/* =========================================================
   STARTUP SEQUENCE
   Mirrors the original inline script's end-of-file init: an
   immediate first render/check of everything, then periodic
   refreshes for the pieces that go stale over time (the
   greeting's morning/afternoon/evening wording, the clock,
   the Now/Next hero, and reminder firing).
   ========================================================= */
renderGreeting();
tickClock();
renderAll();
checkReminders();

setInterval(renderGreeting, 60000);
setInterval(tickClock, 15000);
setInterval(checkReminders, 30000);
setInterval(()=>{
  if(document.getElementById('view-today').classList.contains('active')){
    renderNowNext(eventsForDate(fmtDate(new Date())));
  }
}, 30000);
