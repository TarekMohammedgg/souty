const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  transcribeAudio: (params) => ipcRenderer.invoke('transcribe-audio', params),
  getSettings: () => ipcRenderer.invoke('get-app-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-app-settings', settings),
  onSettingsChanged: (callback) => {
    ipcRenderer.on('settings-changed', (_event, settings) => callback(settings));
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    add: (item) => ipcRenderer.invoke('history:add', item),
    delete: (id) => ipcRenderer.invoke('history:delete', id),
    clear: () => ipcRenderer.invoke('history:clear'),
    import: (items) => ipcRenderer.invoke('history:import', items),
    onChanged: (callback) => ipcRenderer.on('history-changed', () => callback())
  }
});
