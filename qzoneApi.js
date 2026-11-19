/**
 * Qzone 群相册接口封装（纯函数 + 可注入 http 客户端，便于单测）。
 *
 * 只依赖调用方传入的 http（axios 实例/兼容对象），不 require electron。
 */
const ALBUM_LIST_URL =
  "https://h5.qzone.qq.com/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/qun_list_album_v2";
const PHOTO_LIST_URL = "https://h5.qzone.qq.com/groupphoto/inqq";

const ERROR_TEXT = {
  NOT_LOGIN: "登录已失效，请重新登录",
  NO_PERMISSION: "无访问权限（账号不在群内或被限制）",
  RATE_LIMIT: "请求过于频繁，请稍后再试",
  NETWORK: "网络错误，请检查网络后重试",
  PARSE: "接口返回数据异常",
  UNKNOWN: "未知错误",
};

class QzoneError extends Error {
  constructor(code, message, ret) {
    super(message || ERROR_TEXT[code] || ERROR_TEXT.UNKNOWN);
    this.name = "QzoneError";
    this.code = code || "UNKNOWN";
    this.ret = ret;
  }
}

/** Qzone 经典 bkn：hash*33 + charCode，取 31 位。 */
function bkn(pSkey) {
  let hash = 5381;
  const str = String(pSkey == null ? "" : pSkey);
  for (let i = 0; i < str.length; i++) {
    hash += (hash << 5) + str.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

function normalizeUrl(url) {
  if (!url) return "";
  let u = String(url).trim();
  if (u.startsWith("//")) u = "https:" + u;
  else if (u.startsWith("http://")) u = "https://" + u.slice(7);
  return u;
}

/** 兼容 JSONP（shine2_Callback(...)）与纯 JSON。 */
function parseJsonText(text) {
  const raw = String(text == null ? "" : text).trim();
  const m = /^shine2_Callback\s*\(([\s\S]*)\)\s*;?\s*$/.exec(raw);
  return JSON.parse(m ? m[1] : raw);
}

function retToCode(ret) {
  const n = Number(ret);
  if (n === -3000 || n === -3001) return "NOT_LOGIN";
  return "UNKNOWN";
}

function normalizeError(err) {
  if (err instanceof QzoneError) {
    return {
      status: "error",
      code: err.code,
      ret: err.ret,
      msg: err.message || ERROR_TEXT[err.code] || ERROR_TEXT.UNKNOWN,
    };
  }
  const status = err && err.response ? err.response.status : undefined;
  if (status === 403) {
    return { status: "error", code: "NO_PERMISSION", msg: ERROR_TEXT.NO_PERMISSION };
  }
  if (status === 429) {
    return { status: "error", code: "RATE_LIMIT", msg: ERROR_TEXT.RATE_LIMIT };
  }
  if (status !== undefined) {
    return {
      status: "error",
      code: "NETWORK",
      msg: `${ERROR_TEXT.NETWORK}（HTTP ${status}）`,
    };
  }
  return {
    status: "error",
    code: "NETWORK",
    msg: (err && err.message) || ERROR_TEXT.NETWORK,
  };
}

/** 相册列表：返回 { albums:[{id,title,num}], attachInfo, hasMore }。 */
function parseAlbumList(text) {
  const raw = String(text == null ? "" : text);
  if (raw.indexOf("对不起，您") !== -1) {
    throw new QzoneError("NO_PERMISSION");
  }
  let payload;
  try {
    payload = parseJsonText(raw);
  } catch (e) {
    throw new QzoneError("PARSE");
  }
  const ret = payload.ret !== undefined ? payload.ret : payload.code;
  if (ret !== undefined && Number(ret) !== 0) {
    const code = retToCode(ret);
    throw new QzoneError(code, payload.msg || ERROR_TEXT[code], ret);
  }
  const data = payload.data || {};
  const rawAlbums = Array.isArray(data.album) ? data.album : [];
  const albums = rawAlbums
    .map((item) => ({
      id: String(item.id),
      title: item.title || String(item.id),
      num: Number(item.photocnt) || 0,
    }))
    .filter((item) => item.num != 0); // 空相册无内容可下，保持原有行为
  return {
    albums,
    rawCount: rawAlbums.length,
    attachInfo: data.attach_info || null,
    hasMore: data.hasmore !== undefined ? !!data.hasmore : false,
  };
}

function photoEntries(photourl) {
  if (Array.isArray(photourl)) return photourl.filter(Boolean);
  if (photourl && typeof photourl === "object") {
    return Object.keys(photourl)
      .map((k) => photourl[k])
      .filter(Boolean);
  }
  return [];
}

/**
 * 从一条 photolist 记录里选原图/视频/文件名。
 * - origin_size 为真（或缺失）时优先 0x0 原图；
 * - 否则按 width/height/enlarge_rate 取最大；
 * - 兼容 photourl 为 dict 或数组。
 */
function pickPhoto(item) {
  if (!item || typeof item !== "object") return null;
  const valid = photoEntries(item.photourl)
    .filter((e) => e && e.url)
    .map((e) => ({
      url: e.url,
      width: Number(e.width) || 0,
      height: Number(e.height) || 0,
      enlarge: Number(e.enlarge_rate) || 0,
    }));
  if (!valid.length) return null;

  const zero = valid.find((e) => e.width === 0 && e.height === 0);
  const originAvailable =
    item.origin_size === undefined || item.origin_size === null
      ? true
      : !!item.origin_size;

  let chosen;
  if (originAvailable && zero) {
    chosen = zero;
  } else {
    chosen = valid
      .slice()
      .sort(
        (a, b) =>
          b.width - a.width || b.height - a.height || b.enlarge - a.enlarge
      )[0];
  }

  const videoUrl = normalizeUrl(
    (item.videodata && item.videodata.actionurl) || item.videourl || ""
  );

  return {
    photoURL: normalizeUrl(chosen.url),
    videoURL: videoUrl || undefined,
    name: String(item.sloc || item.lloc || ""),
    hasVideoFlag: !!item.videoflag,
  };
}

/** 照片列表响应：返回 { list, attachInfo, hasMore }。 */
function parsePhotoPage(body) {
  let payload = body;
  if (typeof payload === "string") {
    try {
      payload = parseJsonText(payload);
    } catch (e) {
      throw new QzoneError("PARSE");
    }
  }
  if (!payload || typeof payload !== "object") {
    throw new QzoneError("PARSE");
  }
  const ret = payload.ret !== undefined ? payload.ret : payload.code;
  if (ret !== undefined && Number(ret) !== 0) {
    const code = retToCode(ret);
    throw new QzoneError(code, payload.msg || ERROR_TEXT[code], ret);
  }
  const data = payload.data || {};
  const rawList = Array.isArray(data.photolist) ? data.photolist : [];
  const list = rawList.map(pickPhoto).filter(Boolean);
  return {
    list,
    attachInfo: data.attach_info || null,
    hasMore: data.hasmore !== undefined ? !!data.hasmore : true,
  };
}

/**
 * 计算下一页游标：
 * - 服务端给了 attach_info 就原样使用（start 不变）；
 * - 否则退回 start_count，按实际返回条数前进（兜底 40）。
 */
function advanceCursor({ attachInfo, start, received, fallbackStep = 40 }) {
  if (attachInfo) {
    return { cursor: attachInfo, start };
  }
  return {
    cursor: null,
    start: start + (Number(received) || fallbackStep),
  };
}

/** 表单体：统一用 URLSearchParams（避免手工 %3D 与多余引号）。 */
function buildPhotoForm(opts) {
  const params = new URLSearchParams({
    qunId: String(opts.qunid),
    albumId: String(opts.albumid),
    uin: String(opts.uin),
    start: String(opts.start || 0),
    num: String(opts.num || 36),
    getCommentCnt: "0",
    getMemberRole: "0",
    hostUin: String(opts.uin),
    getalbum: "0",
    platform: "qzone",
    inCharset: "utf-8",
    outCharset: "utf-8",
    source: "qzone",
    cmd: "qunGetPhotoList",
    qunid: String(opts.qunid),
    albumid: String(opts.albumid),
    refresh_type: String(opts.refreshType || 1),
    attach_info: opts.attachInfo || `start_count=${opts.start || 0}`,
  });
  return params.toString();
}

async function fetchAlbumList(http, opts) {
  const params = new URLSearchParams({
    g_tk: String(opts.gtk),
    callback: "shine2_Callback",
    callbackFun: "shine2",
    qunId: String(opts.qunid),
    uin: String(opts.uin),
    start: String(opts.start || 0),
    num: String(opts.num || 1000),
    getMemberRole: "1",
    inCharset: "utf-8",
    outCharset: "utf-8",
    source: "qzone",
    attach_info: opts.attachInfo || "",
  });
  const res = await http.get(`${ALBUM_LIST_URL}?${params.toString()}`, {
    headers: { Cookie: opts.cookie },
    timeout: 30000,
  });
  return parseAlbumList(res.data);
}

async function fetchPhotoPage(http, opts) {
  const form = buildPhotoForm(opts);
  const url = `${PHOTO_LIST_URL}?g_tk=${encodeURIComponent(opts.gtk)}`;
  const res = await http.post(url, form, {
    headers: {
      Cookie: opts.cookie,
      "Referrer-Policy": "strict-origin-when-cross-origin",
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    },
    timeout: 30000,
  });
  return parsePhotoPage(res.data);
}

module.exports = {
  ALBUM_LIST_URL,
  PHOTO_LIST_URL,
  ERROR_TEXT,
  QzoneError,
  bkn,
  normalizeUrl,
  parseJsonText,
  parseAlbumList,
  parsePhotoPage,
  pickPhoto,
  buildPhotoForm,
  advanceCursor,
  normalizeError,
  fetchAlbumList,
  fetchPhotoPage,
};
