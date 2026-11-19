const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../qzoneApi");

const albumJsonp =
  'shine2_Callback({"code":0,"data":{"album":[' +
  '{"id":"a1","title":"相册1","photocnt":12},' +
  '{"id":"a2","title":"空相册","photocnt":0}' +
  '],"attach_info":"cursor-1","hasmore":1}});';

test("bkn matches Qzone g_tk algorithm", () => {
  assert.equal(api.bkn("abc"), 193485963);
  assert.equal(api.bkn(""), 5381);
});

test("parseAlbumList parses JSONP and filters empty albums", () => {
  const data = api.parseAlbumList(albumJsonp);
  assert.deepEqual(data.albums, [{ id: "a1", title: "相册1", num: 12 }]);
  assert.equal(data.attachInfo, "cursor-1");
  assert.equal(data.hasMore, true);
});

test("parseAlbumList accepts plain JSON", () => {
  const data = api.parseAlbumList(
    JSON.stringify({ code: 0, data: { album: [{ id: 7, photocnt: 3 }] } })
  );
  assert.deepEqual(data.albums, [{ id: "7", title: "7", num: 3 }]);
  assert.equal(data.attachInfo, null);
  assert.equal(data.hasMore, false);
});

test("parseAlbumList maps permission text and ret codes", () => {
  assert.throws(
    () => api.parseAlbumList("<html>对不起，您没有访问权限</html>"),
    (err) => err.code === "NO_PERMISSION"
  );
  assert.throws(
    () => api.parseAlbumList('shine2_Callback({"ret":-3000,"msg":""})'),
    (err) => err.code === "NOT_LOGIN"
  );
  assert.throws(
    () => api.parseAlbumList("not-json"),
    (err) => err.code === "PARSE"
  );
});

test("pickPhoto prefers original when origin_size is set", () => {
  const item = {
    sloc: "s1",
    origin_size: 1,
    photourl: {
      0: { url: "//m.qpic.cn/origin.jpg", width: 0, height: 0 },
      1: { url: "http://m.qpic.cn/big.jpg", width: 1600, height: 900 },
    },
    videodata: { actionurl: "" },
  };
  const picked = api.pickPhoto(item);
  assert.equal(picked.photoURL, "https://m.qpic.cn/origin.jpg");
  assert.equal(picked.videoURL, undefined);
  assert.equal(picked.name, "s1");
});

test("pickPhoto falls back to largest when no original", () => {
  const item = {
    sloc: "s2",
    origin_size: 0,
    photourl: {
      0: { url: "http://m.qpic.cn/zero.jpg", width: 0, height: 0 },
      1: { url: "http://m.qpic.cn/small.jpg", width: 640, height: 480 },
      2: { url: "http://m.qpic.cn/large.jpg", width: 1920, height: 1080 },
    },
  };
  assert.equal(
    api.pickPhoto(item).photoURL,
    "https://m.qpic.cn/large.jpg"
  );
});

test("pickPhoto supports array photourl and video fallback", () => {
  const picked = api.pickPhoto({
    lloc: "l1",
    photourl: [{ url: "//x/big.jpg", width: 800, height: 600 }],
    videodata: { actionurl: "//v/clip.mp4" },
  });
  assert.equal(picked.photoURL, "https://x/big.jpg");
  assert.equal(picked.videoURL, "https://v/clip.mp4");
  assert.equal(picked.name, "l1");
});

test("pickPhoto returns null without a usable url", () => {
  assert.equal(api.pickPhoto({ sloc: "x", photourl: {} }), null);
  assert.equal(api.pickPhoto(null), null);
});

test("parsePhotoPage maps list/cursor/hasmore", () => {
  const data = api.parsePhotoPage({
    ret: 0,
    data: {
      photolist: [
        {
          sloc: "p1",
          origin_size: 1,
          photourl: { 0: { url: "//o/1.jpg", width: 0, height: 0 } },
        },
      ],
      attach_info: "next-cursor",
      hasmore: 1,
    },
  });
  assert.equal(data.list.length, 1);
  assert.equal(data.list[0].photoURL, "https://o/1.jpg");
  assert.equal(data.attachInfo, "next-cursor");
  assert.equal(data.hasMore, true);
});

test("parsePhotoPage maps -3000/-3001 to NOT_LOGIN", () => {
  for (const ret of [-3000, -3001]) {
    assert.throws(
      () => api.parsePhotoPage({ ret, msg: "" }),
      (err) => err.code === "NOT_LOGIN"
    );
  }
});

test("buildPhotoForm has no stray quotes and encodes attach_info once", () => {
  const body = api.buildPhotoForm({
    qunid: "123",
    albumid: "a1",
    uin: "456",
    start: 0,
    attachInfo: "start_count=0",
    refreshType: 2,
  });
  assert.equal(body.startsWith('"'), false);
  assert.equal(body.endsWith('"'), false);
  assert.match(body, /(^|&)qunId=123(&|$)/);
  assert.match(body, /(^|&)qunid=123(&|$)/);
  assert.match(body, /(^|&)attach_info=start_count%3D0(&|$)/);
  assert.match(body, /(^|&)refresh_type=2(&|$)/);
});

test("fetchAlbumList passes expected params and cookie", async () => {
  let captured;
  const http = {
    get: async (url, options) => {
      captured = { url, options };
      return { data: albumJsonp };
    },
  };
  const result = await api.fetchAlbumList(http, {
    cookie: "uin=o1",
    uin: "1",
    gtk: 2,
    qunid: "3",
    start: 0,
  });
  assert.equal(result.albums.length, 1);
  assert.match(captured.url, /qunId=3/);
  assert.match(captured.url, /callback=shine2_Callback/);
  assert.equal(captured.options.headers.Cookie, "uin=o1");
});

test("fetchPhotoPage posts a clean form", async () => {
  let captured;
  const http = {
    post: async (url, body, options) => {
      captured = { url, body, options };
      return { data: { ret: 0, data: { photolist: [], hasmore: 0 } } };
    },
  };
  const result = await api.fetchPhotoPage(http, {
    cookie: "uin=o1",
    uin: "1",
    gtk: 2,
    qunid: "3",
    albumid: "a1",
    start: 40,
    attachInfo: "cursor",
    refreshType: 2,
  });
  assert.equal(result.hasMore, false);
  assert.equal(captured.body.startsWith('"'), false);
  assert.match(captured.body, /(^|&)attach_info=cursor(&|$)/);
  assert.match(captured.body, /(^|&)cmd=qunGetPhotoList(&|$)/);
  assert.equal(captured.options.headers["x-requested-with"], "XMLHttpRequest");
});

test("advanceCursor prefers server cursor and falls back to page size", () => {
  assert.deepEqual(
    api.advanceCursor({ attachInfo: "next", start: 0, received: 36 }),
    { cursor: "next", start: 0 }
  );
  assert.deepEqual(
    api.advanceCursor({ attachInfo: null, start: 0, received: 36 }),
    { cursor: null, start: 36 }
  );
  assert.deepEqual(
    api.advanceCursor({ attachInfo: "", start: 40, received: 0 }),
    { cursor: null, start: 80 }
  );
});

test("normalizeError classifies http and network failures", () => {
  assert.equal(
    api.normalizeError({ response: { status: 403 } }).code,
    "NO_PERMISSION"
  );
  assert.equal(
    api.normalizeError({ response: { status: 500 } }).code,
    "NETWORK"
  );
  assert.equal(api.normalizeError(new Error("timeout")).code, "NETWORK");
  assert.equal(
    api.normalizeError(new api.QzoneError("PARSE")).code,
    "PARSE"
  );
});
