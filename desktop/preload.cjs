const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("takeThreeDesktop", {
  connect: async (config, onDeviceCode) => {
    const listener = (_event, code) => onDeviceCode?.(code);
    if (onDeviceCode) ipcRenderer.on("cloud:device-code", listener);
    try {
      return await ipcRenderer.invoke("cloud:connect", config);
    } finally {
      if (onDeviceCode) ipcRenderer.removeListener("cloud:device-code", listener);
    }
  },
});
