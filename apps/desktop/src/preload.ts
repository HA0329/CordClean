/**
 * Electron preload：把 IPC 能力以最小接口暴露给界面。
 *
 * 界面通过 `window.cordclean` 使用它，从而与浏览器外壳下的 WebSocket
 * 传输层保持完全一致的调用方式（见 packages/ui/src/api/client.ts）。
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('cordclean', {
  platform: process.platform,
  invoke: (method: string, params: unknown) => ipcRenderer.invoke('cordclean:invoke', method, params),
  onEvent: (listener: (event: string, payload: unknown) => void) => {
    const handler = (_event: unknown, event: string, payload: unknown) => listener(event, payload)
    ipcRenderer.on('cordclean:event', handler as any)
    return () => ipcRenderer.removeListener('cordclean:event', handler as any)
  },
})
