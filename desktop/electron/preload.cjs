const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', { platform: process.platform, request: payload => ipcRenderer.invoke('backend:request', payload), openSource: url => ipcRenderer.invoke('source:open', url) });
