// =========================================================
// ui.js — modals, dialogs, toasts, menus, theme, prefs form,
// onboarding wizard, and every other DOM-interaction surface
// that isn't a calendar view, the assistant, or import/export.
// =========================================================
import {
  safeGetItem, safeSetItem, registerToastHandler,
  catMeta, escapeHtml, fmtDate, addDays, toMinutes, toHHMM, pad, uid, fmt12, formatDuration,
  niceDate, nextDateForWeekday, startOfWeekFor
} from './utils.js';
import {
  events, prefs, specialDays, saveEvents, savePrefs, setPrefs, saveSpecialDays,
  removeSpecialDayById, setEvents, addEvents, specialDayFor,
  STORE_KEY, PREFS_KEY, SPECIAL_KEY
} from './state.js';
import { eventsForDate, resolveOccurrence, deleteEventOccurrence, RECUR_OVERRIDES_KEY } from './recurrence.js';
import { findConflicts, findAlternativeSlots } from './scheduler.js';
import { renderAll, renderMonth, renderYear, getWeekCursor } from './calendar.js';
import { updateNotifStatus, REMINDER_FIRED_KEY } from './notifications.js';
import { logAssistantTurn, openDeadlineTaskProposal } from './assistant.js';

// Low-level storage code (utils.js) can't import this module directly
// without creating a real load-order hazard, so it calls back into
// showToast (defined near the bottom of this file) via this hook instead.
registerToastHandler((msg)=> showToast(msg));

/* =========================================================
   THEME
   ========================================================= */
const THEME_KEY = 'timetable_theme_v1';
let currentThemeSetting = 'dark';
function resolveTheme(t){
  if(t === 'system'){
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  return t;
}
export function applyTheme(t){
  currentThemeSetting = t;
  const resolved = resolveTheme(t);
  document.documentElement.setAttribute('data-theme', resolved);
  const iconMap = { dark:'☾', light:'☀', system:'🖥' };
  document.getElementById('themeToggle').textContent = iconMap[t] || '☾';
  safeSetItem(THEME_KEY, t);
  const sel = document.getElementById('themeSelect');
  if(sel) sel.value = t;
}
(function initTheme(){
  applyTheme(safeGetItem(THEME_KEY) || 'dark');
})();
document.getElementById('themeToggle').onclick = ()=>{
  const order = ['dark','light','system'];
  const next = order[(order.indexOf(currentThemeSetting)+1) % order.length];
  applyTheme(next);
};
if(window.matchMedia){
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{
    if(currentThemeSetting === 'system') applyTheme('system');
  });
}

/* =========================================================
   MODAL UTILITIES — Escape to close, click-outside to close,
   focus restoration, and a real Tab focus trap. Works for
   every .modal-backdrop regardless of how it was opened, as
   long as open/close route through openModal()/closeModal().
   ========================================================= */
function getFocusableIn(container){
  return [...container.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(el => el.offsetParent !== null || el === document.activeElement);
}

export function openModal(el){
  el.classList.add('show');
  el.__lastFocus = document.activeElement;
  const modalInner = el.querySelector('.modal') || el;
  setTimeout(()=>{
    const focusables = getFocusableIn(modalInner);
    (focusables[0] || modalInner).focus({preventScroll:true});
  }, 30);
}
export function closeModal(el){
  el.classList.remove('show');
  if(el.__lastFocus && typeof el.__lastFocus.focus === 'function') el.__lastFocus.focus();
}
document.addEventListener('keydown', e=>{
  const openBackdrops = [...document.querySelectorAll('.modal-backdrop.show')];
  if(openBackdrops.length === 0) return;
  const topModalBackdrop = openBackdrops[openBackdrops.length-1];

  if(e.key === 'Escape'){
    closeModal(topModalBackdrop);
    return;
  }
  if(e.key === 'Tab'){
    const modalInner = topModalBackdrop.querySelector('.modal') || topModalBackdrop;
    const focusables = getFocusableIn(modalInner);
    if(focusables.length === 0){ e.preventDefault(); return; }
    const first = focusables[0], last = focusables[focusables.length-1];
    const insideModal = modalInner.contains(document.activeElement);
    if(e.shiftKey){
      if(!insideModal || document.activeElement === first){
        e.preventDefault();
        last.focus();
      }
    } else {
      if(!insideModal || document.activeElement === last){
        e.preventDefault();
        first.focus();
      }
    }
  }
});
document.querySelectorAll('.modal-backdrop').forEach(el=>{
  el.addEventListener('mousedown', e=>{
    if(e.target === el) closeModal(el);
  });
});

/* =========================================================
   DAILY / WEEKLY SUMMARY
   ========================================================= */
const summaryModalBackdrop = document.getElementById('summaryModalBackdrop');

function openDailySummary(){
  const today = fmtDate(new Date());
  const list = eventsForDate(today);
  const totalMin = list.reduce((s,e)=>s+e.duration,0);
  const doneMin = list.filter(e=>e.done).reduce((s,e)=>s+e.duration,0);
  const nowMin = new Date().getHours()*60 + new Date().getMinutes();
  const sorted = list.slice().sort((a,b)=>toMinutes(a.start)-toMinutes(b.start));
  const upcoming = sorted.filter(e=> !e.done && toMinutes(e.start)+e.duration > nowMin);
  const next = upcoming[0] || null;
  const remaining = upcoming.slice(1);

  const h = new Date().getHours();
  const greeting = h<12 ? 'Good morning' : h<18 ? 'Good afternoon' : 'Good evening';
  document.getElementById('summaryModalTitle').textContent = greeting;

  let body = `<div class="summary-block">
    <div class="summary-label">Today</div>
    <div class="summary-stat"><strong>${formatDuration(totalMin)}</strong> planned</div>
    <div class="summary-stat"><strong>${formatDuration(doneMin)}</strong> completed</div>
  </div>`;

  if(list.length === 0){
    body += `<div class="summary-block"><div class="summary-label">Nothing scheduled today</div></div>`;
  } else {
    if(next){
      body += `<div class="summary-block">
        <div class="summary-label">Next</div>
        <div class="summary-item">${catMeta(next.category).icon} ${escapeHtml(next.title)} at ${fmt12(next.start)}</div>
      </div>`;
    }
    if(remaining.length){
      body += `<div class="summary-block">
        <div class="summary-label">Remaining</div>
        ${remaining.map(e=>`<div class="summary-item">${catMeta(e.category).icon} ${escapeHtml(e.title)}</div>`).join('')}
      </div>`;
    }
    if(!next && remaining.length===0){
      body += `<div class="summary-block"><div class="summary-label">🎉 All done for today</div></div>`;
    }
  }

  document.getElementById('summaryModalBody').innerHTML = body;
  openModal(summaryModalBackdrop);
}

function openWeeklySummary(){
  const startOfWeek = startOfWeekFor(getWeekCursor());
  const days = [];
  for(let i=0;i<7;i++) days.push(fmtDate(addDays(startOfWeek,i)));

  let totalMin=0, doneMin=0, doneCount=0;
  const catMin = {};
  const dayTotals = [];
  days.forEach(date=>{
    const list = eventsForDate(date);
    let dayTotal = 0;
    list.forEach(e=>{
      totalMin += e.duration;
      dayTotal += e.duration;
      if(e.done){ doneMin += e.duration; doneCount++; }
      catMin[e.category] = (catMin[e.category]||0) + e.duration;
    });
    dayTotals.push({date, total:dayTotal});
  });
  const busiest = dayTotals.slice().sort((a,b)=>b.total-a.total)[0];
  const completionPct = totalMin>0 ? Math.round((doneMin/totalMin)*100) : 0;
  const maxCatMin = Math.max(1, ...Object.values(catMin), 0);
  const catOrder = ['Work','Study','Exercise','Shopping','Free time','Other'];

  document.getElementById('summaryModalTitle').textContent = 'This week';

  let body = `<div class="summary-block">
    <div class="summary-stat-row">
      <div><strong>${formatDuration(totalMin)}</strong><span>Scheduled</span></div>
      <div><strong>${formatDuration(doneMin)}</strong><span>Completed</span></div>
      <div><strong>${completionPct}%</strong><span>Completion</span></div>
    </div>
  </div>`;

  const activeCats = catOrder.filter(c=>catMin[c]);
  if(activeCats.length){
    body += `<div class="summary-block">
      <div class="summary-label">By category</div>
      ${activeCats.map(c=>{
        const meta = catMeta(c);
        const pct = Math.round((catMin[c]/maxCatMin)*100);
        return `<div class="summary-bar-row">
          <span class="summary-bar-label">${meta.icon} ${c}</span>
          <div class="summary-bar-track"><div class="summary-bar-fill" style="width:${pct}%;background:var(${meta.solid});"></div></div>
          <span class="summary-bar-value">${formatDuration(catMin[c])}</span>
        </div>`;
      }).join('')}
    </div>`;
  }

  body += `<div class="summary-block">
    <div class="summary-stat">✅ ${doneCount} event${doneCount===1?'':'s'} completed</div>
    ${busiest && busiest.total>0 ? `<div class="summary-stat">📅 Busiest day: ${niceDate(busiest.date)} (${formatDuration(busiest.total)})</div>` : ''}
  </div>`;

  document.getElementById('summaryModalBody').innerHTML = body;
  openModal(summaryModalBackdrop);
}

document.getElementById('dailySummaryBtn').onclick = openDailySummary;
document.getElementById('weeklySummaryBtn').onclick = openWeeklySummary;
document.getElementById('closeSummaryModal').onclick = ()=> closeModal(summaryModalBackdrop);

/* =========================================================
   SEARCH & FILTERS — global search across events, categories,
   subtasks, and special days, combinable with filters.
   ========================================================= */
const searchModalBackdrop = document.getElementById('searchModalBackdrop');

function collectSearchableItems(){
  const items = [];
  events.forEach(e=>{
    items.push({
      kind:'event', id:e.id, title:e.title, category:e.category, date:e.date,
      start:e.start, duration:e.duration, done:e.done, flex:e.flex,
      recurring: !!(e.recurrence && e.recurrence.type !== 'none')
    });
    (e.subtasks||[]).forEach(s=>{
      items.push({
        kind:'subtask', id:e.id, title:s.label, detail:s.detail, parentTitle:e.title,
        category:e.category, date:e.date, start:e.start, done:e.done, flex:e.flex
      });
    });
  });
  specialDays.forEach(s=>{
    items.push({ kind:'special', id:s.id, title:s.title, date:s.date, type:s.type, recurring:s.recurring });
  });
  return items;
}

function runSearch(query, filters){
  const q = query.trim().toLowerCase();
  return collectSearchableItems().filter(item=>{
    if(q){
      const haystack = [item.title, item.category, item.detail, item.parentTitle, item.date]
        .filter(Boolean).join(' ').toLowerCase();
      if(!haystack.includes(q)) return false;
    }
    if(filters.category !== 'all'){
      if(!item.category || item.category !== filters.category) return false;
    }
    if(filters.status !== 'all'){
      if(item.done === undefined) return false;
      if(filters.status === 'done' && !item.done) return false;
      if(filters.status === 'undone' && item.done) return false;
    }
    if(filters.flex !== 'all'){
      if(!item.flex || item.flex !== filters.flex) return false;
    }
    if(filters.dateFrom && item.date && item.date < filters.dateFrom) return false;
    if(filters.dateTo && item.date && item.date > filters.dateTo) return false;
    return true;
  }).sort((a,b)=> (a.date||'').localeCompare(b.date||''));
}

function currentSearchFilters(){
  return {
    category: document.getElementById('searchCatFilter').value,
    status: document.getElementById('searchStatusFilter').value,
    flex: document.getElementById('searchFlexFilter').value,
    dateFrom: document.getElementById('searchDateFrom').value.trim(),
    dateTo: document.getElementById('searchDateTo').value.trim(),
  };
}

function renderSearchResults(){
  const query = document.getElementById('searchInput').value;
  const filters = currentSearchFilters();
  const results = runSearch(query, filters);
  const wrap = document.getElementById('searchResults');

  if(results.length === 0){
    wrap.innerHTML = `<div class="subtask-empty">No matches.</div>`;
    return;
  }

  const shown = results.slice(0, 100);
  wrap.innerHTML = shown.map(item=>{
    if(item.kind === 'special'){
      return `<div class="search-result-row">
        <span class="search-result-icon">★</span>
        <span class="search-result-text"><b>${escapeHtml(item.title)}</b><span class="search-result-meta">${escapeHtml(item.type)} · ${niceDate(item.date)}${item.recurring?' · yearly':''}</span></span>
      </div>`;
    }
    const meta = catMeta(item.category);
    const dateLabel = niceDate(item.date) + (item.start ? ' · ' + fmt12(item.start) : '');
    if(item.kind === 'subtask'){
      return `<div class="search-result-row" data-open-search-task="${item.id}">
        <span class="search-result-icon">${meta.icon}</span>
        <span class="search-result-text"><b>${escapeHtml(item.title)}</b><span class="search-result-meta">in "${escapeHtml(item.parentTitle)}" · ${dateLabel}</span></span>
      </div>`;
    }
    return `<div class="search-result-row" data-open-search-task="${item.id}">
      <span class="search-result-icon">${meta.icon}</span>
      <span class="search-result-text"><b>${escapeHtml(item.title)}</b><span class="search-result-meta">${escapeHtml(item.category)} · ${dateLabel}${item.recurring?' · recurring':''}${item.done?' · done':''}</span></span>
    </div>`;
  }).join('') + (results.length > 100 ? `<div class="subtask-empty">+${results.length-100} more — narrow your search</div>` : '');

  wrap.querySelectorAll('[data-open-search-task]').forEach(row=>{
    row.onclick = ()=>{
      closeModal(searchModalBackdrop);
      openTaskModal(row.dataset.openSearchTask);
    };
  });
}

function openSearchModal(){
  document.getElementById('searchInput').value = '';
  document.getElementById('searchCatFilter').value = 'all';
  document.getElementById('searchStatusFilter').value = 'all';
  document.getElementById('searchFlexFilter').value = 'all';
  document.getElementById('searchDateFrom').value = '';
  document.getElementById('searchDateTo').value = '';
  renderSearchResults();
  openModal(searchModalBackdrop);
}
document.getElementById('searchOpenBtn').onclick = openSearchModal;
document.getElementById('closeSearchModal').onclick = ()=> closeModal(searchModalBackdrop);
document.getElementById('searchClearFilters').onclick = ()=>{
  document.getElementById('searchCatFilter').value = 'all';
  document.getElementById('searchStatusFilter').value = 'all';
  document.getElementById('searchFlexFilter').value = 'all';
  document.getElementById('searchDateFrom').value = '';
  document.getElementById('searchDateTo').value = '';
  renderSearchResults();
};
['searchInput','searchCatFilter','searchStatusFilter','searchFlexFilter','searchDateFrom','searchDateTo'].forEach(id=>{
  document.getElementById(id).addEventListener('input', renderSearchResults);
  document.getElementById(id).addEventListener('change', renderSearchResults);
});

/* =========================================================
   PREFERENCES FORM
   ========================================================= */
export function renderPrefsForm(){
  document.getElementById('sleepStart').value = prefs.sleepStart;
  document.getElementById('sleepEnd').value = prefs.sleepEnd;
  document.getElementById('workStart').value = prefs.workStart;
  document.getElementById('workEnd').value = prefs.workEnd;
  document.getElementById('exStart').value = prefs.exStart;
  document.getElementById('exEnd').value = prefs.exEnd;
  document.getElementById('weekStartSelect').value = prefs.weekStart || 'sunday';
  document.getElementById('flexStudy').checked = !!prefs.flexible['Study'];
  document.getElementById('flexExercise').checked = !!prefs.flexible['Exercise'];
  document.getElementById('flexShopping').checked = !!prefs.flexible['Shopping'];
  document.getElementById('flexFree').checked = !!prefs.flexible['Free time'];
  document.getElementById('flexWork').checked = !!prefs.flexible['Work'];
  document.getElementById('themeSelect').value = currentThemeSetting;
  document.getElementById('clockFormatSelect').value = prefs.clockFormat || '12';
  updateNotifStatus();
}
document.getElementById('themeSelect').onchange = (e)=> applyTheme(e.target.value);
document.getElementById('weekStartSelect').onchange = (e)=>{
  prefs.weekStart = e.target.value;
  savePrefs(prefs);
  renderAll(); renderMonth(); renderYear();
};
document.getElementById('clockFormatSelect').onchange = (e)=>{
  prefs.clockFormat = e.target.value;
  savePrefs(prefs);
  renderAll();
};

/* =========================================================
   CLOCK
   ========================================================= */
let lastClockStr = '';
export function tickClock(){
  const now = new Date();
  const use24 = prefs && prefs.clockFormat === '24';
  const h = pad(use24 ? now.getHours() : (now.getHours()%12===0?12:now.getHours()%12));
  const m = pad(now.getMinutes());
  const str = h+m+(use24?'24':'12');
  const clockEl = document.getElementById('clock');
  if(str !== lastClockStr){
    clockEl.innerHTML = `<span class="flip">${h}</span><span class="sep">:</span><span class="flip">${m}</span>`;
    clockEl.querySelectorAll('.flip').forEach(f=>{
      f.style.transform = 'translateY(-3px)';
      requestAnimationFrame(()=>{ f.style.transform = 'translateY(0)'; });
    });
    lastClockStr = str;
  }
}

/* =========================================================
   ADD / EDIT EVENT MODAL
   ========================================================= */
const backdrop = document.getElementById('modalBackdrop');

// Shared helper: keeps aria-pressed in sync with the 'selected' class for
// every toggle-style chip button in the app, so screen readers announce
// the current selection instead of just a plain, state-less button.
function setChipSelected(el, selected){
  el.classList.toggle('selected', selected);
  el.setAttribute('aria-pressed', String(selected));
}
function syncCategoryChips(value){
  document.querySelectorAll('#fCategoryChips .cat-chip').forEach(c=>{
    setChipSelected(c, c.dataset.cat === value);
  });
}
document.querySelectorAll('#fCategoryChips .cat-chip').forEach(chip=>{
  chip.onclick = ()=>{
    document.getElementById('fCategory').value = chip.dataset.cat;
    syncCategoryChips(chip.dataset.cat);
  };
});
document.querySelectorAll('.quick-chip[data-duration]').forEach(chip=>{
  chip.onclick = ()=>{
    document.getElementById('fDuration').value = chip.dataset.duration;
    document.querySelectorAll('.quick-chip[data-duration]').forEach(c=>setChipSelected(c, c===chip));
  };
});
document.querySelectorAll('.quick-chip[data-date-shortcut]').forEach(chip=>{
  chip.onclick = ()=>{
    const d = chip.dataset.dateShortcut === 'tomorrow' ? addDays(new Date(),1) : new Date();
    document.getElementById('fDate').value = fmtDate(d);
    document.querySelectorAll('.quick-chip[data-date-shortcut]').forEach(c=>setChipSelected(c, c===chip));
  };
});

let recurSelectedDays = new Set();
let editingEventId = null; // null = creating a new event; otherwise the plain-event id being edited (recurring occurrences resolve to their anchor id)

export function openAddEventModal(defaultDate){
  editingEventId = null;
  document.getElementById('modalTitle').textContent = 'New event';
  document.getElementById('saveEvent').textContent = 'Save event';
  document.getElementById('fTitle').value='';
  document.getElementById('fDate').value = defaultDate || fmtDate(new Date());
  document.getElementById('fStart').value = '09:00';
  document.getElementById('fDuration').value = 30;
  document.getElementById('fCategory').value = 'Work';
  document.getElementById('fFlex').value = 'flexible';
  document.getElementById('fReminder').value = 'none';
  document.getElementById('fRecurType').value = 'none';
  document.getElementById('fRecurDaysRow').style.display = 'none';
  recurSelectedDays = new Set();
  document.querySelectorAll('.recur-day-chip').forEach(c=>{ c.classList.remove('selected'); c.setAttribute('aria-pressed','false'); });
  syncCategoryChips('Work');
  document.querySelectorAll('.quick-chip[data-duration]').forEach(c=>setChipSelected(c, c.dataset.duration==='30'));
  document.querySelectorAll('.quick-chip[data-date-shortcut]').forEach(c=>setChipSelected(c, c.dataset.dateShortcut==='today' && !defaultDate));
  openModal(backdrop);
}
document.getElementById('addBtn').onclick = ()=> openAddEventModal();
document.getElementById('cancelModal').onclick = ()=> closeModal(backdrop);

/* Opens the same modal pre-filled for editing. For a recurring occurrence,
   edits are applied to the anchor (the one stored copy), which is the same
   "one series, edit it once" model already used for subtasks. */
export function openEditEventModal(eventId){
  const anchor = getAnchorForSubtasks(eventId);
  if(!anchor){ showToast('Could not find that event'); return; }
  editingEventId = anchor.id;
  document.getElementById('modalTitle').textContent = anchor.recurrence && anchor.recurrence.type!=='none' ? 'Edit event (whole series)' : 'Edit event';
  document.getElementById('saveEvent').textContent = 'Save changes';
  document.getElementById('fTitle').value = anchor.title;
  document.getElementById('fDate').value = anchor.date;
  document.getElementById('fStart').value = anchor.start;
  document.getElementById('fDuration').value = anchor.duration;
  document.getElementById('fCategory').value = anchor.category;
  document.getElementById('fFlex').value = anchor.flex || 'flexible';
  document.getElementById('fReminder').value = anchor.reminder || 'none';
  syncCategoryChips(anchor.category);
  document.querySelectorAll('.quick-chip[data-duration]').forEach(c=>setChipSelected(c, Number(c.dataset.duration)===anchor.duration));
  document.querySelectorAll('.quick-chip[data-date-shortcut]').forEach(c=>setChipSelected(c, false));

  const recurType = (anchor.recurrence && anchor.recurrence.type) || 'none';
  document.getElementById('fRecurType').value = recurType;
  document.getElementById('fRecurDaysRow').style.display = recurType==='weekly' ? 'flex' : 'none';
  recurSelectedDays = new Set((recurType==='weekly' && anchor.recurrence.days) ? anchor.recurrence.days.map(String) : []);
  document.querySelectorAll('.recur-day-chip').forEach(c=>{
    const sel = recurSelectedDays.has(c.dataset.day);
    c.classList.toggle('selected', sel);
    c.setAttribute('aria-pressed', String(sel));
  });

  closeModal(taskModalBackdrop);
  openModal(backdrop);
}

document.getElementById('fRecurType').onchange = (e)=>{
  document.getElementById('fRecurDaysRow').style.display = e.target.value==='weekly' ? 'flex' : 'none';
};
document.querySelectorAll('.recur-day-chip').forEach(chip=>{
  chip.onclick = ()=>{
    const day = chip.dataset.day;
    if(recurSelectedDays.has(day)){ recurSelectedDays.delete(day); setChipSelected(chip, false); }
    else { recurSelectedDays.add(day); setChipSelected(chip, true); }
  };
});

document.getElementById('saveEvent').onclick = ()=>{
  const title = document.getElementById('fTitle').value.trim();
  const date = document.getElementById('fDate').value.trim();
  const start = document.getElementById('fStart').value;
  const durationRaw = parseInt(document.getElementById('fDuration').value,10);
  const duration = Number.isFinite(durationRaw) ? durationRaw : 30;
  const category = document.getElementById('fCategory').value;
  const flex = document.getElementById('fFlex').value;
  const reminder = document.getElementById('fReminder').value;
  const recurType = document.getElementById('fRecurType').value;
  if(!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !start){
    showToast('Fill in title, date (YYYY-MM-DD) and start time');
    return;
  }
  if(!Number.isFinite(duration) || duration < 5){
    showToast('Duration must be at least 5 minutes');
    return;
  }
  if(duration > 1440){
    showToast('Duration can\'t be longer than 24 hours');
    return;
  }
  { // reject an impossible calendar date (e.g. 2026-02-31) instead of silently storing it
    const [dy,dm,dd] = date.split('-').map(Number);
    const check = new Date(dy, dm-1, dd);
    if(check.getFullYear()!==dy || check.getMonth()!==dm-1 || check.getDate()!==dd){
      showToast('That date doesn\'t exist — check the day/month');
      return;
    }
  }
  let recurrence = null;
  if(recurType !== 'none'){
    recurrence = { type: recurType };
    if(recurType === 'weekly'){
      recurrence.days = [...recurSelectedDays].map(Number);
    }
  }
  attemptSaveEvent({ title, date, start, duration, category, flex, reminder, recurrence }, editingEventId);
};

/* =========================================================
   CONFLICT DETECTION — generic modal used both when creating
   a manual event and when dragging/resizing one in Week view.
   ========================================================= */
const conflictModalBackdrop = document.getElementById('conflictModalBackdrop');
let pendingConflictResolution = null; // { onSaveAnyway, onAlt, onCancel }

export function showConflictModal(title, category, start, duration, conflicts, alts, resolution){
  pendingConflictResolution = resolution;
  const meta = catMeta(category);
  const end = toHHMM(toMinutes(start) + duration);
  document.getElementById('conflictBody').innerHTML = `
    <div class="plan-item" style="--cat-bg:var(${meta.bg});--cat-ink:var(${meta.ink});--cat-solid:var(${meta.solid});">
      <span class="pi-title">${meta.icon} ${escapeHtml(title)}</span>
      <span class="pi-time">${fmt12(start)} <span class="pi-arrow">→</span> ${fmt12(end)}</span>
    </div>
    <p class="plan-reason">overlaps with ${conflicts.map(c=>`<strong>${escapeHtml(c.title)}</strong> (${fmt12(c.start)}–${fmt12(toHHMM(toMinutes(c.start)+c.duration))})`).join(', ')}</p>
    ${alts.length
      ? `<div class="onboard-sub" style="text-align:left;margin:14px 0 8px;">Suggested alternatives:</div>
         <div class="quick-row">${alts.map(a=>`<button type="button" class="quick-chip" data-alt-start="${a.start}">${fmt12(a.start)}–${fmt12(a.end)}</button>`).join('')}</div>`
      : `<div class="onboard-sub" style="text-align:left;">No open slot of that length today.</div>`}
  `;
  document.querySelectorAll('#conflictBody [data-alt-start]').forEach(b=>{
    b.onclick = ()=>{
      closeModal(conflictModalBackdrop);
      const res = pendingConflictResolution;
      pendingConflictResolution = null;
      if(res && res.onAlt) res.onAlt(b.dataset.altStart);
    };
  });
  openModal(conflictModalBackdrop);
}
document.getElementById('conflictCancel').onclick = ()=>{
  closeModal(conflictModalBackdrop);
  const res = pendingConflictResolution;
  pendingConflictResolution = null;
  if(res && res.onCancel) res.onCancel();
};
document.getElementById('conflictSaveAnyway').onclick = ()=>{
  closeModal(conflictModalBackdrop);
  const res = pendingConflictResolution;
  pendingConflictResolution = null;
  if(res && res.onSaveAnyway) res.onSaveAnyway();
};

function attemptSaveEvent(draft, editId){
  const conflicts = findConflicts(draft.date, draft.start, draft.duration, editId || null);
  if(conflicts.length === 0){
    commitNewEvent(draft, editId);
    return;
  }
  const alts = findAlternativeSlots(draft.date, draft.duration, editId || null, 2);
  showConflictModal(draft.title, draft.category, draft.start, draft.duration, conflicts, alts, {
    onSaveAnyway: ()=> commitNewEvent(draft, editId),
    onAlt: (altStart)=>{ draft.start = altStart; commitNewEvent(draft, editId); },
    onCancel: ()=>{ /* leave the edit/add modal open so the user can adjust and retry */ }
  });
}

function commitNewEvent(draft, editId){
  if(editId){
    const ev = events.find(e=>e.id===editId);
    if(!ev){ showToast('That event no longer exists'); closeModal(backdrop); return; }
    Object.assign(ev, draft);
    saveEvents(events);
    closeModal(backdrop);
    editingEventId = null;
    renderAll();
    showToast('Event updated');
    return;
  }
  events.push({id:uid(), ...draft, done:false});
  saveEvents(events);
  closeModal(backdrop);
  renderAll();
  showToast(draft.recurrence ? 'Recurring event added' : 'Event added');
}

/* =========================================================
   PREFERENCES SAVE
   ========================================================= */
document.getElementById('savePrefs').onclick = ()=>{
  setPrefs({
    sleepStart: document.getElementById('sleepStart').value,
    sleepEnd: document.getElementById('sleepEnd').value,
    workStart: document.getElementById('workStart').value,
    workEnd: document.getElementById('workEnd').value,
    exStart: document.getElementById('exStart').value,
    exEnd: document.getElementById('exEnd').value,
    clockFormat: document.getElementById('clockFormatSelect').value,
    weekStart: document.getElementById('weekStartSelect').value,
    flexible: {
      Study: document.getElementById('flexStudy').checked,
      Exercise: document.getElementById('flexExercise').checked,
      Shopping: document.getElementById('flexShopping').checked,
      'Free time': document.getElementById('flexFree').checked,
      Work: document.getElementById('flexWork').checked,
      Other: true,
    }
  });
  savePrefs(prefs);
  renderAll();
  const note = document.getElementById('saveNote');
  note.classList.add('show');
  setTimeout(()=>note.classList.remove('show'), 1500);
};

/* =========================================================
   SPECIAL DAYS (birthdays, anniversaries, important dates)
   ========================================================= */
let dayModalDate = null;
const dayModalBackdrop = document.getElementById('dayModalBackdrop');

export function openDayModal(dateStr){
  dayModalDate = dateStr;
  document.getElementById('dayModalTitle').textContent = niceDate(dateStr);

  const list = document.getElementById('dayEventsList');
  const dayEvents = eventsForDate(dateStr);
  list.innerHTML = dayEvents.length
    ? dayEvents.map(e=>`<div class="dl-item"><span>${fmt12(e.start)}</span>${escapeHtml(e.title)}</div>`).join('')
    : `<div class="dl-item" style="justify-content:center;color:var(--ink-dim);">No events yet</div>`;

  const existing = specialDayFor(dateStr);
  const existingWrap = document.getElementById('specialExistingWrap');
  if(existing){
    existingWrap.innerHTML = `<div class="special-existing">
      <span>★ ${escapeHtml(existing.title)} (${existing.type}${existing.recurring?', yearly':''})</span>
      <button class="icon-btn" id="removeSpecialBtn" title="Remove" aria-label="Remove special day">✕</button>
    </div>`;
    document.getElementById('removeSpecialBtn').onclick = ()=>{
      removeSpecialDayById(existing.id);
      saveSpecialDays(specialDays);
      openDayModal(dateStr);
      renderMonth(); renderYear();
    };
    document.getElementById('specialTitle').value = existing.title;
    document.getElementById('specialType').value = existing.type;
    document.getElementById('specialRecurring').checked = existing.recurring;
  } else {
    existingWrap.innerHTML = '';
    document.getElementById('specialTitle').value = '';
    document.getElementById('specialType').value = 'Birthday';
    document.getElementById('specialRecurring').checked = true;
  }

  openModal(dayModalBackdrop);
}
document.getElementById('closeDayModal').onclick = ()=> closeModal(dayModalBackdrop);
document.getElementById('dayAddEventBtn').onclick = ()=>{
  closeModal(dayModalBackdrop);
  openAddEventModal(dayModalDate);
};
document.getElementById('saveSpecialDay').onclick = ()=>{
  const title = document.getElementById('specialTitle').value.trim();
  if(!title){ showToast('Give the day a title first'); return; }
  const type = document.getElementById('specialType').value;
  const recurring = document.getElementById('specialRecurring').checked;
  const existing = specialDayFor(dayModalDate);
  if(existing){
    existing.title = title; existing.type = type; existing.recurring = recurring; existing.date = dayModalDate;
  } else {
    specialDays.push({id:uid(), date:dayModalDate, title, type, recurring});
  }
  saveSpecialDays(specialDays);
  closeModal(dayModalBackdrop);
  renderMonth(); renderYear();
  showToast('Special day saved');
};

// specialDayFor lives in state.js next to the specialDays array itself;
// re-declared here as a thin pass-through so this section reads the way
// the rest of the file does (a plain function call, no module prefix).
// specialDayFor lives in state.js next to the specialDays array itself.

/* =========================================================
   TASK DETAIL MODAL — breakdown / subtasks
   (click any event card in Today or any block in Week to open)
   ========================================================= */
let taskModalEventId = null;
const taskModalBackdrop = document.getElementById('taskModalBackdrop');

function getAnchorForSubtasks(id){
  return id.includes('::') ? events.find(e=>e.id===id.slice(0,id.indexOf('::'))) : events.find(e=>e.id===id);
}

export function openTaskModal(eventId){
  const e = resolveOccurrence(eventId);
  if(!e) return;
  taskModalEventId = eventId;
  const meta = catMeta(e.category);

  const icon = document.getElementById('taskModalIcon');
  icon.textContent = meta.icon;
  icon.style.setProperty('--cat-solid', `var(${meta.solid})`);

  document.getElementById('taskModalTitle').textContent = e.title;
  document.getElementById('taskModalSub').textContent =
    `${niceDate(e.date)} · ${fmt12(e.start)} – ${fmt12(toHHMM(toMinutes(e.start)+e.duration))} · ${e.category}${e.isRecurring?' · repeating':''}`;

  const catLower = e.category.toLowerCase();
  document.getElementById('subLabel').placeholder = catLower==='exercise' ? 'e.g. Squats' : catLower==='study' ? 'e.g. Chapter 3' : 'e.g. Part 1';
  document.getElementById('subDetail').placeholder = catLower==='exercise' ? 'e.g. 4 sets × 10 reps, 90s rest' : 'e.g. 16:00–16:20';
  document.getElementById('subLabel').value = '';
  document.getElementById('subDetail').value = '';

  renderSubtaskList(getAnchorForSubtasks(eventId));
  openModal(taskModalBackdrop);
}

function renderSubtaskList(anchor){
  const list = document.getElementById('subtaskList');
  if(!anchor){ list.innerHTML = ''; return; }
  const subs = anchor.subtasks || [];
  list.innerHTML = subs.length
    ? subs.map(s=>`
        <div class="subtask-row">
          <div class="st-main"><span class="st-label">${escapeHtml(s.label)}</span>${s.detail?`<span class="st-detail">${escapeHtml(s.detail)}</span>`:''}</div>
          <button class="icon-btn" data-rm-sub="${s.id}" title="Remove" aria-label="Remove ${escapeHtml(s.label)}">✕</button>
        </div>
      `).join('')
    : `<div class="subtask-empty">No breakdown yet — add the parts of this task below (times, sets, reps, whatever fits).</div>`;
  list.querySelectorAll('[data-rm-sub]').forEach(btn=>{
    btn.onclick = ()=>{
      anchor.subtasks = (anchor.subtasks||[]).filter(s=>s.id!==btn.dataset.rmSub);
      saveEvents(events);
      renderSubtaskList(anchor);
    };
  });
}

document.getElementById('addSubtaskBtn').onclick = ()=>{
  const anchor = getAnchorForSubtasks(taskModalEventId);
  if(!anchor) return;
  const label = document.getElementById('subLabel').value.trim();
  const detail = document.getElementById('subDetail').value.trim();
  if(!label){ showToast('Give this part a name first'); return; }
  anchor.subtasks = anchor.subtasks || [];
  anchor.subtasks.push({id:uid(), label, detail});
  saveEvents(events);
  document.getElementById('subLabel').value = '';
  document.getElementById('subDetail').value = '';
  renderSubtaskList(anchor);
  renderAll();
};
document.getElementById('closeTaskModal').onclick = ()=> closeModal(taskModalBackdrop);
document.getElementById('editTaskBtn').onclick = ()=>{
  if(!taskModalEventId) return;
  openEditEventModal(taskModalEventId);
};
document.getElementById('deleteTaskBtn').onclick = ()=>{
  if(!taskModalEventId) return;
  const id = taskModalEventId;
  const isRecurring = id.includes('::');
  closeModal(taskModalBackdrop);
  openConfirm(
    isRecurring ? 'Remove this occurrence?' : 'Delete this event?',
    isRecurring ? 'Only this date is removed — the rest of the series stays. You can undo right after.' : 'You can undo right after.',
    ()=> deleteEventOccurrence(id)
  );
};

/* =========================================================
   GENERIC CONFIRM MODAL
   ========================================================= */
const confirmModalBackdrop = document.getElementById('confirmModalBackdrop');
let confirmCallback = null;
export function openConfirm(title, body, onConfirm){
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalBody').textContent = body;
  confirmCallback = onConfirm;
  openModal(confirmModalBackdrop);
}
document.getElementById('confirmModalCancel').onclick = ()=>{
  closeModal(confirmModalBackdrop);
  confirmCallback = null;
};
document.getElementById('confirmModalOk').onclick = ()=>{
  closeModal(confirmModalBackdrop);
  if(confirmCallback) confirmCallback();
  confirmCallback = null;
};

/* =========================================================
   PREFS "DANGER ZONE" — clear events / full app reset
   ========================================================= */
document.getElementById('clearEventsBtnPrefs').onclick = ()=>{
  openConfirm(
    'Clear all events?',
    'This permanently deletes every event on your schedule. Your preferences and any special days (birthdays, etc.) are kept. This can\'t be undone.',
    ()=> applyTemplate('clear')
  );
};
document.getElementById('resetAppBtn').onclick = ()=>{
  openConfirm(
    'Reset the application?',
    'This wipes everything — events, preferences, special days, and onboarding — back to a blank first-run state. Export a backup first if you want to keep anything. This can\'t be undone.',
    ()=>{
      [STORE_KEY, PREFS_KEY, SPECIAL_KEY, RECUR_OVERRIDES_KEY, REMINDER_FIRED_KEY, ONBOARD_KEY].forEach(k=>{ try{ localStorage.removeItem(k); }catch(err){ console.warn('Timetable: could not clear a storage key', err); } });
      location.reload();
    }
  );
};

/* =========================================================
   STARTER TEMPLATES
   ========================================================= */
function applyTemplate(kind){
  if(kind==='clear'){
    const backup = events.slice();
    setEvents([]);
    saveEvents(events);
    renderAll(); renderMonth(); renderYear();
    showUndoToast('All events cleared', ()=>{
      setEvents(backup);
      saveEvents(events);
      renderAll(); renderMonth(); renderYear();
    });
    return;
  }
  const added = [];
  if(kind==='sports'){
    [1,3,5].forEach(dow=>{ // Mon, Wed, Fri
      added.push({id:uid(), title:'Workout', date: nextDateForWeekday(dow), start:'07:00', duration:45, category:'Exercise', flex:'flexible', done:false, subtasks:[
        {id:uid(), label:'Squats', detail:'4 sets × 10 reps, 90s rest'},
        {id:uid(), label:'Push-ups', detail:'3 sets × 15 reps, 60s rest'},
        {id:uid(), label:'Plank', detail:'3 sets × 45s hold, 45s rest'},
      ]});
    });
    [2,4].forEach(dow=>{ // Tue, Thu
      added.push({id:uid(), title:'Run', date: nextDateForWeekday(dow), start:'18:00', duration:30, category:'Exercise', flex:'flexible', done:false, subtasks:[
        {id:uid(), label:'Easy pace', detail:'0–20 min'},
        {id:uid(), label:'Cool-down walk', detail:'20–30 min'},
      ]});
    });
  } else if(kind==='study'){
    [1,2,3,4,5].forEach(dow=>{
      added.push({id:uid(), title:'Study session', date: nextDateForWeekday(dow), start:'19:00', duration:60, category:'Study', flex:'flexible', done:false, subtasks:[
        {id:uid(), label:'Review notes', detail:'19:00–19:20'},
        {id:uid(), label:'Practice problems', detail:'19:20–19:50'},
        {id:uid(), label:'Quick recap', detail:'19:50–20:00'},
      ]});
    });
  }
  addEvents(added);
  saveEvents(events);
  renderAll(); renderMonth(); renderYear();
  showToast(`${kind==='sports'?'Sports':'Study'} calendar added — ${added.length} sessions this week`);
}
document.querySelectorAll('[data-template]').forEach(btn=>{
  btn.onclick = ()=>{
    const kind = btn.dataset.template;
    if(kind==='clear'){
      openConfirm(
        'Clear all events?',
        'This permanently deletes every event on your schedule, including anything added from a template. Your preferences and any special days (birthdays, etc.) are kept. This can\'t be undone.',
        ()=> applyTemplate('clear')
      );
    } else {
      applyTemplate(kind);
    }
  };
});

/* =========================================================
   ONBOARDING SETUP WIZARD
   ========================================================= */
const ONBOARD_KEY = 'timetable_onboarded_v1';

const OB_CATEGORY_CONFIG = {
  'Exercise':  { title:'Workout', days:[1,3,5], duration:45,
    starts:{morning:'07:00', afternoon:'13:00', evening:'18:00'},
    subtasks:[{label:'Squats', detail:'4 sets × 10 reps, 90s rest'},{label:'Push-ups', detail:'3 sets × 15 reps, 60s rest'}] },
  'Study':     { title:'Study session', days:[1,2,3,4,5], duration:60,
    starts:{morning:'08:00', afternoon:'14:00', evening:'19:00'},
    subtasks:[{label:'Review notes', detail:'first 20 min'},{label:'Practice problems', detail:'remaining time'}] },
  'Free time': { title:'Free time', days:[2,6], duration:60,
    starts:{morning:'10:00', afternoon:'15:00', evening:'19:00'},
    subtasks:[] },
  'Shopping':  { title:'Shopping / errands', days:[6], duration:45,
    starts:{morning:'10:00', afternoon:'14:00', evening:'18:00'},
    subtasks:[] },
};
export const OB_DAY_LABEL = {1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat',0:'Sun'};

let obSelectedCats = new Set();
let obTimePrefs = {}; // category -> 'morning'|'afternoon'|'evening'
let obSuggestions = []; // computed events, each with .included bool

const onboardBackdrop = document.getElementById('onboardBackdrop');

function obShowStep(n){
  [1,2,3].forEach(i=>{
    document.getElementById('obStep'+i).style.display = (i===n) ? '' : 'none';
  });
  document.querySelectorAll('#onboardDots .dot').forEach((d,i)=>{
    d.classList.toggle('active', i===(n-1));
  });
}

function openOnboarding(){
  obSelectedCats = new Set();
  obTimePrefs = {};
  document.querySelectorAll('#obCategoryChips .chip').forEach(c=>c.classList.remove('selected'));
  obShowStep(1);
  openModal(onboardBackdrop);
}
function closeOnboarding(){
  closeModal(onboardBackdrop);
  safeSetItem(ONBOARD_KEY, '1');
}

document.querySelectorAll('#obCategoryChips .chip').forEach(chip=>{
  chip.onclick = ()=>{
    const cat = chip.dataset.cat;
    if(obSelectedCats.has(cat)){ obSelectedCats.delete(cat); chip.classList.remove('selected'); }
    else { obSelectedCats.add(cat); chip.classList.add('selected'); }
  };
});
document.getElementById('obSkip1').onclick = closeOnboarding;
document.getElementById('obNext1').onclick = ()=>{
  if(obSelectedCats.size === 0){ closeOnboarding(); return; }
  renderObTimeQuestions();
  obShowStep(2);
};
document.getElementById('obBack2').onclick = ()=> obShowStep(1);

function renderObTimeQuestions(){
  const wrap = document.getElementById('obTimeQuestions');
  wrap.innerHTML = '';
  obSelectedCats.forEach(cat=>{
    if(!obTimePrefs[cat]) obTimePrefs[cat] = 'morning';
    const meta = catMeta(cat);
    const row = document.createElement('div');
    row.className = 'otq-row';
    row.innerHTML = `
      <div class="otq-label">${meta.icon} ${cat==='Free time'?'Hobbies':cat}</div>
      <div class="chip-grid">
        <button class="chip ${obTimePrefs[cat]==='morning'?'selected':''}" data-cat="${cat}" data-time="morning">Morning</button>
        <button class="chip ${obTimePrefs[cat]==='afternoon'?'selected':''}" data-cat="${cat}" data-time="afternoon">Afternoon</button>
        <button class="chip ${obTimePrefs[cat]==='evening'?'selected':''}" data-cat="${cat}" data-time="evening">Evening</button>
      </div>
    `;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('.chip').forEach(chip=>{
    chip.onclick = ()=>{
      const cat = chip.dataset.cat;
      obTimePrefs[cat] = chip.dataset.time;
      wrap.querySelectorAll(`.chip[data-cat="${cat}"]`).forEach(c=>c.classList.remove('selected'));
      chip.classList.add('selected');
    };
  });
}

document.getElementById('obNext2').onclick = ()=>{
  buildObSuggestions();
  renderObSuggestions();
  obShowStep(3);
};
document.getElementById('obBack3').onclick = ()=> obShowStep(2);

function buildObSuggestions(){
  obSuggestions = [];
  obSelectedCats.forEach(cat=>{
    const cfg = OB_CATEGORY_CONFIG[cat];
    if(!cfg) return; // Work has no config — handled separately below
    const timePref = obTimePrefs[cat] || 'morning';
    const start = cfg.starts[timePref];
    cfg.days.forEach(dow=>{
      obSuggestions.push({
        included:true, category:cat, title:cfg.title,
        date: nextDateForWeekday(dow), start, duration:cfg.duration,
        dayLabel: OB_DAY_LABEL[dow],
        subtasks: cfg.subtasks.map(s=>({id:uid(), ...s}))
      });
    });
  });
  if(obSelectedCats.has('Work')){
    [1,2,3,4,5].forEach(dow=>{
      obSuggestions.push({
        included:true, category:'Work', title:'Focus work block', fixed:true,
        date: nextDateForWeekday(dow), start: prefs.workStart, duration:120,
        dayLabel: OB_DAY_LABEL[dow], subtasks:[]
      });
    });
  }
}

function renderObSuggestions(){
  const wrap = document.getElementById('obSuggestions');
  if(obSuggestions.length===0){
    wrap.innerHTML = `<div class="subtask-empty">Nothing to add — go back and pick at least one option.</div>`;
    return;
  }
  const byCat = {};
  obSuggestions.forEach((s,i)=>{ s._idx = i; (byCat[s.category]=byCat[s.category]||[]).push(s); });
  wrap.innerHTML = Object.keys(byCat).map(cat=>{
    const meta = catMeta(cat);
    return `<div class="ob-cat-group">
      <div class="ob-cat-title">${meta.icon} ${cat==='Free time'?'Hobbies':cat}</div>
      ${byCat[cat].map(s=>`
        <label class="ob-suggestion-row" style="--cat-bg:var(${meta.bg});--cat-ink:var(${meta.ink});">
          <input type="checkbox" data-ob-idx="${s._idx}" ${s.included?'checked':''}>
          <span class="ob-s-text"><b>${s.dayLabel} ${fmt12(s.start)}</b> — ${escapeHtml(s.title)} (${s.duration} min)</span>
        </label>
      `).join('')}
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-ob-idx]').forEach(cb=>{
    cb.onchange = ()=>{ obSuggestions[cb.dataset.obIdx].included = cb.checked; };
  });
}

document.getElementById('obApply').onclick = ()=>{
  const toAdd = obSuggestions.filter(s=>s.included).map(s=>({
    id:uid(), title:s.title, date:s.date, start:s.start, duration:s.duration,
    category:s.category, flex: s.fixed ? 'fixed' : 'flexible', done:false, subtasks:s.subtasks
  }));
  if(toAdd.length){
    addEvents(toAdd);
    saveEvents(events);
    if(obSelectedCats.has('Exercise')){
      prefs.exStart = OB_CATEGORY_CONFIG['Exercise'].starts[obTimePrefs['Exercise']];
      prefs.exEnd = toHHMM(toMinutes(prefs.exStart) + 120);
      savePrefs(prefs);
    }
    renderAll();
  }
  closeOnboarding();
  showToast(toAdd.length ? `Schedule set up — ${toAdd.length} sessions added` : 'Setup skipped');
};

document.getElementById('retakeSetupBtn').onclick = openOnboarding;

// Show the wizard automatically the first time someone opens the app
if(!safeGetItem(ONBOARD_KEY)){
  openOnboarding();
}

/* =========================================================
   DEADLINE TASK MODAL — "I need to finish X by <date>,
   roughly Y hours of work" gets distributed into sessions by
   the scheduler and handed to the assistant as a proposal.
   ========================================================= */
const deadlineModalBackdrop = document.getElementById('deadlineModalBackdrop');
let dlSelectedCategory = 'Study';
export function openDeadlineModal(){
  document.getElementById('dlTitle').value = '';
  document.getElementById('dlDeadline').value = '';
  document.getElementById('dlMinutes').value = 180;
  document.getElementById('dlSubParts').value = '';
  dlSelectedCategory = 'Study';
  document.querySelectorAll('#dlCategoryChips .cat-chip').forEach(c=>setChipSelected(c, c.dataset.cat==='Study'));
  document.querySelectorAll('#deadlineModalBackdrop [data-dl-hours]').forEach(c=>setChipSelected(c, c.dataset.dlHours==='3'));
  openModal(deadlineModalBackdrop);
}
document.getElementById('dlCancel').onclick = ()=> closeModal(deadlineModalBackdrop);
document.querySelectorAll('#dlCategoryChips .cat-chip').forEach(chip=>{
  chip.onclick = ()=>{
    dlSelectedCategory = chip.dataset.cat;
    document.querySelectorAll('#dlCategoryChips .cat-chip').forEach(c=>setChipSelected(c, c===chip));
  };
});
document.querySelectorAll('#deadlineModalBackdrop [data-dl-hours]').forEach(chip=>{
  chip.onclick = ()=>{
    document.getElementById('dlMinutes').value = parseInt(chip.dataset.dlHours,10) * 60;
    document.querySelectorAll('#deadlineModalBackdrop [data-dl-hours]').forEach(c=>setChipSelected(c, c===chip));
  };
});
document.getElementById('dlSubmit').onclick = ()=>{
  const title = document.getElementById('dlTitle').value.trim();
  const deadline = document.getElementById('dlDeadline').value.trim();
  const minutes = parseInt(document.getElementById('dlMinutes').value, 10) || 0;
  const subPartsRaw = document.getElementById('dlSubParts').value.trim();
  const subParts = subPartsRaw ? subPartsRaw.split('\n').map(s=>s.trim()).filter(Boolean) : null;
  if(!title || !/^\d{4}-\d{2}-\d{2}$/.test(deadline) || minutes < 15){
    showToast('Fill in a title, a valid deadline date, and at least 15 minutes of effort');
    return;
  }
  logAssistantTurn('user', `Deadline task: "${title}" by ${deadline}, ${formatDuration(minutes)}${subParts?`, ${subParts.length} parts`:''}`);
  closeModal(deadlineModalBackdrop);
  openDeadlineTaskProposal(title, deadline, minutes, subParts, dlSelectedCategory);
};

/* =========================================================
   TOASTS
   ========================================================= */
let toastTimer;
export function showToast(msg){
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastUndoBtn').style.display = 'none';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('show'), 2200);
}

let pendingUndo = null;
export function showUndoToast(msg, undoFn){
  pendingUndo = undoFn;
  const t = document.getElementById('toast');
  const btn = document.getElementById('toastUndoBtn');
  document.getElementById('toastMsg').textContent = msg;
  btn.style.display = 'inline-block';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{
    t.classList.remove('show');
    pendingUndo = null;
  }, 6000);
}
document.getElementById('toastUndoBtn').onclick = ()=>{
  if(pendingUndo){ pendingUndo(); pendingUndo = null; }
  document.getElementById('toast').classList.remove('show');
  clearTimeout(toastTimer);
};
