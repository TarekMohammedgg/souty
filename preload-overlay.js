const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  transcribeAudio: (params) => ipcRenderer.invoke('transcribe-audio', params),
  getSettings: () => ipcRenderer.invoke('get-app-settings'),
  setMode: (mode) => ipcRenderer.invoke('set-mode', mode),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  autoPaste: (text) => ipcRenderer.send('trigger-auto-paste', text),
  addHistory: (item) => ipcRenderer.invoke('history:add', item),
  onStartRecord: (callback) => {
    ipcRenderer.on('start-overlay-recording', () => callback());
  },
  onStopRecord: (callback) => {
    ipcRenderer.on('stop-overlay-recording', () => callback());
  },
  onCancelRecord: (callback) => {
    ipcRenderer.on('cancel-overlay-recording', () => callback());
  }
});
