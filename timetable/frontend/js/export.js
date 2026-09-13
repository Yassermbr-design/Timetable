// =========================================================
// export.js — CSV / Excel / PDF / ICS export and full JSON
// backup. Excel and PDF rely on the two CDN scripts (XLSX,
// jsPDF) loaded from index.html; both are guarded in case
// that script failed to load (offline, blocked, etc.).
// =========================================================
import { toMinutes, toHHMM, fmtDate, addDays, pad, fmt12, niceDate } from './utils.js';
import { events, prefs, specialDays } from './state.js';
import { recurOverrides } from './recurrence.js';
import { showToast } from './ui.js';

function downloadFile(filename, content, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}

function exportableRows(){
  return events.slice()
    .sort((a,b)=> a.date===b.date ? toMinutes(a.start)-toMinutes(b.start) : a.date.localeCompare(b.date))
    .map(e=>({
      Title: e.title, Date: e.date, Start: e.start, 'Duration (min)': e.duration,
      Category: e.category, Flexibility: e.flex,
      Recurrence: e.recurrence ? e.recurrence.type : 'none',
      Done: e.done ? 'Yes' : 'No'
    }));
}

export function exportCSV(){
  const rows = exportableRows();
  if(rows.length === 0){ showToast('No events to export'); return; }
  const header = Object.keys(rows[0]);
  const esc = v => `"${String(v).replace(/"/g,'""')}"`;
  const lines = [header.map(esc).join(','), ...rows.map(r=>header.map(h=>esc(r[h])).join(','))];
  downloadFile('timetable-export.csv', lines.join('\r\n'), 'text/csv');
  showToast('CSV exported');
}

export function exportExcel(){
  if(typeof XLSX === 'undefined'){ showToast('Excel export failed to load — check your connection and try again'); return; }
  const rows = exportableRows();
  if(rows.length === 0){ showToast('No events to export'); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Schedule');
  XLSX.writeFile(wb, 'timetable-export.xlsx');
  showToast('Excel file exported');
}

export function exportPDF(){
  if(events.length === 0){ showToast('No events to export'); return; }
  if(!window.jspdf){ showToast('PDF export failed to load — check your connection and try again'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const grouped = {};
  events.slice()
    .sort((a,b)=> a.date===b.date ? toMinutes(a.start)-toMinutes(b.start) : a.date.localeCompare(b.date))
    .forEach(e=>{ (grouped[e.date] = grouped[e.date] || []).push(e); });

  let y = 18;
  doc.setFontSize(16);
  doc.text('My Schedule', 14, y);
  y += 10;
  doc.setFontSize(10);

  Object.keys(grouped).sort().forEach(date=>{
    if(y > 280){ doc.addPage(); y = 18; }
    doc.setFont(undefined, 'bold');
    doc.text(niceDate(date), 14, y);
    y += 6;
    doc.setFont(undefined, 'normal');
    grouped[date].forEach(e=>{
      if(y > 280){ doc.addPage(); y = 18; }
      const line = `${fmt12(e.start)} - ${e.title} (${e.category}, ${e.duration} min)${e.recurrence && e.recurrence.type!=='none' ? ' [recurring]' : ''}`;
      doc.text(line, 18, y);
      y += 6;
    });
    y += 4;
  });
  doc.save('timetable-export.pdf');
  showToast('PDF exported');
}

const ICS_DAY_MAP = ['SU','MO','TU','WE','TH','FR','SA'];
function toICSDateTime(dateStr, timeStr){
  const [y,m,d] = dateStr.split('-');
  const [hh,mm] = timeStr.split(':');
  return `${y}${m}${d}T${hh}${mm}00`;
}
function icsEscape(text){
  return String(text).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
}
function buildRRule(recurrence, anchorDateStr){
  if(!recurrence || recurrence.type==='none') return null;
  if(recurrence.type==='daily') return 'FREQ=DAILY';
  if(recurrence.type==='weekdays') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  if(recurrence.type==='weekly'){
    const days = (recurrence.days && recurrence.days.length) ? recurrence.days : [new Date(anchorDateStr+'T00:00:00').getDay()];
    return 'FREQ=WEEKLY;BYDAY=' + days.map(d=>ICS_DAY_MAP[d]).join(',');
  }
  if(recurrence.type==='monthly') return 'FREQ=MONTHLY';
  return null;
}
function generateICS(){
  const now = new Date();
  const stamp = toICSDateTime(fmtDate(now), pad(now.getHours())+':'+pad(now.getMinutes())) + 'Z';
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Timetable//EN','CALSCALE:GREGORIAN'];

  events.forEach(e=>{
    const endMin = toMinutes(e.start) + e.duration;
    const endDate = endMin >= 1440 ? fmtDate(addDays(new Date(e.date+'T00:00:00'), Math.floor(endMin/1440))) : e.date;
    lines.push('BEGIN:VEVENT');
    lines.push('UID:'+e.id+'@timetable');
    lines.push('DTSTAMP:'+stamp);
    lines.push('DTSTART:'+toICSDateTime(e.date, e.start));
    lines.push('DTEND:'+toICSDateTime(endDate, toHHMM(((endMin%1440)+1440)%1440)));
    lines.push('SUMMARY:'+icsEscape(e.title));
    lines.push('CATEGORIES:'+icsEscape(e.category));
    if(e.subtasks && e.subtasks.length){
      lines.push('DESCRIPTION:'+icsEscape(e.subtasks.map(s=>`${s.label}${s.detail?': '+s.detail:''}`).join('\n')));
    }
    const rrule = buildRRule(e.recurrence, e.date);
    if(rrule) lines.push('RRULE:'+rrule);
    lines.push('END:VEVENT');
  });

  specialDays.forEach(s=>{
    const [y,m,d] = s.date.split('-');
    lines.push('BEGIN:VEVENT');
    lines.push('UID:special-'+s.id+'@timetable');
    lines.push('DTSTAMP:'+stamp);
    lines.push('DTSTART;VALUE=DATE:'+y+m+d);
    lines.push('SUMMARY:'+icsEscape(s.title)+' ('+s.type+')');
    if(s.recurring) lines.push('RRULE:FREQ=YEARLY');
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
export function exportICS(){
  if(events.length === 0 && specialDays.length === 0){ showToast('Nothing to export yet'); return; }
  downloadFile('timetable.ics', generateICS(), 'text/calendar');
  showToast('ICS file exported — import it into Google/Apple/Outlook Calendar');
}

document.getElementById('exportCsvBtn').onclick = exportCSV;
document.getElementById('exportExcelBtn').onclick = exportExcel;
document.getElementById('exportPdfBtn').onclick = exportPDF;
document.getElementById('exportIcsBtn').onclick = exportICS;

/* =========================================================
   FULL BACKUP / RESTORE (JSON) — everything needed to
   reconstruct the schedule: events, prefs, special days,
   subtasks (nested in events), and recurrence rules/overrides.
   ========================================================= */
export function exportBackup(){
  const backup = {
    app: 'timetable', version: 1, exportedAt: new Date().toISOString(),
    events, prefs, specialDays, recurOverrides
  };
  downloadFile('timetable-backup.json', JSON.stringify(backup, null, 2), 'application/json');
  showToast('Backup exported');
}
document.getElementById('exportBackupBtn').onclick = exportBackup;
