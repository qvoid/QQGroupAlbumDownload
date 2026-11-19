const { default: axios } = require("axios");
const { ipcMain, dialog, shell } = require("electron");
const fsExtra = require("fs-extra");
const path = require("path");
const { TaskStatus, ErrorCodeText } = require("./consts");
const {
  getCookies,
  getQQ,
  getTk,
  isAuthExpired,
  setAuthExpired,
} = require("./qqCore");
const CryptoJS = require("crypto-js");
const qzone = require("./qzoneApi");

function getMD5FirstSixChars(input) {
  // 计算 MD5 哈希值
  const hash = CryptoJS.MD5(input).toString(CryptoJS.enc.Hex);

  // 取前六位字符
  const firstSixChars = hash.substring(0, 6);

  return firstSixChars;
}

function qzoneOptions() {
  return {
    cookie: getCookies(),
    uin: getQQ(),
    gtk: getTk(),
  };
}

async function getAlbumList(event, qunId) {
  try {
    const opts = qzoneOptions();
    const albums = [];
    let start = 0;
    let attachInfo = "";
    let hasMore = true;
    // 正常一次返回；只有服务端给出 attach_info/hasmore 时才继续翻页
    for (let page = 0; page < 20 && hasMore; page++) {
      const data = await qzone.fetchAlbumList(axios, {
        ...opts,
        qunid: qunId,
        attachInfo,
        start,
        num: 1000,
      });
      albums.push(...data.albums);
      start += data.rawCount;
      setAuthExpired(false);
      if (!data.attachInfo || !data.hasMore) break;
      attachInfo = data.attachInfo;
    }
    console.log(`getAlbumList qunId=${qunId} fetched ${albums.length} albums`);
    return { status: "success", data: albums };
  } catch (error) {
    const normalized = qzone.normalizeError(error);
    if (normalized.code === "NOT_LOGIN") setAuthExpired(true);
    console.log("getAlbumList error:", normalized);
    return normalized;
  }
}

/**
 * 取一页照片。
 * @param {object} opts { attachInfo, start, refreshType }
 * @returns {Promise<{status:'success', list:any[], attachInfo:string|null, hasMore:boolean}
 *   | {status:'error', code:string, msg:string, ret?:number}>}
 */
async function getPatchAlbum(qunId, albumId, opts = {}) {
  try {
    const data = await qzone.fetchPhotoPage(axios, {
      ...qzoneOptions(),
      qunid: qunId,
      albumid: albumId,
      start: opts.start || 0,
      attachInfo: opts.attachInfo || "",
      refreshType: opts.refreshType || 1,
      num: 36,
    });
    setAuthExpired(false);
    return { status: "success", ...data };
  } catch (error) {
    const normalized = qzone.normalizeError(error);
    if (normalized.code === "NOT_LOGIN") setAuthExpired(true);
    console.log("getPatchAlbum error:", normalized);
    return normalized;
  }
}

let globalQueue;

let download = async () => undefined;
function downloadFactory(userDir) {
  return async function (url, albumDirName, name) {
    name = filterFileName(name);
    let albumName = sanitizeFileName(albumDirName);
    if (albumName.length == 0) {
      albumName = generateAlbumName(albumDirName);
    }
    const baseDir = path.join(userDir, "./" + albumName + "/");
    const fileName = path.join(userDir, "./" + albumName + "/" + name);
    await fsExtra.mkdirp(baseDir);
    const exists = await fsExtra.pathExists(fileName).catch(() => false);
    if (exists) {
      return; // 已存在即跳过，天然支持中断后重跑
    }
    await downloadWithRetry(url, fileName);
  };
}

const RETRY_DELAYS = [1000, 3000, 7000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadWithRetry(url, dest, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      await downloadOnce(url, dest);
      return;
    } catch (error) {
      lastError = error;
      console.log(`download failed (${i + 1}/${attempts}): ${url}`, error.message);
      if (i < attempts - 1) {
        await sleep(RETRY_DELAYS[i] || RETRY_DELAYS[RETRY_DELAYS.length - 1]);
      }
    }
  }
  await fsExtra.remove(dest + ".part").catch(() => undefined);
  throw lastError;
}

async function downloadOnce(url, dest) {
  const part = dest + ".part";
  await fsExtra.remove(part).catch(() => undefined);
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 60000,
  });
  const stream = response.data;
  const fileStream = fsExtra.createWriteStream(part, {
    highWaterMark: 1000,
  });
  await new Promise((resolve, reject) => {
    let timer;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stream.destroy();
        fileStream.destroy();
        reject(new Error("download stalled"));
      }, 30000);
    };
    resetTimer();
    stream.on("data", resetTimer);
    stream.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    fileStream.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    fileStream.on("finish", () => {
      clearTimeout(timer);
      resolve();
    });
    stream.pipe(fileStream);
  });
  await fsExtra.rename(part, dest);
}

async function createDownloadAlbum(event, qunId, arr) {
  await globalQueue?.pause();
  globalQueue = new queue();
  for (let index = 0; index < arr.length; index++) {
    const item = arr[index];
    globalQueue.addTask(new AlbumTask(qunId, item.id, item.num, item.title));
  }
  return true;
}
async function startDownloadAlbum() {
  const showDialog = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  if (showDialog.filePaths.length == 0) {
    return false;
  }
  download = downloadFactory(showDialog.filePaths[0]);
  globalQueue?.run();
}

async function stopDownloadAlbum(event, id) {
  await globalQueue?.pause(id);
}
async function resumeDownloadAlbum(event, id) {
  if (id === undefined && !isAuthExpired() && globalQueue) {
    globalQueue.retryAuthFailed();
  }
  await globalQueue?.resume(id);
}
function openPage(event, url) {
  shell.openExternal(url);
}
async function deleteDownloadAlbum(event, id) {
  if (id !== undefined) {
    await globalQueue?.delete(id);
  } else {
    await globalQueue?.deleteAll();
    globalQueue = undefined;
  }
}
async function getDownloadAlbumStatus() {
  return globalQueue?.getAllStatus() ?? [];
}
ipcMain?.handle("getAlbumList", getAlbumList);
ipcMain?.handle("createDownloadAlbum", createDownloadAlbum);
ipcMain?.handle("startDownloadAlbum", startDownloadAlbum);
ipcMain?.handle("stopDownloadAlbum", stopDownloadAlbum);
ipcMain?.handle("resumeDownloadAlbum", resumeDownloadAlbum);
ipcMain?.handle("openPage", openPage);
ipcMain?.handle("deleteDownloadAlbum", deleteDownloadAlbum);
ipcMain?.handle("getDownloadAlbumStatus", getDownloadAlbumStatus);
exports.getAlbumList = getAlbumList;
exports.getPatchAlbum = getPatchAlbum;
const sanitizeFileName = (fileName) => {
  return fileName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "");
};
const filterFileName = (name) => {
  return (String(name).match(/[0-9a-zA-Z/.]*/g) || []).join("");
};
const generateAlbumName = (albumDirName) => {
  const randomString = getMD5FirstSixChars(albumDirName);
  // 返回【相册下载】+ 6 个随机字符
  return `相册下载${randomString}`;
};

// 这部分涉及到下载功能
// 第一次首先考虑的是能限制数量并且顺序下载
// 更新后改成并发
// 但是涉及到任务的暂停，删除
// 之前的循环执行不适合
// 那么第一反应是分为一个完成数组，运行数组，等待数组
// 但是这样设计，暂停的任务再继续，需要更换不同数组
// 颠倒了用户顺序，而用户顺序是不能变的，就推翻了之前我们的设想
// 这个时候就考虑到一个显示的用户数组
// 一个进行下载的队列数组
// 所以设计了一个任务队列，一个运行队列，而用户的信息从taskList获取
// 监听子任务run的结束然后回调运行下一个子任务
// 如果用then反复暂停继续会多次监听，所以多封装一层callback
// 确保每个task的run函数只回调一次

class queue {
  taskList = []; //用户插入任务的顺序，具体的执行顺序由waiQueue和runList控制
  flag = ""; // pause 暂停 run 运行中
  maxRun = 2;
  runList = [];
  waitQueue = [];
  addTask(item) {
    this.taskList.push(item);
    this.waitQueue.push(item);
  }
  async delete(id) {
    //删除列表内容
    const itemIndex = this.taskList.findIndex(
      (item) => item.getSingleID() == id
    );
    if (itemIndex != -1) {
      this.taskList.splice(itemIndex, 1);
    }
    //如果在运行，需要暂停再删除  如果在等待，可以直接删除
    const runIndex = this.runList.findIndex((item) => item.getSingleID() == id);
    if (runIndex != -1) {
      await this.runList[runIndex].pause();
      this.runList.splice(runIndex, 1);
    } else {
      const waitIndex = this.waitQueue.findIndex(
        (item) => item.getSingleID() == id
      );
      if (waitIndex != -1) {
        this.waitQueue.splice(waitIndex, 1);
      }
    }
  }
  async deleteAll() {
    await this.pause();
    this.taskList.length = 0;
    this.runList.length = 0;
    this.waitQueue.length = 0;
  }
  async pause(id) {
    if (id == undefined) {
      //全局暂停
      this.flag = "pause";
    }
    const list = [];
    const addList = (item) => {
      list.push(item.pause());
    };
    for (let index = 0; index < this.runList.length; index++) {
      if (id == undefined) {
        addList(this.runList[index]);
      } else if (id === this.runList[index].getSingleID()) {
        addList(this.runList[index]);
      }
    }
    return Promise.all(list);
  }
  async resume(id) {
    if (id == undefined) {
      for (const item of this.runList) {
        item.resume();
      }
      this.run();
    } else {
      const index = this.taskList.findIndex((item) => item.getSingleID() == id);
      if (index !== -1) {
        this.taskList[index].resume();
        this.waitQueue.unshift(this.taskList[index]);
        this.run();
      }
    }
  }
  async runTask(index) {
    if (this.runList[index].isRun()) {
      return;
    }
    const id = this.runList[index].getSingleID();
    this.runList[index].registerRun(() => {
      if (this.flag == "run") {
        //队列运行中，且执行过任务才可以执行下一个任务
        const itemIndex = this.runList.findIndex(
          (item) => item.getSingleID() == id
        );
        //需要继续运行，删除队列进行处理
        if (itemIndex !== -1) {
          this.runList.splice(itemIndex, 1);
        }
        process.nextTick(() => {
          this.run();
        });
      }
    });
  }
  async run() {
    // 登录态已失效时不再继续派发任务（等待 UI 重新登录后 resume）
    if (isAuthExpired()) {
      this.flag = "pause";
      return;
    }
    this.flag = "run";
    while (this.runList.length < this.maxRun && this.waitQueue.length !== 0) {
      const item = this.waitQueue.shift();
      this.runList.push(item);
    }
    for (let index = 0; index < this.runList.length; index++) {
      this.runTask(index);
    }
  }
  retryAuthFailed() {
    for (const item of this.taskList) {
      if (
        item.runStatus === TaskStatus.ERROR &&
        item.errorCode === "NOT_LOGIN" &&
        !this.waitQueue.includes(item)
      ) {
        item.resetAuthError();
        this.waitQueue.push(item);
      }
    }
  }
  getAllStatus() {
    const list = [];
    for (const item of this.taskList) {
      const data = item.getStatus();
      list.push(data);
    }
    return list;
  }
}
class AlbumTask {
  list = [];
  qunId;
  albumId;
  start = 0;
  cursor = null;
  refreshType = 1;
  hasMore = true;
  runStatus = TaskStatus.WATING;
  // wating 等待中 run 运行中 pause暂停中 finish完成 error 错误
  // 等待中->运行中
  // 运行中->暂停中/完成/错误
  // 暂停中->等待中
  waitResolve = undefined;
  success = 0;
  fail = 0;
  total = 0;
  title = "";
  errorCode = null;
  runCallback = undefined;
  constructor(qunId, albumId, total, title) {
    this.qunId = qunId;
    this.albumId = albumId;
    this.total = total;
    this.title = title;
  }
  getSingleID() {
    return this.albumId;
  }

  async nextPage() {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (isAuthExpired()) {
        this.errorCode = "NOT_LOGIN";
        this.list = [];
        this.hasMore = false;
        this.runStatus = TaskStatus.ERROR;
        return;
      }
      const data = await getPatchAlbum(this.qunId, this.albumId, {
        attachInfo: this.cursor,
        start: this.start,
        refreshType: this.refreshType,
      });
      if (data.status == "success") {
        this.errorCode = null;
        this.refreshType = 2;
        const prevCursor = this.cursor;
        const next = qzone.advanceCursor({
          attachInfo: data.attachInfo,
          start: this.start,
          received: data.list.length,
        });
        this.cursor = next.cursor;
        this.start = next.start;
        // 游标没有前进（服务端重复返回同一页）时主动停止，避免死循环
        const cursorStuck =
          !!prevCursor && !!this.cursor && prevCursor === this.cursor;
        this.hasMore =
          data.list.length > 0 && data.hasMore !== false && !cursorStuck;
        this.list = data.list;
        return;
      }
      this.errorCode = data.code;
      if (data.code === "NOT_LOGIN" || data.code === "NO_PERMISSION") {
        this.list = [];
        this.hasMore = false;
        this.runStatus = TaskStatus.ERROR;
        return;
      }
      if (attempt < 2) {
        await sleep(500 * (attempt + 1));
      }
    }
    this.list = [];
    this.hasMore = false;
    this.runStatus = TaskStatus.ERROR;
  }
  isRun() {
    return this.runStatus == TaskStatus.RUN;
  }
  resetAuthError() {
    this.errorCode = null;
    this.runStatus = TaskStatus.WATING;
    this.hasMore = true;
    this.list = [];
  }
  async pause() {
    return new Promise((resolve) => {
      if (this.runStatus != TaskStatus.RUN) {
        resolve();
      } else {
        this.runStatus = TaskStatus.PAUSE;
        this.waitResolve = resolve;
      }
    });
  }
  async resume() {
    if (this.runStatus == TaskStatus.PAUSE) {
      this.runStatus = TaskStatus.WATING;
    }
  }
  async registerRun(callback) {
    this.runCallback = callback;
    await this.run();
    if (this.runCallback) {
      this.runCallback();
      this.runCallback = undefined;
    }
  }
  async run() {
    if (this.runStatus != TaskStatus.WATING) {
      return false;
    }
    this.runStatus = TaskStatus.RUN;
    if (isAuthExpired()) {
      this.errorCode = "NOT_LOGIN";
      this.runStatus = TaskStatus.ERROR;
      return true;
    }
    while (this.runStatus == TaskStatus.RUN) {
      if (this.list.length === 0) {
        if (!this.hasMore) {
          break;
        }
        await this.nextPage();
        if (this.list.length === 0) {
          break;
        }
        continue;
      }
      const item = this.list.pop();
      try {
        await download(item.photoURL, this.title, item.name + ".jpg");
        if (item.videoURL) {
          await download(item.videoURL, this.title, item.name + ".mp4");
        }
        this.success++;
      } catch (error) {
        this.fail++;
      }
      //离开状态
      if (this.runStatus != TaskStatus.RUN) {
        break;
      }
    }
    if (this.runStatus === TaskStatus.PAUSE) {
      // 回调暂停
      this.waitResolve && this.waitResolve();
      this.waitResolve = undefined;
    } else if (this.runStatus == TaskStatus.RUN) {
      // 回调完成
      this.runStatus = TaskStatus.FINISH;
    }
    return true;
  }
  getStatus() {
    const codeText = this.errorCode
      ? ErrorCodeText[this.errorCode] || this.errorCode
      : "";
    let showText = "";
    if (this.success == 0 && this.fail == 0) {
      showText = codeText || "无执行内容";
    } else {
      showText = codeText
        ? `${codeText}（成功:${this.success} 失败:${this.fail}）`
        : `成功:${this.success} 失败:${this.fail}`;
    }
    return {
      id: this.albumId,
      num: this.total,
      fail: this.fail,
      success: this.success,
      status: this.runStatus,
      code: this.errorCode,
      title: this.title,
      showText: showText,
    };
  }
}
