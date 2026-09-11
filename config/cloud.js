const environments = {
  develop: 'cloud1-d7g3942n019f2f940',
  trial: 'cloud1-d7g3942n019f2f940',
  release: 'cloud1-d7g3942n019f2f940'
}

const accountInfo = wx.getAccountInfoSync()
const envVersion = accountInfo && accountInfo.miniProgram
  ? accountInfo.miniProgram.envVersion
  : ''
const env = environments[envVersion]

if (!envVersion) {
  throw new Error('无法获取当前小程序版本类型')
}

if (!Object.prototype.hasOwnProperty.call(environments, envVersion)) {
  throw new Error(`不支持的小程序版本类型：${envVersion}`)
}

if (!env || /^YOUR_/.test(env)) {
  throw new Error(`尚未配置 ${envVersion} 版本对应的云环境 ID`)
}

module.exports = {
  env,
  envVersion,
  functionName: 'musicApp'
}
