function createDisplayMediaHandler({ desktopCapturer, dialog, isAppUrl }) {
  return async (request, callback) => {
    if (!isAppUrl(request.securityOrigin) || !request.frame || !request.videoRequested) {
      callback(null);
      return;
    }

    let selection;
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (sources.length === 0) {
        await dialog.showMessageBox({
          type: "warning",
          message: "No screens or windows are available to record.",
          detail: "Check Screen Recording access for Take Three in macOS Privacy & Security settings.",
        });
      } else {
        const { response } = await dialog.showMessageBox({
          type: "question",
          message: "Choose a screen or window to record",
          buttons: [...sources.map((source) => source.name), "Cancel"],
          cancelId: sources.length,
          noLink: true,
        });
        if (response < sources.length) selection = { video: sources[response] };
      }
    } catch (error) {
      console.error("Could not select a screen or window:", error);
      dialog.showErrorBox("Screen capture unavailable", String(error));
    }
    callback(selection || null);
  };
}

module.exports = { createDisplayMediaHandler };
