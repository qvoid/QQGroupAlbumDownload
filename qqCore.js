let cookieStr = "";
let tk = "";
let qq = "";
let authExpired = false;
exports.setTk = (value) => {
  tk = value;
};
exports.setQQ = (value) => {
  qq = value;
};
exports.setCookies = (value) => {
  cookieStr = value;
};
exports.getTk = () => {
  return tk
};
exports.getQQ = () => {
  return qq
};
exports.getCookies = () => {
  return cookieStr
};
exports.setAuthExpired = (value) => {
  authExpired = !!value;
};
exports.isAuthExpired = () => {
  return authExpired;
};
exports.clear = () => {
  cookieStr = "";
  tk = "";
  qq = "";
  authExpired = false;
};
