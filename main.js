const { app, BrowserWindow, ipcMain } = require("electron");

const {
  setCookies,
  setTk,
  setQQ,
  setAuthExpired,
} = require("./qqCore");
const { bkn } = require("./qzoneApi");
require("./ipcMain.js");
const path = require("node:path");

let loginWindow;
let mainWindow;
let loginPromise = null;

const mainURL =
  process.env.NODE_ENV === "development"
    ? "http://localhost:8080"
    : `./web/index.html`;

const QQURL =
  "https://xui.ptlogin2.qq.com/cgi-bin/xlogin?proxy_url=https%3A//qzs.qq.com/qzone/v6/portal/proxy.html&daid=5&&hide_title_bar=1&low_login=0&qlogin_auto_login=1&no_verifyimg=1&link_target=blank&appid=549000912&style=22&target=self&s_url=https%3A%2F%2Fqzs.qq.com%2Fqzone%2Fv5%2Floginsucc.html%3Fpara%3Dizone&pt_qr_app=%E6%89%8B%E6%9C%BAQQ%E7%A9%BA%E9%97%B4&pt_qr_link=https%3A//z.qzone.com/download.html&self_regurl=https%3A//qzs.qq.com/qzone/v6/reg/index.html&pt_qr_help_link=https%3A//z.qzone.com/download.html&pt_no_auth=0";

function createMainWindow() {
  mainWindow = new BrowserWindow({
    height: 600,
    useContentSize: true,
    width: 800,
    title: "控制中心",
    autoHideMenuBar: true,
    webPreferences: {
      devTools: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL(mainURL);
  } else {
    mainWindow.loadFile(mainURL);
  }

  mainWindow.on("closed", function () {
    mainWindow = null;
  });
}

/**
 * 打开 Qzone 登录窗并等待登录完成。
 * @param {{openMain?: boolean}} options 登录成功后是否打开主窗口
 * @returns {Promise<boolean>} 是否成功拿到登录态（uin + p_skey）
 */
function openLoginWindow(options = {}) {
  const { openMain = false } = options;
  if (loginWindow) {
    loginWindow.focus();
    return loginPromise || Promise.resolve(false);
  }

  loginWindow = new BrowserWindow({
    height: 500,
    useContentSize: true,
    width: 400,
    title: "登录QQ账号",
    autoHideMenuBar: true,
    webPreferences: {
      devTools: true,
    },
  });

  loginPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      loginPromise = null;
      resolve(ok);
    };

    loginWindow.webContents.on("dom-ready", async () => {
      const currentURL = loginWindow ? loginWindow.webContents.getURL() : "";
      if (currentURL.indexOf("https://user.qzone.qq.com/") === -1) {
        return;
      }
      try {
        const cookies = await loginWindow.webContents.session.cookies.get({
          url: currentURL,
        });
        const pSkey = cookies.find((cookie) => cookie.name == "p_skey");
        const pUin = cookies.find((cookie) => cookie.name == "p_uin");
        const uin = (pUin && pUin.value.match(/[1-9][0-9]*/) || [""])[0];
        if (!pSkey || !uin) {
          console.log("[login] 缺少 p_skey 或 p_uin，登录未完成");
          finish(false);
          return;
        }
        setCookies(
          cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; ")
        );
        setTk(bkn(pSkey.value));
        setQQ(uin);
        setAuthExpired(false);

        // On Linux (GTK), a native dialog.showMessageBox attached to loginWindow
        // followed by loginWindow.destroy() triggers a gsignal use-after-free
        // that segfaults the main process. Keep the window switch dialog-free.
        const win = loginWindow;
        loginWindow = null;
        if (openMain && !mainWindow) {
          createMainWindow();
        }
        // 先 resolve，避免 destroy() 触发的 closed 事件把结果覆盖成 false
        finish(true);
        win.destroy();
      } catch (error) {
        console.log("[login] 读取 Cookie 失败:", error);
        finish(false);
      }
    });

    loginWindow.on("closed", function () {
      loginWindow = null;
      finish(false);
    });
  });

  loginWindow.loadURL(QQURL);
  return loginPromise;
}

ipcMain.handle("relogin", async () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
  return openLoginWindow({ openMain: false });
});

app.whenReady().then(() => {
  openLoginWindow({ openMain: true });
});

app.on("window-all-closed", function () {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", function () {
  if (loginWindow === null && mainWindow == null) {
    openLoginWindow({ openMain: true });
  }
});
