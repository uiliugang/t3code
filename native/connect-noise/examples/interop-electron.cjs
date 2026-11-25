const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  void window.loadURL("about:blank");
});
