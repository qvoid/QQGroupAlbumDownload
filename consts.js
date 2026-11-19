const TaskStatus = {
  WATING: "wating",
  RUN: "run",
  FINISH: "finish",
  ERROR: "error",
  PAUSE: "pause",
};

const TaskStatusText = {
  [TaskStatus.WATING]: "等待",
  [TaskStatus.RUN]: "运行",
  [TaskStatus.FINISH]: "完成",
  [TaskStatus.ERROR]: "错误",
  [TaskStatus.PAUSE]: "暂停",
};

const ErrorCodeText = {
  NOT_LOGIN: "登录失效",
  NO_PERMISSION: "无权限",
  RATE_LIMIT: "请求过于频繁",
  NETWORK: "网络错误",
  PARSE: "数据解析失败",
  UNKNOWN: "未知错误",
};

exports.TaskStatus = TaskStatus;
exports.TaskStatusText = TaskStatusText;
exports.ErrorCodeText = ErrorCodeText;
