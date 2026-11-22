const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, data) => cb(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('buddy', {
  onState: on('state'),
  onPoke: on('poke'),
  onPokeResult: on('poke-result'),
  onSelfAlert: on('self-alert'),
  onRemind: on('remind'),
  onPomodoro: on('pomodoro-event'),
  onJournalEvent: on('journal-event'),
  onJournalChanged: on('journal-changed'),
  poke: (text) => ipcRenderer.invoke('poke', text),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore', ignore),
  dragPet: (phase) => ipcRenderer.send('pet:drag', phase),
  scalePet: (dir) => ipcRenderer.send('pet:scale', dir),
  petMenu: () => ipcRenderer.send('pet:menu'),
  remindNext: (minutes) => ipcRenderer.send('remind:next', minutes),
  resumePomodoro: () => ipcRenderer.send('pomodoro:resume'),
  restMorePomodoro: () => ipcRenderer.send('pomodoro:rest'),
  stopPomodoro: () => ipcRenderer.send('pomodoro:stop'),
  startPomodoro: () => ipcRenderer.send('pomodoro:start'),
  skipPomodoro: () => ipcRenderer.send('pomodoro:skip'),
  openSettings: () => ipcRenderer.send('open-settings'),
  togglePause: () => ipcRenderer.send('toggle-pause'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (c) => ipcRenderer.invoke('config:save', c),
  defaultRules: () => ipcRenderer.invoke('config:resetRules'),
  openJournal: (mode) => ipcRenderer.send('journal:open', mode),
  getJournal: (date) => ipcRenderer.invoke('journal:get', date),
  saveJournal: (kind, journal) => ipcRenderer.invoke('journal:save', kind, journal),
  snoozeJournal: () => ipcRenderer.invoke('journal:snooze'),
  journalHistory: () => ipcRenderer.invoke('journal:history'),
  openStats: (who, cat) => ipcRenderer.send('stats:open', { who, cat }),
  // 面板
  onPanelGo: on('panel-go'),
  openPanel: (page) => ipcRenderer.send('panel:open', page),
  statsDay: (date) => ipcRenderer.invoke('stats:day', date),
  statsWeek: (date) => ipcRenderer.invoke('stats:week', date),
  setPetScale: (scale) => ipcRenderer.send('pet:set-scale', scale),
  setPetView: (view) => ipcRenderer.send('pet:set-view', view),
  setPetSkin: (skin) => ipcRenderer.send('pet:set-skin', skin),
  checkUpdate: () => ipcRenderer.send('update:check'),
});
