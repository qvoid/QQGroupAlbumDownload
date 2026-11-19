const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const axiosStub = {
  get: async () => {
    throw new Error("not implemented");
  },
  post: async () => {
    throw new Error("not implemented");
  },
};

// ipcMain.js 依赖 electron 与已登录的 axios；单测里替换掉这两者
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return { ipcMain: { handle: () => undefined }, dialog: {}, shell: {} };
  }
  if (request === "axios") {
    return { default: axiosStub };
  }
  return originalLoad.call(this, request, ...rest);
};
const qqCore = require("../qqCore");
const ipc = require("../ipcMain");
Module._load = originalLoad;

function login() {
  qqCore.clear();
  qqCore.setCookies("uin=o1; p_skey=abc");
  qqCore.setQQ("1");
  qqCore.setTk(2);
}

test("getPatchAlbum maps -3000 to NOT_LOGIN and flags auth", async () => {
  login();
  axiosStub.post = async () => ({ data: { ret: -3000, msg: "" } });
  const result = await ipc.getPatchAlbum("1", "a1", {});
  assert.equal(result.status, "error");
  assert.equal(result.code, "NOT_LOGIN");
  assert.equal(qqCore.isAuthExpired(), true);
});

test("getPatchAlbum returns list/cursor/hasmore on success", async () => {
  login();
  axiosStub.post = async () => ({
    data: {
      ret: 0,
      data: {
        photolist: [
          {
            sloc: "p1",
            origin_size: 1,
            photourl: { 0: { url: "//x/1.jpg", width: 0, height: 0 } },
          },
        ],
        attach_info: "cursor-2",
        hasmore: 1,
      },
    },
  });
  const result = await ipc.getPatchAlbum("1", "a1", {
    start: 0,
    refreshType: 1,
  });
  assert.equal(result.status, "success");
  assert.equal(result.list.length, 1);
  assert.equal(result.list[0].photoURL, "https://x/1.jpg");
  assert.equal(result.attachInfo, "cursor-2");
  assert.equal(result.hasMore, true);
  assert.equal(qqCore.isAuthExpired(), false);
});

test("getAlbumList returns albums from JSONP", async () => {
  login();
  axiosStub.get = async () => ({
    data:
      'shine2_Callback({"code":0,"data":{"album":[{"id":"a1","title":"相册","photocnt":2}]}});',
  });
  const result = await ipc.getAlbumList(null, "123");
  assert.equal(result.status, "success");
  assert.deepEqual(result.data, [{ id: "a1", title: "相册", num: 2 }]);
});

test("getAlbumList reports permission errors", async () => {
  login();
  axiosStub.get = async () => ({ data: "对不起，您没有权限" });
  const result = await ipc.getAlbumList(null, "123");
  assert.equal(result.status, "error");
  assert.equal(result.code, "NO_PERMISSION");
});
