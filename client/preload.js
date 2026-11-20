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
  onJournalEvent: on('journal-event'),
  onJournalChanged: on('journal-changed'),
  poke: (text) => ipcRenderer.invoke('poke', text),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore', ignore),
  dragPet: (phase) => ipcRenderer.send('pet:drag', phase),
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
  getStats: () => ipcRenderer.invoke('stats:get'),
  onStatsSelect: on('stats-select'),
});
