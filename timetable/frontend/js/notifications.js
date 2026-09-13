// =========================================================
// notifications.js — browser Notification permission handling
// and the reminder-firing loop (falls back to an in-app toast
// when the Notification API is unavailable/denied).
// =========================================================
import { safeJSONParse, safeGetItem, safeSetItem, fmt12, fmtDate, toMinutes } from './utils.js';
import { eventsForDate } from './recurrence.js';
import { showToast } from './ui.js';

export function updateNotifStatus(){
  const el = document.getElementById('notifStatus');
  if(!('Notification' in window)){ el.textContent = 'Not supported in this browser'; return; }
  const map = { granted:'Enabled', denied:'Blocked — enable in browser settings', default:'Not enabled yet' };
  el.textContent = map[Notification.permission] || '';
}
document.getElementById('enableNotifsBtn').onclick = ()=>{
  if(!('Notification' in window)){ showToast('This browser does not support notifications'); return; }
  Notification.requestPermission().then(()=> updateNotifStatus());
};

const REMINDER_FIRED_KEY = 'timetable_reminders_fired_v1';
export { REMINDER_FIRED_KEY };
function loadFiredReminders(){
  return safeJSONParse(safeGetItem(REMINDER_FIRED_KEY), {}) || {};
}
function saveFiredReminders(o){ safeSetItem(REMINDER_FIRED_KEY, JSON.stringify(o)); }
let firedReminders = loadFiredReminders();

function fireReminder(e){
  if('Notification' in window && Notification.permission === 'granted'){
    try{
      new Notification(`Upcoming: ${e.title}`, { body: `Starts at ${fmt12(e.start)}` });
      return;
    } catch(err){ /* fall through to toast */ }
  }
  showToast(`⏰ ${e.title} starts at ${fmt12(e.start)}`);
}

export function checkReminders(){
  const todayStr = fmtDate(new Date());
  const nowMin = new Date().getHours()*60 + new Date().getMinutes();
  eventsForDate(todayStr).forEach(e=>{
    if(!e.reminder || e.reminder === 'none' || e.done) return;
    const leadMin = parseInt(e.reminder, 10);
    if(isNaN(leadMin)) return;
    const startMin = toMinutes(e.start);
    const triggerMin = startMin - leadMin;
    const key = e.id + '@' + todayStr;
    if(firedReminders[key]) return;
    if(nowMin >= triggerMin && nowMin < startMin){
      fireReminder(e);
      firedReminders[key] = true;
      saveFiredReminders(firedReminders);
    }
  });
}
setInterval(checkReminders, 30000);
