// =========================================================
// calendar.js — Today / Week / Month / Year rendering, plus
// the week-view drag-and-drop/resize interaction (it's tightly
// coupled to renderWeek's DOM layout, so it lives here rather
// than split into its own file).
// =========================================================
import {
  fmtDate, addDays, toMinutes, toHHMM, pad, uid, fmt12, formatDuration,
  catMeta, escapeHtml, WEEKDAYS, weekStartOffset, weekdayDisplayOrder, startOfWeekFor
} from './utils.js';
import { events, saveEvents, specialDayFor, removeEventById } from './state.js';
import {
  eventsForDate, resolveOccurrence, toggleEventDone, deleteEventOccurrence,
  setRecurOverride, clearRecurOverride
} from './recurrence.js';
import { findConflicts, findAlternativeSlots } from './scheduler.js';
import { openTaskModal, openAddEventModal, openDayModal, showConflictModal, showUndoToast } from './ui.js';

/* =========================================================
   TODAY VIEW
   ========================================================= */
export function renderToday(){
  const today = fmtDate(new Date());
  const list = eventsForDate(today);
  const track = document.getElementById('todayList');
  track.innerHTML = '';
  if(list.length===0){
    track.innerHTML = `
      <div class="today-empty-state">
        <div class="es-emoji">🗓️</div>
        <h3>Your day is wide open.</h3>
        <p>Tell me what you want to accomplish, or add something manually.</p>
        <div class="es-actions">
          <button class="primary" id="emptyAddEventBtn">+ Add event</button>
        </div>
        <div class="es-examples">
          <span>Or try the assistant:</span>
          <button class="es-example-chip" data-fill-command="Study tomorrow evening for 2 hours">"Study tomorrow evening for 2 hours"</button>
          <button class="es-example-chip" data-fill-command="Find time for exercise tomorrow">"Find time for exercise tomorrow"</button>
        </div>
      </div>`;
    document.getElementById('emptyAddEventBtn').onclick = ()=> openAddEventModal();
    track.querySelectorAll('[data-fill-command]').forEach(chip=>{
      chip.onclick = ()=>{
        const input = document.getElementById('commandInput');
        input.value = chip.dataset.fillCommand;
        input.focus();
      };
    });
  } else {
    const nowMin = new Date().getHours()*60 + new Date().getMinutes();
    list.forEach(e=>{
      const meta = catMeta(e.category);
      const startMin = toMinutes(e.start);
      const isCurrent = !e.done && nowMin >= startMin && nowMin < startMin + e.duration;
      const card = document.createElement('div');
      card.className = 'event-card' + (e.done ? ' is-done' : '') + (isCurrent ? ' is-current' : '');
      card.style.setProperty('--cat-bg', `var(${meta.bg})`);
      card.style.setProperty('--cat-ink', `var(${meta.ink})`);
      card.style.setProperty('--cat-solid', `var(${meta.solid})`);
      const subCount = (e.subtasks||[]).length;
      card.innerHTML = `
        <button class="check-btn ${e.done?'checked':''}" data-toggle="${e.id}" title="Mark done" aria-label="Mark ${escapeHtml(e.title)} as ${e.done?'not done':'done'}" aria-pressed="${e.done}">${e.done?'✓':''}</button>
        <div class="cat-icon">${meta.icon}</div>
        <div class="event-main">
          <div class="title">${escapeHtml(e.title)}${e.isRecurring?' <span class="recur-tag" title="Recurring">🔁</span>':''}${e.done?' <span class="done-tag">· done</span>':''}</div>
          <div class="meta">${fmt12(e.start)} · ${e.duration} min${subCount?` · ${subCount} step${subCount>1?'s':''}`:''}${(e.reminder && e.reminder!=='none')?' · 🔔':''}</div>
        </div>
        <div class="event-side">
          <span class="badge">${e.flex==='fixed'?'Fixed':'Flexible'}</span>
          <button class="icon-btn" title="Delete" data-del="${e.id}" aria-label="Delete ${escapeHtml(e.title)}">✕</button>
        </div>
      `;
      card.onclick = ()=> openTaskModal(e.id);
      track.appendChild(card);
    });
    track.querySelectorAll('[data-del]').forEach(btn=>{
      btn.onclick = (ev)=>{
        ev.stopPropagation();
        deleteEventOccurrence(btn.dataset.del);
      };
    });
    track.querySelectorAll('[data-toggle]').forEach(btn=>{
      btn.onclick = (ev)=>{
        ev.stopPropagation();
        toggleEventDone(btn.dataset.toggle);
      };
    });
  }
  updateProgress(list);
  renderNowNext(list);
}

export function renderNowNext(list){
  const wrap = document.getElementById('nowNextHero');
  const nowMin = new Date().getHours()*60 + new Date().getMinutes();
  const sorted = list.slice().sort((a,b)=> toMinutes(a.start)-toMinutes(b.start));
  const current = sorted.find(e=>{
    const s = toMinutes(e.start);
    return !e.done && nowMin >= s && nowMin < s + e.duration;
  });
  const next = sorted.find(e=>{
    const s = toMinutes(e.start);
    return !e.done && s > (current ? toMinutes(current.start)+current.duration-1 : nowMin-1) && s >= nowMin;
  });

  if(!current && !next){ wrap.innerHTML = ''; return; }

  function cardHtml(e, label, extra){
    const meta = catMeta(e.category);
    return `<div class="nn-card ${label==='NOW'?'nn-now':'nn-next'}" style="--cat-bg:var(${meta.bg});--cat-ink:var(${meta.ink});--cat-solid:var(${meta.solid});">
      <div class="nn-label">${label}</div>
      <div class="nn-title">${meta.icon} ${escapeHtml(e.title)}</div>
      <div class="nn-time">${fmt12(e.start)}–${fmt12(toHHMM(toMinutes(e.start)+e.duration))}</div>
      ${extra || ''}
    </div>`;
  }

  let html = '<div class="now-next-wrap">';
  if(current){
    const remaining = toMinutes(current.start) + current.duration - nowMin;
    html += cardHtml(current, 'NOW', `<span class="nn-remaining">${remaining} min remaining</span>`);
  } else {
    html += `<div class="nn-empty">Nothing happening right now.</div>`;
  }
  if(next){
    html += cardHtml(next, 'NEXT');
  } else {
    html += `<div class="nn-empty">Nothing else planned today.</div>`;
  }
  html += '</div>';
  wrap.innerHTML = html;
}

export function updateProgress(list){
  const total = list.length;
  const done = list.filter(e=>e.done).length;
  const circle = document.getElementById('ringProgress');
  const circumference = 2 * Math.PI * 21;
  const pct = total ? done/total : 0;
  circle.setAttribute('stroke-dasharray', circumference.toFixed(1));
  circle.setAttribute('stroke-dashoffset', (circumference * (1-pct)).toFixed(1));
  document.getElementById('ringLabel').textContent = `${done}/${total}`;
  const headline = document.getElementById('progressHeadline');
  const sub = document.getElementById('progressSub');
  if(total === 0){
    headline.textContent = 'Nothing planned yet';
    sub.textContent = 'Add or ask for something below';
  } else if(done === total){
    headline.textContent = 'All done for today';
    sub.textContent = 'Nice work — day complete';
  } else {
    headline.textContent = `${done} of ${total} done`;
    sub.textContent = `${total-done} left today`;
  }
}

/* =========================================================
   WEEK VIEW
   ========================================================= */
const WEEK_START_HOUR = 6;
const WEEK_END_HOUR = 23; // exclusive-ish upper bound for grid
const WEEK_HOUR_HEIGHT = 52; // px
let weekCursor = new Date(); // any date within the displayed week
export function getWeekCursor(){ return weekCursor; }

/* Assigns each event in a day a lane (col) and the total lane count (cols)
   of the cluster of events it overlaps with, so overlapping/conflicting
   events render side by side instead of stacking on top of each other. */
export function layoutOverlappingEvents(dayEvents){
  const result = new Map();
  if(!dayEvents.length) return result;
  const items = dayEvents.map(e=>({
    id: e.id,
    start: toMinutes(e.start),
    end: toMinutes(e.start) + Math.max(e.duration, 1)
  })).sort((a,b)=> a.start-b.start || a.end-b.end);

  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;
  items.forEach(it=>{
    if(current.length && it.start >= clusterEnd){
      clusters.push(current);
      current = [];
      clusterEnd = -Infinity;
    }
    current.push(it);
    clusterEnd = Math.max(clusterEnd, it.end);
  });
  if(current.length) clusters.push(current);

  clusters.forEach(cluster=>{
    const columnEnds = []; // last occupied end-time per lane
    cluster.forEach(it=>{
      let col = columnEnds.findIndex(end => it.start >= end);
      if(col === -1){ col = columnEnds.length; columnEnds.push(it.end); }
      else columnEnds[col] = it.end;
      it._col = col;
    });
    const cols = columnEnds.length;
    cluster.forEach(it=> result.set(it.id, {col: it._col, cols}));
  });
  return result;
}

export function renderWeek(){
  const wrap = document.getElementById('weekTimegrid');
  const today = new Date();
  const todayStr = fmtDate(today);
  const startOfWeek = startOfWeekFor(weekCursor);
  const endOfWeek = addDays(startOfWeek, 6);

  document.getElementById('weekTitle').textContent =
    `${startOfWeek.toLocaleDateString(undefined,{month:'short',day:'numeric'})} – ${endOfWeek.toLocaleDateString(undefined,{month:'short',day:'numeric'})}`;

  const hours = [];
  for(let h=WEEK_START_HOUR; h<=WEEK_END_HOUR; h++) hours.push(h);
  const totalHeight = hours.length * WEEK_HOUR_HEIGHT;

  let daysHtml = '';
  let headHtml = '';
  for(let i=0;i<7;i++){
    const d = addDays(startOfWeek, i);
    const dateStr = fmtDate(d);
    const isToday = dateStr === todayStr;
    headHtml += `<div class="wtg-day-head${isToday?' is-today':''}"><span class="dow">${WEEKDAYS[d.getDay()].slice(0,3)}</span><span class="dnum">${d.getDate()}</span></div>`;

    const dayEvents = eventsForDate(dateStr);
    let eventsHtml = '';
    // Conflicting events overlap in time, so they can't all be full-width —
    // give each a lane within its overlap cluster (like most calendar apps)
    // so every event stays visible and independently clickable/draggable.
    const lanes = layoutOverlappingEvents(dayEvents);
    dayEvents.forEach(e=>{
      const meta = catMeta(e.category);
      const startMin = toMinutes(e.start);
      const top = Math.max(0, (startMin - WEEK_START_HOUR*60) / 60 * WEEK_HOUR_HEIGHT);
      const height = Math.max(20, e.duration/60 * WEEK_HOUR_HEIGHT - 3);
      const lane = lanes.get(e.id) || {col:0, cols:1};
      const widthPct = 100 / lane.cols;
      const leftPct = widthPct * lane.col;
      const gap = lane.cols > 1 ? 2 : 3; // px gutter between lanes vs. the usual edge padding
      const style = `top:${top}px;height:${height}px;left:calc(${leftPct}% + ${gap}px);width:calc(${widthPct}% - ${gap*2}px);right:auto;--cat-bg:var(${meta.bg});--cat-ink:var(${meta.ink});--cat-solid:var(${meta.solid});`;
      eventsHtml += `<div class="wtg-event" style="${style}" data-open-task="${e.id}">
        <span class="wtg-event-title">${meta.icon} ${escapeHtml(e.title)}</span>
        <span class="wtg-event-time">${fmt12(e.start)}</span>
        <div class="wtg-resize-handle" title="Drag to resize"></div>
      </div>`;
    });

    let nowLineHtml = '';
    if(isToday){
      const nowMin = today.getHours()*60 + today.getMinutes();
      if(nowMin >= WEEK_START_HOUR*60 && nowMin <= WEEK_END_HOUR*60+60){
        const top = (nowMin - WEEK_START_HOUR*60) / 60 * WEEK_HOUR_HEIGHT;
        nowLineHtml = `<div class="wtg-now-line" style="top:${top}px;"></div>`;
      }
    }

    daysHtml += `<div class="wtg-day-col${isToday?' is-today':''}" data-date="${dateStr}">${eventsHtml}${nowLineHtml}</div>`;
  }

  wrap.innerHTML = `
    <div class="wtg-inner">
      <div class="wtg-header">
        <div class="wtg-time-spacer"></div>
        ${headHtml}
      </div>
      <div class="wtg-body">
        <div class="wtg-time-col">
          ${hours.map(h=>`<div class="wtg-hour-label" style="height:${WEEK_HOUR_HEIGHT}px;">${fmt12(pad(h)+':00')}</div>`).join('')}
        </div>
        <div class="wtg-days" style="--hour-h:${WEEK_HOUR_HEIGHT}px;height:${totalHeight}px;">
          ${daysHtml}
        </div>
      </div>
    </div>
  `;

  setupWeekDragHandlers(wrap);
}
document.getElementById('weekPrev').onclick = ()=>{ weekCursor = addDays(weekCursor,-7); renderWeek(); };
document.getElementById('weekNext').onclick = ()=>{ weekCursor = addDays(weekCursor,7); renderWeek(); };
document.getElementById('weekToday').onclick = ()=>{ weekCursor = new Date(); renderWeek(); };

/* =========================================================
   WEEK VIEW DRAG-AND-DROP
   Drag a block to change its time and/or day. Drag the
   handle at the bottom to resize (change duration). A plain
   tap/click (no movement) still opens the task-detail modal.
   Snaps to 15-minute increments.
   ========================================================= */
const WEEK_SNAP_MIN = 15;
let dragState = null;

function setupWeekDragHandlers(wrap){
  wrap.querySelectorAll('.wtg-event').forEach(el=>{
    el.addEventListener('pointerdown', (ev)=> startEventDrag(ev, el, 'move'));
  });
  wrap.querySelectorAll('.wtg-resize-handle').forEach(handle=>{
    handle.addEventListener('pointerdown', (ev)=>{
      ev.stopPropagation();
      startEventDrag(ev, handle.closest('.wtg-event'), 'resize');
    });
  });
}

function startEventDrag(ev, el, mode){
  if(ev.button !== undefined && ev.button !== 0) return; // left click / primary touch only
  ev.preventDefault();
  const id = el.dataset.openTask;
  const occ = resolveOccurrence(id);
  if(!occ) return;
  dragState = {
    mode, id, occ, el,
    daysContainer: el.closest('.wtg-days'),
    startY: ev.clientY,
    startX: ev.clientX,
    origTop: parseFloat(el.style.top),
    origHeight: parseFloat(el.style.height) + 3, // work in raw duration-pixels (undo the 3px cosmetic gap)
    currentCol: el.closest('.wtg-day-col'),
    gridMaxHeight: el.closest('.wtg-days').offsetHeight, // calendar boundary — nothing may move/resize past this
    moved: false,
  };
  document.addEventListener('pointermove', onEventDragMove);
  document.addEventListener('pointerup', onEventDragEnd);
}

function onEventDragMove(ev){
  if(!dragState) return;
  const dy = ev.clientY - dragState.startY;
  const dx = ev.clientX - dragState.startX;
  if(!dragState.moved && (Math.abs(dy) > 4 || Math.abs(dx) > 4)){
    dragState.moved = true;
    dragState.el.classList.add('dragging');
  }
  if(!dragState.moved) return;

  const snapPx = WEEK_HOUR_HEIGHT * (WEEK_SNAP_MIN/60);

  if(dragState.mode === 'move'){
    let newTop = dragState.origTop + dy;
    newTop = Math.max(0, Math.round(newTop / snapPx) * snapPx);
    // never let a block move past the bottom edge of the calendar grid —
    // clamp using the block's own (unchanged) height, not just one snap unit,
    // so the whole event stays inside the visible grid, not just its top edge.
    const maxTop = Math.max(0, dragState.gridMaxHeight - dragState.origHeight);
    newTop = Math.min(newTop, maxTop);
    dragState.el.style.top = newTop + 'px';

    const cols = [...dragState.daysContainer.querySelectorAll('.wtg-day-col')];
    const hoveredCol = cols.find(c=>{
      const r = c.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX < r.right;
    });
    if(hoveredCol && hoveredCol !== dragState.currentCol){
      dragState.currentCol = hoveredCol;
      hoveredCol.appendChild(dragState.el);
    }
  } else {
    let newHeight = dragState.origHeight + dy;
    newHeight = Math.max(snapPx, Math.round(newHeight / snapPx) * snapPx);
    // never let a resize push the block past the bottom edge of the calendar grid
    newHeight = Math.min(newHeight, dragState.gridMaxHeight - dragState.origTop);
    dragState.el.style.height = (newHeight - 3) + 'px';
  }
}

function onEventDragEnd(){
  document.removeEventListener('pointermove', onEventDragMove);
  document.removeEventListener('pointerup', onEventDragEnd);
  if(!dragState) return;
  const { mode, id, occ, el, moved, currentCol } = dragState;
  dragState = null;

  if(!moved){
    openTaskModal(id);
    return;
  }

  if(mode === 'move'){
    const top = parseFloat(el.style.top);
    const minutesFromGridStart = Math.round((top / WEEK_HOUR_HEIGHT) * 60 / WEEK_SNAP_MIN) * WEEK_SNAP_MIN;
    const newStart = toHHMM(WEEK_START_HOUR*60 + minutesFromGridStart);
    const newDate = currentCol ? currentCol.dataset.date : occ.date;
    finalizeEventMove(occ, newDate, newStart);
  } else {
    const rawHeight = parseFloat(el.style.height) + 3;
    const newDuration = Math.max(WEEK_SNAP_MIN, Math.round((rawHeight / WEEK_HOUR_HEIGHT) * 60 / WEEK_SNAP_MIN) * WEEK_SNAP_MIN);
    finalizeEventResize(occ, newDuration);
  }
}

function finalizeEventMove(occ, newDate, newStart){
  if(newDate === occ.date && newStart === occ.start){ renderWeek(); return; }
  const excludeId = occ.isRecurring ? occ._anchorId : occ.id;
  const conflicts = findConflicts(newDate, newStart, occ.duration, excludeId);
  if(conflicts.length === 0){
    commitOccurrenceChange(occ, {date:newDate, start:newStart, duration:occ.duration});
    return;
  }
  const alts = findAlternativeSlots(newDate, occ.duration, excludeId, 2);
  showConflictModal(occ.title, occ.category, newStart, occ.duration, conflicts, alts, {
    onSaveAnyway: ()=> commitOccurrenceChange(occ, {date:newDate, start:newStart, duration:occ.duration}),
    onAlt: (altStart)=> commitOccurrenceChange(occ, {date:newDate, start:altStart, duration:occ.duration}),
    onCancel: ()=> renderWeek()
  });
}

function finalizeEventResize(occ, newDuration){
  if(newDuration === occ.duration){ renderWeek(); return; }
  const excludeId = occ.isRecurring ? occ._anchorId : occ.id;
  const conflicts = findConflicts(occ.date, occ.start, newDuration, excludeId);
  if(conflicts.length === 0){
    commitOccurrenceChange(occ, {date:occ.date, start:occ.start, duration:newDuration});
    return;
  }
  const alts = findAlternativeSlots(occ.date, newDuration, excludeId, 2);
  showConflictModal(occ.title, occ.category, occ.start, newDuration, conflicts, alts, {
    onSaveAnyway: ()=> commitOccurrenceChange(occ, {date:occ.date, start:occ.start, duration:newDuration}),
    onAlt: (altStart)=> commitOccurrenceChange(occ, {date:occ.date, start:altStart, duration:newDuration}),
    onCancel: ()=> renderWeek()
  });
}

function commitOccurrenceChange(occ, changes){
  const isResizeOnly = changes.date === occ.date && changes.start === occ.start && changes.duration !== occ.duration;
  const toastMsg = isResizeOnly ? `Event resized to ${formatDuration(changes.duration)}` : `Event moved to ${fmt12(changes.start)}`;
  if(occ.isRecurring){
    setRecurOverride(occ.id, {skipped:true});
    const newEv = { id:uid(), title:occ.title, date:changes.date, start:changes.start, duration:changes.duration, category:occ.category, flex:occ.flex, done:false, subtasks:occ.subtasks||[] };
    events.push(newEv);
    saveEvents(events);
    renderAll();
    showUndoToast(toastMsg, ()=>{
      clearRecurOverride(occ.id);
      removeEventById(newEv.id);
      saveEvents(events);
      renderAll();
    });
  } else {
    const ev = events.find(e=>e.id===occ.id);
    if(!ev){ renderWeek(); return; }
    const old = { date: ev.date, start: ev.start, duration: ev.duration };
    ev.date = changes.date; ev.start = changes.start; ev.duration = changes.duration;
    saveEvents(events);
    renderAll();
    showUndoToast(toastMsg, ()=>{
      const e2 = events.find(e=>e.id===ev.id);
      if(e2){ e2.date = old.date; e2.start = old.start; e2.duration = old.duration; }
      saveEvents(events);
      renderAll();
    });
  }
}

/* =========================================================
   RENDER EVERYTHING (called after any data change)
   ========================================================= */
export function renderAll(){
  renderToday();
  renderWeek();
  // Month/Year are heavier (they scan many days) — only refresh them when
  // actually visible; the nav tab handler re-renders on switching into them.
  if(document.getElementById('view-month').classList.contains('active')) renderMonth();
  if(document.getElementById('view-year').classList.contains('active')) renderYear();
}

/* =========================================================
   GREETING + DATE
   ========================================================= */
export function renderGreeting(){
  const now = new Date();
  const h = now.getHours();
  let text = 'Good evening 🌙';
  if(h < 12) text = 'Good morning 👋';
  else if(h < 18) text = 'Good afternoon ☀️';
  document.getElementById('greetingText').textContent = text;
  document.getElementById('dateLine').textContent =
    now.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'});
}

/* =========================================================
   MONTH VIEW
   ========================================================= */
let monthCursor = new Date(); // any date within the displayed month
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const WEEKDAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function renderMonthWeekdayHeader(){
  const el = document.getElementById('monthWeekdays');
  el.innerHTML = weekdayDisplayOrder().map(d=>`<span>${WEEKDAY_SHORT[d]}</span>`).join('');
}

export function renderMonth(){
  const y = monthCursor.getFullYear(), m = monthCursor.getMonth();
  document.getElementById('monthTitle').textContent = `${MONTH_NAMES[m]} ${y}`;
  const grid = document.getElementById('monthGrid');
  grid.innerHTML = '';

  const firstOfMonth = new Date(y, m, 1);
  const offset = weekStartOffset();
  const startOffset = (firstOfMonth.getDay() - offset + 7) % 7;
  const gridStart = addDays(firstOfMonth, -startOffset);
  const todayStr = fmtDate(new Date());
  renderMonthWeekdayHeader();

  for(let i=0;i<42;i++){
    const d = addDays(gridStart, i);
    const dateStr = fmtDate(d);
    const inMonth = d.getMonth() === m;
    const dayEvents = eventsForDate(dateStr);
    const special = specialDayFor(dateStr);
    const cell = document.createElement('div');
    cell.className = 'month-day' + (inMonth?'':' outside') + (dateStr===todayStr?' is-today':'');
    const uniqueCats = [...new Set(dayEvents.map(e=>e.category))].slice(0,5);
    cell.innerHTML = `
      <div class="num"><span>${d.getDate()}</span>${special?'<span class="star">★</span>':''}</div>
      ${special?`<span class="special-tag">${escapeHtml(special.title)}</span>`:''}
      <div class="dots">${uniqueCats.map(c=>{
        const meta = catMeta(c);
        return `<span class="dot" style="background:var(${meta.solid})"></span>`;
      }).join('')}</div>
    `;
    cell.onclick = ()=> openDayModal(dateStr);
    grid.appendChild(cell);
  }
}
document.getElementById('monthPrev').onclick = ()=>{ monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth()-1, 1); renderMonth(); };
document.getElementById('monthNext').onclick = ()=>{ monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth()+1, 1); renderMonth(); };
document.getElementById('monthToday').onclick = ()=>{ monthCursor = new Date(); renderMonth(); };

/* =========================================================
   YEAR VIEW
   ========================================================= */
let yearCursor = new Date().getFullYear();

export function computeYearStats(year){
  let totalMin=0, doneMin=0, doneCount=0, totalCount=0;
  const catMin = {};
  const monthTotals = new Array(12).fill(0);
  for(let m=0;m<12;m++){
    const daysInMonth = new Date(year, m+1, 0).getDate();
    for(let d=1; d<=daysInMonth; d++){
      const dateStr = `${year}-${pad(m+1)}-${pad(d)}`;
      eventsForDate(dateStr).forEach(e=>{
        totalMin += e.duration; totalCount++;
        monthTotals[m] += e.duration;
        catMin[e.category] = (catMin[e.category]||0) + e.duration;
        if(e.done){ doneMin += e.duration; doneCount++; }
      });
    }
  }
  const maxMonthTotal = Math.max(1, ...monthTotals);
  const busiestMonthIdx = monthTotals.indexOf(maxMonthTotal);
  const topCategory = Object.keys(catMin).sort((a,b)=>catMin[b]-catMin[a])[0] || null;
  return { totalMin, doneMin, doneCount, totalCount, monthTotals, maxMonthTotal, busiestMonthIdx, topCategory };
}

function renderYearStats(year){
  const wrap = document.getElementById('yearStats');
  const stats = computeYearStats(year);
  if(stats.totalCount === 0){
    wrap.innerHTML = `<div class="empty-slot" style="margin-bottom:18px;">No events yet in ${year}.</div>`;
    return;
  }
  const completionPct = stats.totalMin > 0 ? Math.round((stats.doneMin/stats.totalMin)*100) : 0;
  const topMeta = stats.topCategory ? catMeta(stats.topCategory) : null;
  wrap.innerHTML = `
    <div class="year-stats-grid">
      <div class="year-stat-card">
        <div class="year-stat-value">${formatDuration(stats.totalMin)}</div>
        <div class="year-stat-label">Scheduled this year</div>
      </div>
      <div class="year-stat-card">
        <div class="year-stat-value">${completionPct}%</div>
        <div class="year-stat-label">Completed</div>
      </div>
      <div class="year-stat-card">
        <div class="year-stat-value">${MONTH_NAMES[stats.busiestMonthIdx]}</div>
        <div class="year-stat-label">Busiest month</div>
      </div>
      <div class="year-stat-card">
        <div class="year-stat-value">${topMeta ? topMeta.icon+' '+stats.topCategory : '—'}</div>
        <div class="year-stat-label">Most common category</div>
      </div>
    </div>
    <div class="year-activity-row">
      ${stats.monthTotals.map((m,i)=>{
        const h = Math.max(3, Math.round((m/stats.maxMonthTotal)*36));
        return `<div class="year-activity-bar" title="${MONTH_NAMES[i]}: ${formatDuration(m)}">
          <div class="year-activity-fill" style="height:${h}px;"></div>
          <span>${MONTH_NAMES[i].slice(0,1)}</span>
        </div>`;
      }).join('')}
    </div>
  `;
}

export function renderYear(){
  document.getElementById('yearTitle').textContent = yearCursor;
  renderYearStats(yearCursor);
  const grid = document.getElementById('yearGrid');
  grid.innerHTML = '';
  const todayStr = fmtDate(new Date());

  for(let m=0;m<12;m++){
    const box = document.createElement('div');
    box.className = 'mini-month';
    const firstOfMonth = new Date(yearCursor, m, 1);
    const daysInMonth = new Date(yearCursor, m+1, 0).getDate();
    const startOffset = (firstOfMonth.getDay() - weekStartOffset() + 7) % 7;

    let cellsHtml = '';
    for(let i=0;i<startOffset;i++) cellsHtml += `<div class="mini-cell empty"></div>`;
    for(let day=1; day<=daysInMonth; day++){
      const dateStr = `${yearCursor}-${pad(m+1)}-${pad(day)}`;
      const special = specialDayFor(dateStr);
      const cls = ['mini-cell'];
      if(dateStr===todayStr) cls.push('is-today');
      if(special) cls.push('has-special');
      cellsHtml += `<div class="${cls.join(' ')}" data-date="${dateStr}" title="${special?escapeHtml(special.title):''}">${day}</div>`;
    }
    box.innerHTML = `<h3>${MONTH_NAMES[m]}</h3><div class="mini-grid">${cellsHtml}</div>`;
    box.querySelectorAll('.mini-cell:not(.empty)').forEach(c=>{
      c.onclick = ()=> openDayModal(c.dataset.date);
    });
    grid.appendChild(box);
  }
}
document.getElementById('yearPrev').onclick = ()=>{ yearCursor--; renderYear(); };
document.getElementById('yearNext').onclick = ()=>{ yearCursor++; renderYear(); };
