// permessage-deflate must match what the browser negotiates. With perMessageDeflate
// disabled, a proxy (Cloudflare, nginx) can still deliver compressed frames (RSV1 set)
// and the ws library throws "RSV1 must be clear".
function getPerMessageDeflateOption() {
  if (process.env.WS_DISABLE_DEFLATE === '1') {
    return false;
  }

  return {
    threshold: 1024,
    concurrencyLimit: 10,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
  };
}

module.exports = {
  getPerMessageDeflateOption,
};
