// =========================================================
// import.js — importing schedules from a spreadsheet (weekly
// grid layout) and restoring a full JSON backup. Handles all
// parsing/validation; the actual writes go through state.js.
// =========================================================
import { toMinutes, toHHMM, uid, fmt12, catMeta, escapeHtml, nextDateForWeekday } from './utils.js';
import { events, prefs, specialDays, saveEvents, setEvents, addEvents, savePrefs, setPrefs, loadPrefs, setSpecialDays, saveSpecialDays } from './state.js';
import { setRecurOverridesAll } from './recurrence.js';
import { findConflicts } from './scheduler.js';
import { renderAll } from './calendar.js';
import { showToast, openConfirm, openModal, closeModal, renderPrefsForm, OB_DAY_LABEL } from './ui.js';

/* =========================================================
   FULL BACKUP RESTORE (JSON)
   ========================================================= */
function importBackupFile(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    let data;
    try{ data = JSON.parse(e.target.result); }
    catch(err){ showToast('Could not read that file — is it a valid backup JSON?'); return; }
    if(!data || !Array.isArray(data.events)){
      showToast('That file does not look like a valid Timetable backup');
      return;
    }
    openConfirm(
      'Restore this backup?',
      `This replaces your current events, preferences, and special days with the contents of "${file.name}". Export your current data first if you want to keep it. This can't be undone.`,
      ()=>{
        setEvents(data.events || []);
        setPrefs(Object.assign(loadPrefs(), data.prefs || {}));
        setSpecialDays(data.specialDays || []);
        setRecurOverridesAll(data.recurOverrides || {}); // saves internally
        saveEvents(events); savePrefs(prefs); saveSpecialDays(specialDays);
        renderAll(); renderPrefsForm();
        showToast('Backup restored');
      }
    );
  };
  reader.readAsText(file);
}

document.getElementById('importBackupBtn').onclick = ()=> document.getElementById('backupFileInput').click();
document.getElementById('backupFileInput').onchange = (e)=>{
  const file = e.target.files[0];
  e.target.value = '';
  if(file) importBackupFile(file);
};

/* =========================================================
   SPREADSHEET IMPORT (weekly grid layout)
   ========================================================= */
const WEEKDAY_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

document.getElementById('attachBtn').onclick = ()=> document.getElementById('fileInput').click();
document.getElementById('fileInput').onchange = (e)=>{
  const file = e.target.files[0];
  e.target.value = '';
  if(file) handleFileUpload(file);
};

function handleFileUpload(file){
  const name = file.name.toLowerCase();
  if(name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')){
    showToast(`Reading ${file.name}…`);
    readSpreadsheet(file);
  } else if(name.endsWith('.pdf') || file.type.startsWith('image/')){
    showToast(`${file.name} attached — image/PDF reading needs the AI connection, which isn't wired up yet. Spreadsheets (.xlsx/.csv) work today.`);
  } else {
    showToast('Unsupported file type — try a .xlsx, .csv, image, or PDF.');
  }
}

function readSpreadsheet(file){
  if(typeof XLSX === 'undefined'){ showToast('Spreadsheet reader failed to load — check your connection and try again'); return; }
  const reader = new FileReader();
  const isCsv = file.name.toLowerCase().endsWith('.csv');
  reader.onload = (e)=>{
    try{
      const wb = isCsv
        ? XLSX.read(e.target.result, {type:'string'})
        : XLSX.read(e.target.result, {type:'array'});
      let found = null;
      for(const sheetName of wb.SheetNames){
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {header:1, defval:null, raw:false});
        const parsed = parseWeeklySheet(rows);
        if(parsed && parsed.length){ found = parsed; break; }
      }
      if(!found){
        showToast('Could not find a weekly grid (weekday columns) in that file.');
        return;
      }
      openImportModal(file.name, found);
    } catch(err){
      showToast('Could not read that file — is it a valid spreadsheet?');
    }
  };
  if(isCsv) reader.readAsText(file);
  else reader.readAsArrayBuffer(file);
}

function parseTimeRange(text){
  const matches = [...String(text).matchAll(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/gi)]
    .filter(m => m[0].trim() !== '' && (m[2]!==undefined || m[3]));
  if(matches.length < 2) return null;
  let h1 = parseInt(matches[0][1],10), m1 = matches[0][2]?parseInt(matches[0][2],10):0, mer1 = matches[0][3]?matches[0][3].toUpperCase():null;
  let h2 = parseInt(matches[1][1],10), m2 = matches[1][2]?parseInt(matches[1][2],10):0, mer2 = matches[1][3]?matches[1][3].toUpperCase():null;
  if(!mer1 && mer2) mer1 = mer2;
  if(!mer2 && mer1) mer2 = mer1;
  if(!mer1){ mer1 = 'AM'; mer2 = 'AM'; }
  const to24 = (h,mer)=>{ let hh = h%12; if(mer==='PM') hh += 12; return hh; };
  let startMin = to24(h1,mer1)*60 + m1;
  let endMin = to24(h2,mer2)*60 + m2;
  if(endMin <= startMin) endMin += 24*60;
  const duration = Math.max(15, endMin - startMin);
  return { start: toHHMM(startMin), duration };
}

function guessCategoryFromText(text){
  const t = text.toLowerCase();
  if(/workout|exercise|gym|active rest|stretch|run\b|sport/.test(t)) return 'Exercise';
  if(/study|revis|homework|exam|concours/.test(t)) return 'Study';
  if(/business|work\b|meeting|client|sourcing|listing|marketing|orders/.test(t)) return 'Work';
  if(/shop|groc|errand/.test(t)) return 'Shopping';
  if(/free time|free evening|hobby|hobbies|relax/.test(t)) return 'Free time';
  return 'Other';
}

function parseWeeklySheet(rows){
  if(!rows || !rows.length) return null;
  let headerRowIdx = -1;
  const dayCols = {};
  for(let r=0;r<rows.length;r++){
    const row = rows[r] || [];
    const matches = {};
    row.forEach((cell,c)=>{
      if(typeof cell === 'string'){
        const idx = WEEKDAY_FULL.findIndex(d => cell.trim().toLowerCase() === d.toLowerCase());
        if(idx !== -1) matches[c] = idx;
      }
    });
    if(Object.keys(matches).length >= 3){ headerRowIdx = r; Object.assign(dayCols, matches); break; }
  }
  if(headerRowIdx === -1) return null;

  const headerRow = rows[headerRowIdx] || [];
  const dayColIdx = Object.keys(dayCols).map(Number);
  const timeColIdx = 0;
  let notesColIdx = null;
  headerRow.forEach((cell,c)=>{
    if(typeof cell === 'string' && /notes|goals/i.test(cell) && !dayColIdx.includes(c)) notesColIdx = c;
  });

  const suggestions = [];
  for(let r=headerRowIdx+1; r<rows.length; r++){
    const row = rows[r];
    if(!row) continue;
    const timeCell = row[timeColIdx];
    if(!timeCell || typeof timeCell !== 'string') continue;
    const times = parseTimeRange(timeCell);
    if(!times) continue;
    const notes = notesColIdx!==null ? row[notesColIdx] : null;

    dayColIdx.forEach(c=>{
      const raw = row[c];
      if(!raw || typeof raw !== 'string') return;
      const cleanTitle = raw.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]/gu,'').trim();
      if(!cleanTitle) return;
      const dow = dayCols[c];
      suggestions.push({
        included:true,
        category: guessCategoryFromText(cleanTitle),
        title: cleanTitle,
        date: nextDateForWeekday(dow),
        start: times.start,
        duration: times.duration,
        dayLabel: OB_DAY_LABEL[dow],
        subtasks: (notes && typeof notes==='string') ? [{id:uid(), label:'Notes', detail:notes}] : []
      });
    });
  }
  return suggestions;
}

/* ---------- Import preview modal ---------- */
let importSuggestions = [];
const importModalBackdrop = document.getElementById('importModalBackdrop');
const DAY_ORDER = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function isDuplicateEvent(s){
  return events.some(e => e.date===s.date && e.start===s.start && e.title.trim().toLowerCase()===s.title.trim().toLowerCase());
}

function openImportModal(fileName, suggestions){
  suggestions.forEach(s=>{
    s.isDuplicate = isDuplicateEvent(s);
    s.conflicts = findConflicts(s.date, s.start, s.duration, null);
    if(s.isDuplicate) s.included = false;
  });
  importSuggestions = suggestions;
  document.getElementById('importModalTitle').textContent = `Import from ${fileName}`;
  updateImportSummary();
  renderImportSuggestions();
  openModal(importModalBackdrop);
}

function updateImportSummary(){
  const total = importSuggestions.length;
  const selected = importSuggestions.filter(s=>s.included).length;
  const dupes = importSuggestions.filter(s=>s.isDuplicate).length;
  document.getElementById('importModalSub').textContent =
    `Found ${total} scheduled block${total===1?'':'s'} — ${selected} will be imported` +
    (dupes ? `, ${dupes} skipped as likely duplicate${dupes===1?'':'s'}.` : '.');
}

function renderImportSuggestions(){
  const wrap = document.getElementById('importSuggestions');
  if(importSuggestions.length === 0){
    wrap.innerHTML = `<div class="subtask-empty">Nothing recognizable found.</div>`;
    return;
  }
  const byDay = {};
  importSuggestions.forEach((s,i)=>{ s._idx = i; (byDay[s.dayLabel] = byDay[s.dayLabel] || []).push(s); });
  wrap.innerHTML = DAY_ORDER.filter(d=>byDay[d]).map(day=>{
    const items = byDay[day].slice().sort((a,b)=> toMinutes(a.start)-toMinutes(b.start));
    return `<div class="ob-cat-group">
      <div class="ob-cat-title">${day}</div>
      ${items.map(s=>{
        const meta = catMeta(s.category);
        let badge = '';
        if(s.isDuplicate) badge = '<span class="badge" style="background:color-mix(in srgb, var(--ink-dim) 25%, transparent);color:var(--ink-dim);margin-left:6px;">Duplicate</span>';
        else if(s.conflicts && s.conflicts.length) badge = '<span class="badge fixed" style="margin-left:6px;">Conflict</span>';
        return `<label class="ob-suggestion-row" style="--cat-bg:var(${meta.bg});--cat-ink:var(${meta.ink});">
          <input type="checkbox" data-imp-idx="${s._idx}" ${s.included?'checked':''}>
          <span class="ob-s-text">${meta.icon} <b>${fmt12(s.start)}</b> — ${escapeHtml(s.title)} (${s.duration} min)${badge}</span>
        </label>`;
      }).join('')}
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-imp-idx]').forEach(cb=>{
    cb.onchange = ()=>{
      importSuggestions[cb.dataset.impIdx].included = cb.checked;
      updateImportSummary();
    };
  });
}

document.getElementById('importCancel').onclick = ()=> closeModal(importModalBackdrop);
document.getElementById('importApply').onclick = ()=>{
  const toAdd = importSuggestions.filter(s=>s.included).map(s=>({
    id:uid(), title:s.title, date:s.date, start:s.start, duration:s.duration,
    category:s.category, flex:'flexible', done:false, subtasks:s.subtasks||[]
  }));
  if(toAdd.length){
    addEvents(toAdd);
    saveEvents(events);
    renderAll();
  }
  closeModal(importModalBackdrop);
  showToast(toAdd.length ? `Imported ${toAdd.length} events` : 'Nothing selected');
};
