/* 预览用的本地 ASR 假实现：只在 preview 目录里，不会打进 APK。
   preview.py 的 stage() 会把 preview/* 复制过去覆盖，所以这份文件只影响本地预览。 */
window.ICAOAsr = {
  info: function () {
    return JSON.stringify({
      abi: 'arm64-v8a', cores: 8, totalMb: 11724, availMb: 6421, freeDiskMb: 58200,
      sdk: 35, device: 'vivo iQOO 13', arm64: true, memOk: true, diskOk: true, ok: true,
      reason: '', modelReady: false,
      modelBytes: 402374624, mmprojBytes: 0,
      modelTotal: 804749248, mmprojTotal: 214392480, downloading: false
    });
  },
  download: function () {},
  cancelDownload: function () {},
  deleteModels: function () {},
  transcribe: function () {}
};
